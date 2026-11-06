import { afterEach, describe, expect, it } from 'vitest';

import { cutoffOf } from '../../src/domain/book.js';
import {
  archiveWarehouseAdded,
  middayOf,
  startChainHarness,
  type ChainHarness,
} from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { DAY } from './helpers.js';

/**
 * INV-5, D53. A warehouse's chain starts on the day the contract registered
 * it (its warehouse_added, by the contract's clock), not its first movement
 * and not the day its row was created here: otherwise a verifier cannot
 * tell a new warehouse from one that has been operating unrecorded. Idle
 * days are sentinel days.
 */
describe('INV-5 anchor every warehouse from the day the contract registered it', () => {
  let h: ChainHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const start = async (onChain?: Parameters<typeof startChainHarness>[0]['onChain']) => {
    h = await startChainHarness({ start: middayOf(DAY), ...(onChain ? { onChain } : {}) });
    return h;
  };

  const anchored = async (h: ChainHarness, warehouseId: string) =>
    (
      await h.pool.query<{ day: number }>(
        'SELECT day FROM book_anchors WHERE warehouse_id = $1 ORDER BY day',
        [warehouseId],
      )
    ).rows.map((r) => r.day);

  /** Leaf kinds per day (records, which have no kind, left out). */
  const kinds = async (h: ChainHarness, warehouseId: string) =>
    (
      await h.pool.query<{ day: number; kinds: number[] }>(
        `SELECT day, array_agg(DISTINCT kind ORDER BY kind) FILTER (WHERE kind IS NOT NULL) AS kinds
           FROM book_entries WHERE warehouse_id = $1 GROUP BY day ORDER BY day`,
        [warehouseId],
      )
    ).rows;

  const alertKeys = async (h: ChainHarness) => (await h.alerts.open('anchoring')).map((a) => a.key);

  it('anchors a warehouse that has never taken an intake, daily from its registration, with sentinels', async () => {
    const h = await start();
    const idle = h.fixtures.otherWarehouseId;
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.runDaily();
    expect(await anchored(h, idle)).toEqual([DAY, DAY + 1, DAY + 2]);
    expect(await kinds(h, idle)).toEqual([
      { day: DAY, kinds: [3] },
      { day: DAY + 1, kinds: [3] },
      { day: DAY + 2, kinds: [3] },
    ]);
    expect((h.chain as FakeChain).heads.get('KN_BICHI')?.day).toBe(DAY + 2);
  });

  it('starts the chain on the registration day, not the first intake, which comes later', async () => {
    const h = await start();
    h.clock.set(middayOf(DAY + 2));
    await h.scaleLot(5); // the first intake, two days after registration
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.runDaily();
    expect(await anchored(h, h.fixtures.warehouseId)).toEqual([DAY, DAY + 1, DAY + 2]);
    expect(await kinds(h, h.fixtures.warehouseId)).toEqual([
      { day: DAY, kinds: [3] },
      { day: DAY + 1, kinds: [3] },
      { day: DAY + 2, kinds: [0, 2] },
    ]);
  });

  it('contract first, database later: anchors from the contract’s day, the days before the row included', async () => {
    const h = await start();
    const idle = h.fixtures.otherWarehouseId;
    // The row here is created two days after add_warehouse.
    await h.pool.query('UPDATE warehouses SET created_at = $1 WHERE id = $2', [
      middayOf(DAY + 2),
      idle,
    ]);
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.runDaily();
    expect(await anchored(h, idle)).toEqual([DAY, DAY + 1, DAY + 2]);
    expect(await alertKeys(h)).toEqual([]);
  });

  it('database first, contract later: closes nothing until add_warehouse, and pages meanwhile', async () => {
    const h = await start({ otherWarehouseId: null });
    const idle = h.fixtures.otherWarehouseId;
    // Before the first day's cutoff + 2 h: not yet late.
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 3_600_000));
    expect(await h.anchoring.nextDayToClose(idle)).toBeNull();
    await h.anchoring.runDaily();
    expect(await alertKeys(h)).toEqual([]);

    // Late. The archive has never been indexed: whether the contract
    // registered it is unknown, and that pages too.
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 3 * 3_600_000));
    await h.anchoring.checkMissedAnchors();
    expect(await alertKeys(h)).toEqual([`warehouse_registration_unknown:${idle}`]);

    // Indexed, complete and current: the contract has not registered it.
    await h.indexer.ingest();
    await h.anchoring.checkMissedAnchors();
    expect(await alertKeys(h)).toEqual([`warehouse_not_on_contract:${idle}`]);
    expect(await anchored(h, idle)).toEqual([]);

    // add_warehouse lands on DAY + 2: the chain starts there, not on DAY.
    await archiveWarehouseAdded(h.pool, h.chain.contractId, idle, middayOf(DAY + 2));
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.runDaily();
    expect(await anchored(h, idle)).toEqual([DAY + 2]);
    expect(await alertKeys(h)).toEqual([]);
  });

  it('has nothing due before the contract registered a warehouse, nor on that day before its cutoff', async () => {
    const later = middayOf(DAY + 2);
    const h = await start({ warehouseId: later, otherWarehouseId: later });
    h.clock.set(later);
    expect(await h.anchoring.retryIfDue()).toBe(false);
    expect(await h.anchoring.runDaily()).toEqual([]);
    h.clock.set(new Date(cutoffOf(DAY + 2).getTime() + 5 * 60_000));
    expect(await h.anchoring.retryIfDue()).toBe(true);
    expect(await anchored(h, h.fixtures.otherWarehouseId)).toEqual([DAY + 2]);
  });

  it('starts at the first warehouse_added: a removal and re-registration does not restart the chain', async () => {
    const h = await start();
    const idle = h.fixtures.otherWarehouseId;
    // remove_warehouse, then add_warehouse again on DAY + 2: the contract
    // keeps the head, so it is still one chain from DAY.
    await archiveWarehouseAdded(h.pool, h.chain.contractId, idle, middayOf(DAY + 2));
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.runDaily();
    expect(await anchored(h, idle)).toEqual([DAY, DAY + 1, DAY + 2]);
  });

  it('counts only this contract’s warehouse_added, and has nothing due for a warehouse it has not registered', async () => {
    const h = await start({ warehouseId: null, otherWarehouseId: null });
    // Registered on a predecessor contract only.
    await archiveWarehouseAdded(h.pool, 'C_PREDECESSOR', h.fixtures.warehouseId, middayOf(DAY));
    expect(await h.anchoring.nextDayToClose(h.fixtures.warehouseId)).toBeNull();
    h.clock.set(middayOf(DAY + 3));
    expect(await h.anchoring.retryIfDue()).toBe(false);
    expect(await h.anchoring.runDaily()).toEqual([]);
  });

  it('puts movements recorded before add_warehouse into the first anchored day', async () => {
    const h = await start({ warehouseId: null });
    await h.scaleLot(5); // on DAY, before the contract knows the warehouse
    await archiveWarehouseAdded(
      h.pool,
      h.chain.contractId,
      h.fixtures.warehouseId,
      middayOf(DAY + 2),
    );
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.runDaily();
    expect(await anchored(h, h.fixtures.warehouseId)).toEqual([DAY + 2]);
    expect(await kinds(h, h.fixtures.warehouseId)).toEqual([{ day: DAY + 2, kinds: [0, 2] }]);
  });

  it('pages for an idle warehouse whose registration day cannot be anchored', async () => {
    const h = await start();
    const idle = h.fixtures.otherWarehouseId;
    // An idle warehouse with no custodian cannot sign its sentinel day.
    await h.pool.query(`UPDATE custodians SET status = 'suspended' WHERE warehouse_id = $1`, [
      idle,
    ]);
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 3 * 3_600_000));
    const reports = await h.anchoring.runDaily();
    expect(reports.find((r) => r.warehouseId === idle)).toEqual(
      expect.objectContaining({ day: DAY, closed: 'failed', anchored: false }),
    );
    expect(await alertKeys(h)).toContain(`anchor_missed:${idle}:${DAY}`);
  });

  it('does not report days before a pre-D53 chain’s first day as missed: they can no longer be anchored', async () => {
    const h = await start({ warehouseId: middayOf(DAY + 2) });
    const legacy = h.fixtures.warehouseId;
    h.clock.set(middayOf(DAY + 2));
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.runDaily();
    expect(await anchored(h, legacy)).toEqual([DAY + 2]);
    // Books begun at the first movement, before D53, although the contract
    // registered the warehouse earlier.
    await archiveWarehouseAdded(h.pool, h.chain.contractId, legacy, middayOf(DAY));

    h.clock.set(new Date(cutoffOf(DAY + 3).getTime() - 3_600_000));
    await h.anchoring.checkMissedAnchors();
    expect((await alertKeys(h)).filter((k) => k.includes(legacy))).toEqual([]);
    expect(await h.anchoring.nextDayToClose(legacy)).toBe(DAY + 3);
  });
});
