import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkDay } from '../../src/domain/book.js';
import { BookCheckError } from '../../src/services/anchoring.js';
import { depositBody } from '../helpers/api.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import { DAY, sqlError } from './helpers.js';

/**
 * INV-3. One lot, one deposit number, forever: assigned once at intake,
 * never reused or reassigned; contiguous, one deposit leaf per new number.
 */
describe('INV-3 one lot, one deposit number', () => {
  let h: ChainHarness;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
  });
  afterEach(async () => {
    await h.close();
  });

  const numbers = async () =>
    (
      await h.pool.query<{ deposit_no: string }>(
        'SELECT deposit_no FROM deposits WHERE warehouse_id = $1 ORDER BY deposit_no',
        [h.fixtures.warehouseId],
      )
    ).rows.map((r) => Number(r.deposit_no));

  it('assigns contiguous numbers per warehouse in the intake transaction; a rolled-back intake uses none', async () => {
    await request(h.app).post('/deposits').send(depositBody(h.fixtures)).expect(201);
    // An intake that fails after its insert rolls its number back with it.
    const client = await h.pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO deposits (deposit_id, farmer_id, warehouse_id, custodian_id, verifier_id, commodity,
                             grading_scheme, grade, moisture_bps, bag_count, bag_size_kg,
                             weight_source, intake_at)
       VALUES ($1, $2, $3, $4, $5, 'MAIZE_WHITE', 'provisional', '1', 1250, 5, 100, 'scale', now())`,
      [
        randomUUID(),
        h.fixtures.farmerId,
        h.fixtures.warehouseId,
        h.fixtures.custodianId,
        h.fixtures.verifierId,
      ],
    );
    await client.query('ROLLBACK');
    client.release();
    await request(h.app).post('/deposits').send(depositBody(h.fixtures)).expect(201);
    expect(await numbers()).toEqual([1, 2]);
  });

  it('never takes a number from the caller, and never changes one', async () => {
    const supplied = await sqlError(
      h,
      `INSERT INTO deposits (deposit_id, deposit_no, farmer_id, warehouse_id, custodian_id, verifier_id,
                             commodity, grading_scheme, grade, moisture_bps, bag_count, bag_size_kg,
                             weight_source, intake_at)
       VALUES ($1, 99, $2, $3, $4, $5, 'MAIZE_WHITE', 'provisional', '1', 1250, 5, 100, 'scale', now())`,
      [
        randomUUID(),
        h.fixtures.farmerId,
        h.fixtures.warehouseId,
        h.fixtures.custodianId,
        h.fixtures.verifierId,
      ],
    );
    expect(supplied.message).toMatch(/assigned by the database, never supplied \(INV-3\)/);

    const body = depositBody(h.fixtures);
    await request(h.app).post('/deposits').send(body).expect(201);
    const changed = await sqlError(
      h,
      'UPDATE deposits SET deposit_no = deposit_no + 5 WHERE deposit_id = $1',
      [body.deposit_id],
    );
    expect(changed.message).toMatch(/keeps its number .* forever \(INV-3\)/);
    const counter = await sqlError(h, 'UPDATE warehouse_deposit_numbers SET last_value = 1');
    expect(counter.message).toMatch(/never reused or skipped \(INV-3\)/);
  });

  it('refuses a day whose deposit leaves skip a number (checkDay)', () => {
    const problems = checkDay({
      previous: new Map(),
      lastDepositNo: 4,
      movements: [
        { depositNo: 5, isDeposit: true, bagsDelta: 1, kgDelta: 100 },
        { depositNo: 7, isDeposit: true, bagsDelta: 1, kgDelta: 100 },
      ],
      balances: new Map([
        [5, { bags: 1, kg: 100 }],
        [7, { bags: 1, kg: 100 }],
      ]),
      sentinels: 0,
      entries: 4,
    });
    expect(problems).toEqual([
      'INV-3: deposit leaves must number 5..6 contiguously; found 7 where 6 belongs',
    ]);
  });

  it('will not close (or anchor) a day missing a deposit leaf, and pages', async () => {
    await request(h.app).post('/deposits').send(depositBody(h.fixtures)).expect(201);
    // A number taken by a deposit that never reached the books.
    await h.pool.query(
      `INSERT INTO deposits (deposit_id, farmer_id, warehouse_id, custodian_id, verifier_id, commodity,
                             grading_scheme, grade, moisture_bps, bag_count, bag_size_kg,
                             weight_source, intake_at, status)
       VALUES ($1, $2, $3, $4, $5, 'MAIZE_WHITE', 'provisional', '1', 1250, 5, 100, 'scale', now(),
               'rejected')`,
      [
        randomUUID(),
        h.fixtures.farmerId,
        h.fixtures.warehouseId,
        h.fixtures.custodianId,
        h.fixtures.verifierId,
      ],
    );
    await request(h.app).post('/deposits').send(depositBody(h.fixtures)).expect(201);
    h.clock.set(middayOf(DAY + 1));
    await expect(h.anchoring.closeDay(h.fixtures.warehouseId, DAY)).rejects.toBeInstanceOf(
      BookCheckError,
    );
    expect((await h.alerts.open('anchoring')).map((a) => a.key)).toEqual([
      `book_check_failed:${h.fixtures.warehouseId}:${DAY}`,
    ]);
    const closed = await h.pool.query('SELECT 1 FROM book_days');
    expect(closed.rowCount).toBe(0);
  });
});
