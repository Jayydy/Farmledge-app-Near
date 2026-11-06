import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addDays, businessDate } from '../../src/domain/dates.js';
import { createLogger } from '../../src/logger.js';
import { NotificationService } from '../../src/services/notifications.js';
import { StorageFeeService } from '../../src/services/storageFees.js';
import { depositBody, dispatchBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

const HOUR = 60 * 60 * 1000;
const TZ = 'Africa/Lagos';

describe('deposit cancellation API', () => {
  let api: TestApi;
  let fees: StorageFeeService;
  // Deposits are stamped `created_at` by the database, so the window is
  // measured against real time; the clock moves forward to leave it.
  let now = new Date();
  const clock = () => now;
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString();
  const today = () => businessDate(now, TZ);

  beforeAll(async () => {
    api = await startTestApi({ clock });
    fees = new StorageFeeService(
      api.pool,
      api.config,
      new NotificationService(api.pool, api.sms, createLogger('silent')),
      clock,
    );
    await request(api.app)
      .post(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
      .send({
        basis: 'per_bag',
        period: 'day',
        rate_ngn: 10,
        effective_from: addDays(today(), -30),
        reason: 'Opening rates',
        set_by: api.fixtures.ownerId,
      })
      .expect(201);
  });

  afterAll(async () => {
    await api.close();
  });

  const deposit = async (overrides: Record<string, unknown>) => {
    const body = depositBody(api.fixtures, overrides);
    await request(api.app).post('/deposits').send(body).expect(201);
    return body.deposit_id;
  };
  const cancel = (depositId: string, body: Record<string, unknown>) =>
    request(api.app)
      .post(`/deposits/${depositId}/cancel`)
      .send({
        reason: 'Entered twice by mistake',
        cancelled_by: api.fixtures.custodianId,
        ...body,
      });
  const totalAccrued = async () => {
    const { rows } = await api.pool.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_ngn), 0) AS total FROM storage_fee_accruals WHERE farmer_id = $1`,
      [api.fixtures.farmerId],
    );
    return Number(rows[0]?.total ?? 0);
  };
  const bags = async (grade = '1') => {
    const res = await request(api.app).get(`/farmers/${api.fixtures.farmerId}/balance`).expect(200);
    const items = (res.body as { items: { grade: string; bags: number }[] }).items;
    return items.find((item) => item.grade === grade)?.bags ?? 0;
  };

  it('reverses the exact storage fees the deposit accrued, by contra entries', async () => {
    // Kept: 20 bags held 5 days. Mistake: 10 bags held 4 days.
    await deposit({ bag_count: 20, captured_at: ago(5 * 24) });
    const mistake = await deposit({ bag_count: 10, captured_at: ago(4 * 24) });
    await fees.runAccrual();
    expect(await totalAccrued()).toBe(5 * 20 * 10 + 4 * 10 * 10);

    const res = await cancel(mistake, {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      cancellation: {
        deposit_id: mistake,
        cancelled_by: api.fixtures.custodianId,
        cancelled_by_role: 'custodian',
        reason: 'Entered twice by mistake',
        within_window: true,
        fees_reversed_ngn: -400,
      },
    });
    const cancellationId = (res.body as { cancellation: { id: string } }).cancellation.id;

    // Exactly what the kept deposit alone accrued; nothing deleted.
    expect(await totalAccrued()).toBe(5 * 20 * 10);
    const contra = await api.pool.query<{ kind: string; amount: string }>(
      `SELECT kind, amount_ngn::text AS amount FROM storage_fee_accruals
       WHERE cancellation_id = $1 ORDER BY accrual_date`,
      [cancellationId],
    );
    expect(contra.rows).toEqual(
      Array.from({ length: 4 }, () => ({ kind: 'correction', amount: '-100.0000' })),
    );
    // The original daily charges (one per day on the shared balance) are untouched.
    const daily = await api.pool.query<{ amount: string }>(
      `SELECT amount_ngn::text AS amount FROM storage_fee_accruals
       WHERE run_id IS NOT NULL ORDER BY accrual_date`,
    );
    expect(daily.rows.map((row) => row.amount)).toEqual([
      '200.0000',
      '300.0000',
      '300.0000',
      '300.0000',
      '300.0000',
    ]);

    // Stock: the deposit never happened, from its intake onwards.
    expect(await bags()).toBe(20);
    const ledger = await request(api.app)
      .get('/ledger')
      .query({ kind: 'deposit_void' })
      .expect(200);
    const intake = await api.pool.query<{ intake_at: Date }>(
      'SELECT intake_at FROM deposits WHERE deposit_id = $1',
      [mistake],
    );
    expect((ledger.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        deposit_id: mistake,
        bags_delta: -10,
        occurred_at: intake.rows[0]?.intake_at.toISOString(),
      }),
    ]);

    // The accrual job agrees: nothing left to correct.
    expect(await fees.runAccrual()).toMatchObject({ rows_written: 0 });

    // The statement shows the contra entries.
    const statement = await request(api.app)
      .get(`/farmers/${api.fixtures.farmerId}/statement`)
      .query({ warehouse: api.fixtures.warehouseId })
      .expect(200);
    expect(statement.body).toMatchObject({
      fees: {
        accrued_ngn: 1000,
        accrued_by_kind: { daily: 1400, correction: 0, cancellation_reversal: -400 },
      },
    });
  });

  it('refuses a second cancellation and validates the request', async () => {
    const id = await deposit({ bag_count: 2 });
    await cancel(id, {}).expect(201);
    expect((await cancel(id, {})).body).toMatchObject({
      error: { code: 'deposit_already_cancelled' },
    });

    const other = await deposit({ bag_count: 2 });
    const noReason = await cancel(other, { reason: '  ' });
    expect((noReason.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'reason_required' }),
    ]);
    const stranger = await cancel(other, { cancelled_by: api.fixtures.otherCustodianId });
    expect((stranger.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'owner_wrong_warehouse', field: 'cancelled_by' }),
    ]);
    await cancel(randomUUID(), {}).expect(404);
  });

  it('refuses to cancel grain that has already left: that is a dispatch', async () => {
    const id = await deposit({ grade: 2, bag_count: 5 });
    await request(api.app)
      .post('/dispatches')
      .send(dispatchBody(api.fixtures, { grade: 2, bag_count: 3 }))
      .expect(201);
    const res = await cancel(id, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'deposit_stock_dispatched' } });
    expect(await bags('2')).toBe(2);
  });

  it('after 24 hours, needs the warehouse owner with a reason', async () => {
    const id = await deposit({ grade: 3, bag_count: 4 });
    now = new Date(Date.now() + 25 * HOUR);

    const custodian = await cancel(id, {});
    expect(custodian.status).toBe(403);
    expect(custodian.body).toMatchObject({ error: { code: 'owner_required' } });
    expect(await bags('3')).toBe(4);

    const owner = await cancel(id, {
      cancelled_by: api.fixtures.ownerId,
      reason: 'Custodian recorded the wrong farmer',
    });
    expect(owner.status).toBe(201);
    expect(owner.body).toMatchObject({
      cancellation: {
        cancelled_by: api.fixtures.ownerId,
        cancelled_by_role: 'warehouse_owner',
        within_window: false,
      },
    });
    expect(await bags('3')).toBe(0);
  });

  it('keeps cancellations append-only', async () => {
    await expect(
      api.pool.query('UPDATE deposit_cancellations SET reason = $1', ['x']),
    ).rejects.toThrow(/append-only/);
  });
});
