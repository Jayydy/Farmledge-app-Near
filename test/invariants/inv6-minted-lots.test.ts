import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adjustmentBody } from '../helpers/api.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY, lotState, pledge, rawLotMovement, sqlError } from './helpers.js';

/**
 * INV-6. A minted lot leaves only through `exit`: never dispatched
 * off-chain; alert if its anchored balance ever differs from its receipt.
 * And D33: a minted or pledged lot cannot be adjusted or cancelled
 * off-chain (loss on pledged collateral is a lender matter).
 */
describe('INV-6 / D33 a minted lot is governed on-chain', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  let lot: { depositId: string; depositNo: number };
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
    fake = h.chain as FakeChain;
    lot = await anchoredLot(h);
    expect((await pledge(h, lot.depositId)).status).toBe(201);
    expect(await lotState(h, lot.depositId)).toMatchObject({
      status: 'minted',
      chain_receipt_id: '1',
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('never dispatches a minted lot off-chain (DispatchService, lot trigger)', async () => {
    const named = await h.dispatch({ bag_count: 1, deposit_id: lot.depositId });
    expect(named.status).toBe(409);
    expect(named.body).toMatchObject({ error: { code: 'lot_governed_on_chain' } });
    const fifo = await h.dispatch({ bag_count: 1 });
    expect(fifo.body).toMatchObject({
      error: { code: 'insufficient_balance', details: { available_bags: 0 } },
    });
    await expect(rawLotMovement(h, lot.depositId, h.clock.now())).rejects.toThrow(
      /INV-1, INV-6, D33/,
    );
  });

  it('D33: never adjusts or cancels a minted lot off-chain', async () => {
    const adjust = await request(h.app)
      .post('/adjustments')
      .send(adjustmentBody(h.fixtures, { deposit_id: lot.depositId }));
    expect(adjust.status).toBe(409);
    expect(adjust.body).toMatchObject({ error: { code: 'lot_governed_on_chain' } });
    const cancel = await request(h.app)
      .post(`/deposits/${lot.depositId}/cancel`)
      .send({ cancelled_by: h.fixtures.ownerId, reason: 'mistake' });
    expect(cancel.status).toBe(409);
    expect(cancel.body).toMatchObject({ error: { code: 'deposit_minted' } });
    const raw = await sqlError(
      h,
      `UPDATE deposits SET status = 'cancelled' WHERE deposit_id = $1`,
      [lot.depositId],
    );
    expect(raw.message).toMatch(/minted|INV-6|D33/);
  });

  it('D33: never adjusts or cancels a lot while its mint is pending either', async () => {
    const other = await anchoredLot(h, DAY + 1, 10);
    fake.failNextCall('mint_from_anchor', 'timeout');
    const pending = await pledge(h, other.depositId, { kg: 900 });
    expect(pending.status, JSON.stringify(pending.body)).toBe(202);
    const cancel = await request(h.app)
      .post(`/deposits/${other.depositId}/cancel`)
      .send({ cancelled_by: h.fixtures.ownerId, reason: 'mistake' });
    expect(cancel.body).toMatchObject({ error: { code: 'lot_governed_on_chain' } });
    const raw = await sqlError(
      h,
      `UPDATE deposits SET status = 'cancelled' WHERE deposit_id = $1`,
      [other.depositId],
    );
    expect(raw.message).toMatch(/cannot be cancelled off-chain \(D33\)/);
  });

  it('keeps a minted lot minted and frozen forever (database rule)', async () => {
    const unmint = await sqlError(
      h,
      `UPDATE deposits SET status = 'recorded', frozen_for_mint = NULL WHERE deposit_id = $1`,
      [lot.depositId],
    );
    expect(unmint.message).toMatch(/governed on-chain and leaves only by exit \(INV-6\)/);
  });

  it('marks its balance leaves with the receipt, and pages when an anchored balance differs from the receipt', async () => {
    h.clock.set(middayOf(DAY + 2));
    await h.anchoring.runDaily();
    const leaf = await h.pool.query<{ receipt_id: number; receipt_version: number }>(
      `SELECT (content->>'receipt_id')::int AS receipt_id, (content->>'receipt_version')::int AS receipt_version
         FROM book_entries WHERE deposit_id = $1 AND kind = 2 AND day = $2`,
      [lot.depositId, DAY + 1],
    );
    expect(leaf.rows).toEqual([{ receipt_id: 1, receipt_version: 3 }]);

    // The indexer's view of the receipt says 1 500 kg; the books say 1 995.
    const minted = await h.pool.query<{ leaf_hash: Buffer }>(
      `SELECT leaf_hash FROM book_entries WHERE deposit_id = $1 AND kind = 2 AND day = $2`,
      [lot.depositId, DAY],
    );
    await h.pool.query(
      `INSERT INTO chain_receipts (contract_id, receipt_id, warehouse_symbol, deposit_no, deposit_id, owner,
                                   status, weight_kg, bag_count, initial_weight_kg, weight_source,
                                   anchor_day, leaf_hash, minted_ledger, minted_at, last_event_ledger)
       VALUES ($1, 1, 'KN_DAWANAU', $2, $3, 'G', 'Active', 1500, 20, 1500, 'Scale', $4, $5, 10, $6, 10)`,
      [
        fake.contractId,
        lot.depositNo,
        lot.depositId,
        DAY,
        minted.rows[0]?.leaf_hash.toString('hex'),
        Math.floor(middayOf(DAY + 1).getTime() / 1000),
      ],
    );
    const findings = await h.reconciliation.checkMints();
    expect(findings.map((f) => f.check).sort()).toEqual(['balance_drift', 'forward_balance']);
  });
});
