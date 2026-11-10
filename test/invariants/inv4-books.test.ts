import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkDay, cutoffOf } from '../../src/domain/book.js';
import { foldProof } from '../../src/domain/merkle.js';
import { adjustmentBody } from '../helpers/api.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import { anchoredLot, DAY, rawLotMovement, sqlError } from './helpers.js';

/**
 * INV-4. Complete, honest daily books: every deposit, dispatch and
 * end-of-day balance is a leaf, each with a fresh salt; leaves, salts and
 * proofs are persisted before anything is delivered. Adjustments and
 * cancellations are book records committed in the same tree (D32).
 */
describe('INV-4 complete, honest daily books', () => {
  let h: ChainHarness;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
  });
  afterEach(async () => {
    await (h as ChainHarness | undefined)?.close();
  });

  it('puts every deposit, dispatch, adjustment and balance in the day’s tree, each provable to its root', async () => {
    const a = await h.scaleLot(20);
    await h.scaleLot(10);
    expect((await h.dispatch({ bag_count: 3, deposit_id: a.depositId })).status).toBe(201);
    await request(h.app)
      .post('/adjustments')
      .send(adjustmentBody(h.fixtures, { deposit_id: a.depositId }))
      .expect(201);
    h.clock.set(middayOf(DAY + 1));
    const closed = await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    // 2 deposits, 1 dispatch, 2 reweigh records, 1 adjustment record, 2 balances.
    expect(closed.leaves).toBe(8);
    const entries = await h.pool.query<{
      kind: number | null;
      record_kind: string | null;
      leaf_hash: Buffer;
      idx: number;
      proof: string[];
    }>(
      `SELECT kind, record_kind, leaf_hash, idx, proof FROM book_entries WHERE day = $1 ORDER BY idx`,
      [DAY],
    );
    expect(entries.rows.map((e) => e.kind ?? e.record_kind)).toEqual([
      0,
      0,
      1,
      2,
      2,
      'adjustment',
      'adjustment',
      'adjustment',
    ]);
    for (const e of entries.rows) {
      const proof = e.proof.map((p) => Buffer.from(p, 'hex'));
      expect(foldProof(e.leaf_hash, e.idx, proof).equals(closed.root)).toBe(true);
    }
  });

  it('gives every entry its own fresh salt, never reused (database rule)', async () => {
    await h.scaleLot(5);
    await h.scaleLot(5);
    const salts = await h.pool.query<{ salt: Buffer }>('SELECT salt FROM book_entries');
    expect(new Set(salts.rows.map((r) => r.salt.toString('hex'))).size).toBe(salts.rows.length);
    const err = await sqlError(
      h,
      `INSERT INTO book_entries (warehouse_id, entry_type, kind, deposit_id, deposit_no, farmer_id, content,
                                 salt, recorded_at)
       SELECT warehouse_id, entry_type, 2, deposit_id, deposit_no, farmer_id, content, salt, recorded_at
         FROM book_entries LIMIT 1`,
    );
    expect(err.message).toMatch(/book_entries_salt_key|duplicate key/);
  });

  it('orders tied records by the source id each one commits to, as bytes (protocol #8)', async () => {
    const a = await h.scaleLot(20);
    // Same lot, same second: only the source id can order them. Recorded in reverse.
    const ids = ['cccccccc', 'bbbbbbbb', 'aaaaaaaa'].map((p) => `${p}-0000-4000-8000-000000000000`);
    for (const id of ids) {
      await request(h.app)
        .post('/adjustments')
        .send(adjustmentBody(h.fixtures, { adjustment_id: id, deposit_id: a.depositId }))
        .expect(201);
    }
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    const { rows } = await h.pool.query<{ source_id: string }>(
      `SELECT content->>'source_id' AS source_id FROM book_entries
        WHERE day = $1 AND record_kind = 'adjustment' AND content->>'reason' = 'spoilage'
        ORDER BY idx`,
      [DAY],
    );
    expect(rows.map((r) => r.source_id)).toEqual([...ids].reverse());
  });

  it('refuses a day whose balances do not follow from yesterday’s plus today’s entries (checkDay)', () => {
    const problems = checkDay({
      previous: new Map([[1, { bags: 20, kg: 2000 }]]),
      lastDepositNo: 1,
      movements: [{ depositNo: 1, isDeposit: false, bagsDelta: -3, kgDelta: -300 }],
      balances: new Map([[1, { bags: 20, kg: 2000 }]]),
      sentinels: 0,
      entries: 2,
    });
    expect(problems).toEqual([
      "INV-4: lot 1 should hold 17 bags / 1700 kg from yesterday's balance and today's entries, but its balance leaf says 20 bags / 2000 kg",
    ]);
  });

  it('records nothing into a closed day, and never rewrites or deletes an entry (database rules)', async () => {
    const lot = await anchoredLot(h);
    await expect(
      rawLotMovement(h, lot.depositId, new Date(cutoffOf(DAY).getTime() - 1000)),
    ).rejects.toThrow(/is closed; record at or after its cutoff \(INV-4\)/);
    const rewrite = await sqlError(
      h,
      `UPDATE book_entries SET content = '{}'::jsonb WHERE day = $1`,
      [DAY],
    );
    expect(rewrite.message).toMatch(/immutable once written and once placed \(INV-4\)/);
    const move = await sqlError(h, 'UPDATE book_entries SET idx = idx + 100 WHERE day = $1', [DAY]);
    expect(move.message).toMatch(/immutable/);
    const del = await sqlError(h, 'DELETE FROM book_entries');
    expect(del.message).toMatch(/never deleted \(INV-4\)/);
    const tree = await sqlError(h, `UPDATE book_days SET root = '\\x00'::bytea`);
    expect(tree.message).toMatch(/append-only/);
  });

  it('delivers nothing for a day until its leaves, salts and proofs are persisted and it is anchored', async () => {
    await h.scaleLot(5);
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.closeDay(h.fixtures.warehouseId, DAY);
    // Closed, not anchored: no bundle exists yet.
    expect(await h.proofs.deliverAnchored()).toBe(0);
    await h.anchoring.anchorDay(h.fixtures.warehouseId, DAY);
    expect(await h.proofs.deliverAnchored()).toBe(1);
  });
});
