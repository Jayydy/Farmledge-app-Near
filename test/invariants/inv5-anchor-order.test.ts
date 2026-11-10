import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContractCallError, ContractError } from '../../src/chain/chainClient.js';
import { checkDay, cutoffOf, unixSeconds } from '../../src/domain/book.js';
import { ZERO_HEAD, type LeafJson } from '../../src/domain/merkle.js';
import { subjectOf } from '../../src/chain/addresses.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { DAY, sqlError } from './helpers.js';

/**
 * INV-5. Anchor every warehouse daily, in order, never skipping a day. A
 * missed anchor is an urgent page: until it lands nothing in that
 * warehouse can mint.
 */
describe('INV-5 anchor daily, in order, never skipping', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    // The contract registers the other warehouse later: only the lot's
    // warehouse is due, so injected failures hit its anchor.
    h = await startChainHarness({
      start: middayOf(DAY),
      onChain: { otherWarehouseId: middayOf(DAY + 30) },
    });
    fake = h.chain as FakeChain;
  });
  afterEach(async () => {
    await (h as ChainHarness | undefined)?.close();
  });

  it('closes days strictly in order and refuses to skip one (service and database)', async () => {
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    await expect(h.anchoring.closeDay(h.fixtures.warehouseId, DAY + 2)).rejects.toThrow(/INV-5/);
    const err = await sqlError(
      h,
      `INSERT INTO book_days (warehouse_id, day, status, leaves, root, built_at)
       VALUES ($1, $2, 'built', 1, $3, now())`,
      [h.fixtures.warehouseId, DAY + 2, Buffer.alloc(32)],
    );
    expect(err.message).toMatch(/must close day \d+ next, not \d+ \(INV-5: never skip a day\)/);
  });

  it('anchors a day with no entries with one sentinel leaf, signed by the custodian it names, that can never mint (protocol #7)', async () => {
    h.clock.set(middayOf(DAY + 1));
    const closed = await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    expect(closed).toMatchObject({ leaves: 1, sentinel: true });
    await h.anchoring.anchorDay(h.fixtures.warehouseId, DAY);

    const { rows } = await h.pool.query<{
      content: Omit<LeafJson, 'day' | 'index' | 'salt'>;
      deposit_id: string | null;
      farmer_id: string | null;
      idx: number;
      salt: Buffer;
      proof: string[];
    }>('SELECT content, deposit_id, farmer_id, idx, salt, proof FROM book_entries WHERE day = $1', [
      DAY,
    ]);
    expect(rows).toHaveLength(1);
    const [entry] = rows;
    const signer = fake.signedFor.find((s) => s.method === 'anchor')?.subject ?? '';
    const custodian = await fake.addressOf(signer);
    expect(signer).toBe(subjectOf.custodian(h.fixtures.custodianId));
    const cutoff = unixSeconds(cutoffOf(DAY));
    expect(entry?.content).toEqual({
      version: 1,
      kind: 3,
      warehouse_id: 'KN_DAWANAU',
      deposit_no: 0,
      deposit_id: '',
      receipt_id: 0,
      receipt_version: 0,
      owner: custodian,
      commodity: 'NONE',
      grade: 'NONE',
      kg: 0,
      weight_source: 'BagEstimate',
      bags: 0,
      moisture_bps: 0,
      custodian,
      verifier: custodian,
      deposited_at: cutoff,
      at: cutoff,
    });
    expect([entry?.deposit_id, entry?.farmer_id, entry?.idx]).toEqual([null, null, 0]);

    const leaf = {
      ...(entry?.content as LeafJson),
      day: DAY,
      index: 0,
      salt: entry?.salt.toString('hex') ?? '',
    };
    const minted = await fake
      .mintFromAnchor(h.pool, {
        custodianSubject: signer,
        verifierSubject: subjectOf.verifier(h.fixtures.verifierId),
        leaf,
        proof: [],
        subject: 'mint:sentinel',
        maxTimeSeconds: 300,
        notAfter: unixSeconds(h.clock.now()) + 300,
      })
      .catch((err: unknown) => err);
    expect(minted).toBeInstanceOf(ContractCallError);
    expect((minted as ContractCallError).contractError).toBe(ContractError.WrongLeafKind);
  });

  it('has the anchor of a sentinel day signed by the custodian the sentinel names, even if another is preferred by then', async () => {
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY); // names the only custodian
    const other = await h.pool.query<{ id: string }>(
      `INSERT INTO custodians (warehouse_id, full_name, phone)
       VALUES ($1, 'Second Custodian', '+2348000000009') RETURNING id`,
      [h.fixtures.warehouseId],
    );
    const otherId = other.rows[0]?.id ?? '';
    // The second custodian is now the registered one: the default choice for an anchor.
    await h.pool.query(
      `INSERT INTO chain_registry (contract_id, role, warehouse_symbol, address, active, last_event_ledger)
       VALUES ($1, 'custodian', 'KN_DAWANAU', $2, true, 1)`,
      [fake.contractId, await fake.addressOf(subjectOf.custodian(otherId))],
    );
    await h.anchoring.anchorDay(h.fixtures.warehouseId, DAY);
    expect(fake.signedFor.filter((s) => s.method === 'anchor')).toEqual([
      { method: 'anchor', subject: subjectOf.custodian(h.fixtures.custodianId) },
    ]);
  });

  it('never closes a day as skipped, and allows a sentinel only as a day’s sole entry (database rule, checkDay)', async () => {
    const empty = await sqlError(
      h,
      `INSERT INTO book_days (warehouse_id, day, status, built_at) VALUES ($1, $2, 'empty', now())`,
      [h.fixtures.warehouseId, DAY],
    );
    expect(empty.message).toMatch(/anchor it with a sentinel leaf, never skip it \(INV-5\)/);
    const base = { previous: new Map(), movements: [], balances: new Map(), lastDepositNo: 0 };
    expect(checkDay({ ...base, sentinels: 0, entries: 0 })).toEqual([
      'INV-5: the day has no entries; an empty day needs one sentinel leaf',
    ]);
    expect(checkDay({ ...base, sentinels: 1, entries: 1 })).toEqual([]);
    expect(checkDay({ ...base, sentinels: 1, entries: 2 })).toEqual([
      'INV-4: a sentinel leaf must be the only entry of its day; found 1 sentinel(s) among 2 entries',
    ]);
  });

  it('anchors on each contract strictly in order, each head chained on the last (database rule)', async () => {
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    h.clock.set(middayOf(DAY + 2));
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 3));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY + 1);
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY + 2);
    // Anchoring DAY+1 before DAY is a skip.
    const skip = await sqlError(
      h,
      `INSERT INTO book_anchors (contract_id, warehouse_id, day, prev_head, head, anchored_ledger, anchored_at)
       VALUES ($1, $2, $3, $4, $4, 1, now())`,
      [fake.contractId, h.fixtures.warehouseId, DAY + 2, ZERO_HEAD],
    );
    expect(skip.message).toMatch(/not anchored on .* yet \(INV-5: never skip\)/);
    const runs = await h.anchoring.runWarehouse(h.fixtures.warehouseId);
    // DAY+1 has a tree too (the lot's balance leaf): it is anchored in turn.
    expect(runs.map((r) => [r.day, r.anchored])).toEqual([
      [DAY, true],
      [DAY + 1, true],
      [DAY + 2, true],
    ]);
  });

  it('stops anchoring, and pages urgently, when the contract’s head is not ours', async () => {
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    fake.heads.set('KN_DAWANAU', { day: DAY - 5, head: Buffer.alloc(32, 7) });
    await expect(h.anchoring.anchorDay(h.fixtures.warehouseId, DAY)).rejects.toThrow(
      /head mismatch/,
    );
    expect(await h.alerts.open('anchoring')).toEqual([
      { key: `anchor_head_mismatch:${h.fixtures.warehouseId}`, severity: 'urgent' },
    ]);
  });

  it('is urgent 2 h after a missed cutoff, escalates separately at 24 h, and alerts urgently after 7 days without an anchor', async () => {
    await h.scaleLot(5);
    const key = `anchor_missed:${h.fixtures.warehouseId}:${DAY}`;
    fake.failNextCall('anchor', 'simulation');
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 3 * 3_600_000));
    await h.anchoring.runDaily();
    expect(await h.alerts.open('anchoring')).toContainEqual({ key, severity: 'urgent' });
    const escalated = `anchor_missed_escalated:${h.fixtures.warehouseId}:${DAY}`;
    expect((await h.alerts.open('anchoring')).map((a) => a.key)).not.toContain(escalated);

    fake.failNextCall('anchor', 'simulation');
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 25 * 3_600_000));
    await h.anchoring.runDaily();
    expect(await h.alerts.open('anchoring')).toContainEqual({ key: escalated, severity: 'urgent' });

    fake.instanceGone = false;
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 8 * 86_400_000));
    await h.anchoring.checkMissedAnchors();
    expect(await h.alerts.open('anchoring')).toContainEqual({
      key: `no_anchor_7d:${h.fixtures.warehouseId}`,
      severity: 'urgent',
    });

    // Once anchored, the missed-anchor alerts clear.
    await h.anchoring.runDaily();
    expect((await h.alerts.open('anchoring')).map((a) => a.key)).not.toContain(key);
    expect((await h.alerts.open('anchoring')).map((a) => a.key)).not.toContain(escalated);
  });

  it('refuses to anchor a day again, or one not after the last anchored day (database rule)', async () => {
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 2));
    await h.anchoring.runWarehouse(h.fixtures.warehouseId); // anchors DAY and DAY+1
    const again = await sqlError(
      h,
      `INSERT INTO book_anchors (contract_id, warehouse_id, day, prev_head, head, anchored_ledger, anchored_at)
       VALUES ($1, $2, $3, $4, $4, 1, now())`,
      [fake.contractId, h.fixtures.warehouseId, DAY, ZERO_HEAD],
    );
    expect(again.message).toMatch(/is not after the last anchored day .* \(INV-5\)/);
  });

  it('refuses an anchor whose prev_head is not the last anchored head (database rule)', async () => {
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.runWarehouse(h.fixtures.warehouseId); // anchors DAY
    h.clock.set(middayOf(DAY + 2));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY + 1); // built, not anchored
    const broken = await sqlError(
      h,
      `INSERT INTO book_anchors (contract_id, warehouse_id, day, prev_head, head, anchored_ledger, anchored_at)
       VALUES ($1, $2, $3, $4, $4, 1, now())`,
      [fake.contractId, h.fixtures.warehouseId, DAY + 1, Buffer.alloc(32, 9)],
    );
    expect(broken.message).toMatch(/does not chain on the previous head \(INV-5\)/);
  });

  it('records a day as anchored only once get_anchor returns the head computed here', async () => {
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    fake.tamperHeadAfterAnchor = true;

    await expect(h.anchoring.anchorDay(h.fixtures.warehouseId, DAY)).rejects.toThrow(
      /get_anchor disagrees/,
    );
    const anchored = await h.pool.query('SELECT 1 FROM book_anchors WHERE day = $1', [DAY]);
    expect(anchored.rowCount).toBe(0);
    expect(await h.alerts.open('anchoring')).toEqual([
      { key: `anchor_head_mismatch:${h.fixtures.warehouseId}`, severity: 'urgent' },
    ]);
  });
});
