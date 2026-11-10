import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cutoffOf } from '../../src/domain/book.js';
import { MINT_MAX_TIME_SECONDS } from '../../src/services/pledges.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY, lotState, pledge, rawLotMovement, sqlError } from './helpers.js';

/**
 * INV-1. Freshness: freeze a lot before minting it. No dispatch of a lot may
 * be recorded between the cutoff of the anchored day its mint uses and the
 * mint's confirmation or definite abandonment. Fail closed; unfreeze only
 * when the mint can no longer land.
 */
describe.each(['stellar', 'near'] as const)('INV-1 freshness: the mint freeze (%s)', (backend) => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY), backend });
    fake = h.chain as FakeChain;
  });
  afterEach(async () => {
    await (h as ChainHarness | undefined)?.close();
  });

  it('refuses to mint when the lot moved after the anchored day’s cutoff (PledgeService freeze check)', async () => {
    const lot = await anchoredLot(h);
    // Day DAY+1, before the next anchor: one bag leaves this lot.
    expect((await h.dispatch({ bag_count: 1, deposit_id: lot.depositId })).status).toBe(201);
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'books_not_anchored' } });
    // The contract alone would have minted the stale balance; nothing reached it.
    expect(fake.receipts.size).toBe(0);
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
  });

  it('refuses a dispatch of a frozen lot, in the dispatch’s own transaction (DispatchService + lot trigger)', async () => {
    const lot = await anchoredLot(h);
    fake.failNextCall('mint_from_anchor', 'timeout');
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(202);
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).not.toBeNull();

    const named = await h.dispatch({ bag_count: 1, deposit_id: lot.depositId });
    expect(named.status).toBe(409);
    expect(named.body).toMatchObject({ error: { code: 'lot_governed_on_chain' } });
    const fifo = await h.dispatch({ bag_count: 1 });
    expect(fifo.status).toBe(409);
    expect(fifo.body).toMatchObject({
      error: { code: 'insufficient_balance', details: { available_bags: 0 } },
    });
    // Fail closed even for a path that skips the service.
    await expect(rawLotMovement(h, lot.depositId, h.clock.now())).rejects.toThrow(/INV-1/);
  });

  it('keeps the freeze while the mint could still land, and lifts it only once max_time has passed unconfirmed', async () => {
    const lot = await anchoredLot(h);
    fake.failNextCall('mint_from_anchor', 'timeout');
    await pledge(h, lot.depositId);

    await h.pledges.resolvePending();
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).not.toBeNull();
    // The database refuses to unfreeze while the mint request is not failed.
    const err = await sqlError(
      h,
      'UPDATE deposits SET frozen_for_mint = NULL WHERE deposit_id = $1',
      [lot.depositId],
    );
    expect(err.message).toMatch(/stays frozen until its mint has definitely failed \(INV-1\)/);

    h.clock.advance((MINT_MAX_TIME_SECONDS + 1) * 1000);
    await h.pledges.resolvePending();
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
    expect((await h.dispatch({ bag_count: 1, deposit_id: lot.depositId })).status).toBe(201);
  });

  it('releases the freeze after a failed mint, in simulation or on-ledger', async () => {
    const lot = await anchoredLot(h);
    fake.failNextCall('mint_from_anchor', 'simulation');
    const refused = await pledge(h, lot.depositId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: { code: 'contract_refused', details: { contract_error: 22 } },
    });
    expect(await lotState(h, lot.depositId)).toMatchObject({
      frozen_for_mint: null,
      status: 'recorded',
    });

    fake.failNextCall('mint_from_anchor', 'ledger');
    const failed = await pledge(h, lot.depositId);
    expect(failed.status).toBe(201);
    expect(failed.body).toMatchObject({ pledge: { status: 'failed' } });
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
    const requests = await h.pool.query<{ status: string }>(
      'SELECT status FROM mint_requests WHERE deposit_id = $1 ORDER BY created_at',
      [lot.depositId],
    );
    expect(requests.rows.map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  it('flags a mint whose leaf was not the latest: the A6 reconciliation', async () => {
    const lot = await anchoredLot(h);
    // A bypassed freeze: a movement recorded after DAY's cutoff, then a
    // mint from DAY's balance leaf (the contract cannot tell).
    const movedAt = new Date(cutoffOf(DAY).getTime() + 3_600_000);
    await rawLotMovement(h, lot.depositId, movedAt);
    const leaf = await h.pool.query<{ leaf_hash: Buffer }>(
      `SELECT leaf_hash FROM book_entries WHERE deposit_id = $1 AND day = $2 AND kind = 2`,
      [lot.depositId, DAY],
    );
    await h.pool.query(
      `INSERT INTO chain_receipts (contract_id, receipt_id, warehouse_symbol, deposit_no, deposit_id,
                                   owner, status, weight_kg, bag_count, initial_weight_kg,
                                   weight_source, anchor_day, leaf_hash, minted_ledger, minted_at,
                                   last_event_ledger)
       VALUES ($1, 9, 'KN_DAWANAU', $2, $3, 'G', 'Active', 1995, 20, 1995, 'Scale', $4, $5, 10, $6, 10)`,
      [
        fake.contractId,
        lot.depositNo,
        lot.depositId,
        DAY,
        leaf.rows[0]?.leaf_hash.toString('hex'),
        Math.floor(movedAt.getTime() / 1000) + 600,
      ],
    );
    const findings = await h.reconciliation.checkMints();
    expect(findings.map((f) => f.check)).toContain('db_movement');
    expect((await h.alerts.open('reconciliation')).map((a) => a.key)).toContain(
      'mint_reconcile:db_movement:9',
    );
  });
});
