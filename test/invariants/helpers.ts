import { Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';

import { utcDay } from '../../src/domain/book.js';
import { middayOf, type ChainHarness } from '../helpers/chainHarness.js';

export const DAY = utcDay(new Date('2026-10-01T00:00:00Z'));

export function pledgeBody(
  h: ChainHarness,
  depositId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    deposit_id: depositId,
    lender: Keypair.random().publicKey(),
    kg: 1000,
    loan_ref: 'LOAN-0001',
    due_date: new Date(h.clock.now().getTime() + 90 * 86_400_000).toISOString(),
    grace_period_seconds: 86_400,
    requested_by: h.fixtures.custodianId,
    verifier_id: h.fixtures.verifierId,
    farmer_confirmed: true,
    ...overrides,
  };
}

export function pledge(
  h: ChainHarness,
  depositId: string,
  overrides: Record<string, unknown> = {},
) {
  return request(h.app)
    .post('/pledges')
    .send(pledgeBody(h, depositId, overrides));
}

/** A fully weighed lot recorded on `day`, with that day closed and anchored. */
export async function anchoredLot(h: ChainHarness, day = DAY, bags = 20) {
  h.clock.set(middayOf(day));
  const lot = await h.scaleLot(bags);
  h.clock.set(middayOf(day + 1));
  const reports = await h.anchoring.runDaily();
  const failed = reports.filter((r) => r.day === day && !r.anchored);
  if (failed.length > 0) throw new Error(`day ${day} not anchored: ${JSON.stringify(failed)}`);
  // As the 5-minute index job does: the pre-claim gate needs a covering archive (INV-2).
  await h.indexer.ingest();
  return lot;
}

export async function lotState(h: ChainHarness, depositId: string) {
  const { rows } = await h.pool.query<{
    frozen_for_mint: string | null;
    status: string;
    chain_receipt_id: string | null;
  }>('SELECT frozen_for_mint, status, chain_receipt_id FROM deposits WHERE deposit_id = $1', [
    depositId,
  ]);
  return rows[0];
}

/** Error from running SQL that a database rule must refuse. */
export async function sqlError(
  h: ChainHarness,
  sql: string,
  params: unknown[] = [],
): Promise<Error & { constraint?: string }> {
  try {
    await h.pool.query(sql, params);
  } catch (err) {
    return err as Error & { constraint?: string };
  }
  throw new Error(`expected the database to refuse: ${sql}`);
}

/** A stock movement recorded directly, bypassing every service check. */
export async function rawLotMovement(
  h: ChainHarness,
  depositId: string,
  recordedAt: Date,
): Promise<void> {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('farmledge.recorded_at', $1, true)`, [
      recordedAt.toISOString(),
    ]);
    const adj = await client.query<{ id: string }>(
      `INSERT INTO stock_adjustments (id, warehouse_id, farmer_id, commodity, grading_scheme, grade,
                                      bags_delta, kg_delta, reason_code, notes, recorded_by,
                                      authorised_by)
       SELECT gen_random_uuid(), warehouse_id, farmer_id, commodity, grading_scheme, grade, -1, -100,
              'spoilage', 'raw', custodian_id, verifier_id FROM deposits WHERE deposit_id = $1
       RETURNING id`,
      [depositId],
    );
    const sm = await client.query<{ id: string }>(
      `INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme, grade,
                                    bags_delta, kg_delta, occurred_at, adjustment_id)
       SELECT 'adjustment', warehouse_id, farmer_id, commodity, grading_scheme, grade, -1, -100, $2, $3
         FROM deposits WHERE deposit_id = $1 RETURNING id`,
      [depositId, recordedAt, adj.rows[0]?.id],
    );
    await client.query(
      `INSERT INTO lot_movements (deposit_id, stock_movement_id, bags_delta, kg_delta, book_kg_delta,
                                  recorded_at)
       VALUES ($1, $2, -1, -100, -100, $3)`,
      [depositId, sm.rows[0]?.id, recordedAt],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
