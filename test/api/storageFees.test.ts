import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/logger.js';
import { NotificationService } from '../../src/services/notifications.js';
import { StorageFeeService } from '../../src/services/storageFees.js';
import { depositBody, dispatchBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

// 11:00 in Lagos on 28 September.
const NOW = new Date('2026-09-28T10:00:00Z');
const clock = () => NOW;
/** 11:00 Lagos time on the given September day. */
const sept = (day: number) => `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`;

function feeService(api: TestApi): StorageFeeService {
  const logger = createLogger('silent');
  return new StorageFeeService(
    api.pool,
    api.config,
    new NotificationService(api.pool, api.sms, logger),
    clock,
  );
}

describe('storage fees API', () => {
  let api: TestApi;
  let fees: StorageFeeService;

  beforeAll(async () => {
    api = await startTestApi({ clock });
    fees = feeService(api);
  });

  afterAll(async () => {
    await api.close();
  });

  const schedule = (body: Record<string, unknown>) =>
    request(api.app)
      .post(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
      .send({
        basis: 'per_bag',
        period: 'day',
        reason: 'Season rates',
        set_by: api.fixtures.ownerId,
        ...body,
      });
  const accruals = async (from: string, to: string) => {
    const { rows } = await api.pool.query<{
      kind: string;
      date: string;
      amount: string;
      rate: string;
    }>(
      `SELECT a.kind, to_char(a.accrual_date, 'YYYY-MM-DD') AS date, a.amount_ngn::text AS amount,
              s.rate_ngn::text AS rate
       FROM storage_fee_accruals a JOIN storage_fee_schedules s ON s.id = a.schedule_id
       WHERE a.accrual_date BETWEEN $1 AND $2 ORDER BY a.created_at, a.accrual_date`,
      [from, to],
    );
    return rows;
  };
  const statement = (query: Record<string, string> = {}) =>
    request(api.app)
      .get(`/farmers/${api.fixtures.farmerId}/statement`)
      .query({ warehouse: api.fixtures.warehouseId, ...query });

  describe('schedules', () => {
    it('adds and lists schedules', async () => {
      const res = await schedule({ rate_ngn: 10, effective_from: '2026-09-01' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        schedule: {
          basis: 'per_bag',
          period: 'day',
          rate_ngn: 10,
          minimum_days: null,
          effective_from: '2026-09-01',
        },
      });
      const list = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
        .expect(200);
      expect((list.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('validates schedules', async () => {
      const res = await schedule({
        basis: 'per_sack',
        rate_ngn: -1,
        effective_from: 'soon',
        reason: ' ',
        commodity: 'RICE',
      });
      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'unsupported_commodity' }),
        expect.objectContaining({ code: 'invalid_basis' }),
        expect.objectContaining({ code: 'invalid_rate' }),
        expect.objectContaining({ code: 'invalid_date' }),
        expect.objectContaining({ code: 'reason_required' }),
      ]);
      await request(api.app)
        .post(`/warehouses/${randomUUID()}/storage-fee-schedules`)
        .send({
          basis: 'per_bag',
          period: 'day',
          rate_ngn: 1,
          effective_from: '2026-09-01',
          reason: 'x',
          set_by: api.fixtures.ownerId,
        })
        .expect(404);
      const duplicate = await schedule({ rate_ngn: 11, effective_from: '2026-09-01' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ error: { code: 'schedule_exists' } });
    });

    it('lets only the warehouse owner change fees: a custodian is refused', async () => {
      const before = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
        .expect(200);
      const res = await schedule({
        rate_ngn: 99,
        effective_from: '2026-09-15',
        set_by: api.fixtures.custodianId,
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'owner_required' } });

      const otherOwner = await schedule({
        rate_ngn: 99,
        effective_from: '2026-09-15',
        set_by: api.fixtures.otherOwnerId,
      });
      expect(otherOwner.status).toBe(400);
      expect((otherOwner.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'owner_wrong_warehouse', field: 'set_by' }),
      ]);

      const after = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
        .expect(200);
      expect(after.body).toEqual(before.body);
    });

    it('records the reason and owner with every schedule', async () => {
      const list = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
        .expect(200);
      expect((list.body as { items: unknown[] }).items).toEqual([
        expect.objectContaining({
          commodity: null,
          reason: 'Season rates',
          set_by: api.fixtures.ownerId,
        }),
      ]);
    });
  });

  describe('accrual', () => {
    it('charges each day held at the rate of the day', async () => {
      await request(api.app)
        .post('/deposits')
        .send(depositBody(api.fixtures, { bag_count: 20, captured_at: sept(22) }))
        .expect(201);
      const run = await fees.runAccrual('2026-09-24');
      expect(run).toMatchObject({ through_date: '2026-09-24', rows_written: 3, amount_ngn: 600 });
    });

    it('applies a rate change from its date without rewriting history', async () => {
      const before = await accruals('2026-09-01', '2026-09-24');

      // A schedule may not start on a day already accrued.
      const reprice = await schedule({ rate_ngn: 20, effective_from: '2026-09-24' });
      expect(reprice.status).toBe(409);
      expect(reprice.body).toMatchObject({
        error: { code: 'schedule_would_reprice', details: { accrued_through: '2026-09-24' } },
      });

      await schedule({ rate_ngn: 20, effective_from: '2026-09-25' }).expect(201);
      const run = await fees.runAccrual('2026-09-27');
      expect(run).toMatchObject({ rows_written: 3, amount_ngn: 1200 });

      // The earlier days keep their rows, at the old rate, unchanged.
      expect(await accruals('2026-09-01', '2026-09-24')).toEqual(before);
      expect(before.map((row) => [row.date, row.rate, row.amount])).toEqual([
        ['2026-09-22', '10.00', '200.0000'],
        ['2026-09-23', '10.00', '200.0000'],
        ['2026-09-24', '10.00', '200.0000'],
      ]);
      expect((await accruals('2026-09-25', '2026-09-27')).map((row) => row.amount)).toEqual([
        '400.0000',
        '400.0000',
        '400.0000',
      ]);
    });

    it('adds corrections for a late offline capture, and nothing on a re-run', async () => {
      await request(api.app)
        .post('/deposits')
        .send(depositBody(api.fixtures, { bag_count: 10, captured_at: sept(23) }))
        .expect(201);
      const run = await fees.runAccrual('2026-09-27');
      expect(run).toMatchObject({ rows_written: 5, amount_ngn: 800 });
      const corrections = (await accruals('2026-09-01', '2026-09-30')).filter(
        (row) => row.kind === 'correction',
      );
      // Each day charged at the rate in force that day.
      expect(corrections.map((row) => [row.date, row.amount])).toEqual([
        ['2026-09-23', '100.0000'],
        ['2026-09-24', '100.0000'],
        ['2026-09-25', '200.0000'],
        ['2026-09-26', '200.0000'],
        ['2026-09-27', '200.0000'],
      ]);

      expect(await fees.runAccrual('2026-09-27')).toMatchObject({ rows_written: 0, amount_ngn: 0 });
    });

    it('refuses to accrue beyond today and defaults to yesterday', async () => {
      await expect(fees.runAccrual('2026-09-29')).rejects.toMatchObject({ status: 400 });
      expect(await fees.runAccrual()).toMatchObject({
        through_date: '2026-09-27',
        rows_written: 0,
      });
    });
  });

  describe('statement and payments', () => {
    it('shows stock, fees and the arithmetic for the whole history', async () => {
      const res = await statement({ to: '2026-09-27' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        farmer: { id: api.fixtures.farmerId, full_name: 'Test Farmer' },
        warehouse: { code: 'KN-DAWANAU' },
        period: { from: '2026-09-22', to: '2026-09-27' },
        accrued_through: '2026-09-27',
        stock: {
          opening: [],
          closing: [{ commodity: 'MAIZE_WHITE', grade: '1', bags: 30, kg: 3000 }],
        },
        fees: {
          opening_outstanding_ngn: 0,
          accrued_ngn: 2600,
          paid_ngn: 0,
          closing_outstanding_ngn: 2600,
          accrued_by_kind: { daily: 1800, correction: 800, minimum_topup: 0 },
          payments: [],
        },
      });
      expect((res.body as { stock: { movements: unknown[] } }).stock.movements).toHaveLength(2);
    });

    it('records payments, refusing overpayment and reused references', async () => {
      const pay = (body: Record<string, unknown>) =>
        request(api.app)
          .post('/fee-payments')
          .send({
            warehouse_id: api.fixtures.warehouseId,
            farmer_id: api.fixtures.farmerId,
            recorded_by: api.fixtures.custodianId,
            method: 'cash',
            paid_on: '2026-09-27',
            reference: 'RCPT-001',
            amount_ngn: 1000,
            ...body,
          });

      const first = await pay({});
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        outstanding_ngn: 1600,
        duplicate: false,
        payment: { amount_ngn: 1000 },
      });

      const repeat = await pay({});
      expect(repeat.status).toBe(200);
      expect(repeat.body).toMatchObject({ duplicate: true, outstanding_ngn: 1600 });

      const reused = await pay({ amount_ngn: 50 });
      expect(reused.status).toBe(409);
      expect(reused.body).toMatchObject({ error: { code: 'payment_reference_conflict' } });

      const over = await pay({ reference: 'RCPT-002', amount_ngn: 1600.01 });
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({
        error: { code: 'payment_exceeds_outstanding', details: { outstanding_ngn: 1600 } },
      });

      const future = await pay({ reference: 'RCPT-003', paid_on: '2026-09-29' });
      expect(future.status).toBe(400);
      expect((future.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'date_in_future' }),
      ]);
    });

    it('carries an opening balance into a later period', async () => {
      const res = await statement({ from: '2026-09-25', to: '2026-09-27' });
      expect(res.body).toMatchObject({
        stock: { opening: [{ bags: 30 }], movements: [], closing: [{ bags: 30 }] },
        fees: {
          opening_outstanding_ngn: 800,
          accrued_ngn: 1800,
          paid_ngn: 1000,
          closing_outstanding_ngn: 1600,
          payments: [expect.objectContaining({ reference: 'RCPT-001' })],
        },
      });
    });

    it('validates statement queries', async () => {
      const noWarehouse = await request(api.app).get(`/farmers/${api.fixtures.farmerId}/statement`);
      expect(noWarehouse.status).toBe(400);
      const backwards = await statement({ from: '2026-09-27', to: '2026-09-01' });
      expect(backwards.status).toBe(400);
      const elsewhere = await statement({ warehouse: api.fixtures.otherWarehouseId });
      expect((elsewhere.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'farmer_not_at_warehouse' }),
      ]);
      await request(api.app)
        .get(`/farmers/${randomUUID()}/statement`)
        .query({ warehouse: api.fixtures.warehouseId })
        .expect(404);
    });

    it('texts the farmer their statement on request', async () => {
      const res = await request(api.app)
        .post(`/farmers/${api.fixtures.farmerId}/statement/notify`)
        .send({ warehouse_id: api.fixtures.warehouseId, requested_by: api.fixtures.custodianId });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        notification: {
          status: 'sent',
          outstanding_ngn: 1600,
          body: 'Farmledge: your storage fees at Dawanau Test Store as of 2026-09-27: NGN 1,600.00 outstanding.',
        },
      });
      expect(api.sms.sent.at(-1)).toEqual({
        to: '+2348000000004',
        body: expect.stringContaining('1,600.00') as string,
      });
    });

    it('lists farmers who owe fees', async () => {
      const res = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/reports/outstanding-fees`)
        .expect(200);
      expect(res.body).toEqual({
        warehouse_id: api.fixtures.warehouseId,
        accrued_through: '2026-09-27',
        farmers: [
          {
            farmer_id: api.fixtures.farmerId,
            full_name: 'Test Farmer',
            phone: '+2348000000004',
            accrued_ngn: 2600,
            paid_ngn: 1000,
            outstanding_ngn: 1600,
          },
        ],
        totals: { accrued_ngn: 2600, paid_ngn: 1000, outstanding_ngn: 1600 },
      });
    });

    it('reverses a payment (owner only), keeping both entries and correcting the balance', async () => {
      const paymentId = (
        await api.pool.query<{ id: string }>(
          `SELECT id FROM fee_payments WHERE reference = 'RCPT-001'`,
        )
      ).rows[0]?.id;
      const reverse = (body: Record<string, unknown>) =>
        request(api.app)
          .post(`/fee-payments/${paymentId}/reverse`)
          .send({ reason: 'Cheque bounced', reversed_by: api.fixtures.ownerId, ...body });

      const custodian = await reverse({ reversed_by: api.fixtures.custodianId });
      expect(custodian.status).toBe(403);
      expect(custodian.body).toMatchObject({ error: { code: 'owner_required' } });
      const noReason = await reverse({ reason: '' });
      expect((noReason.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'reason_required' }),
      ]);

      const res = await reverse({});
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        outstanding_ngn: 2600,
        payment: {
          reference: 'RCPT-001',
          amount_ngn: 1000,
          reversal: {
            reason: 'Cheque bounced',
            reversed_by: api.fixtures.ownerId,
            reversed_at: NOW.toISOString(),
            date: '2026-09-28',
          },
        },
      });
      expect((await reverse({})).body).toMatchObject({
        error: { code: 'payment_already_reversed' },
      });

      // Both entries stay: the payment row and its reversal.
      const rows = await api.pool.query(
        `SELECT p.id FROM fee_payments p JOIN fee_payment_reversals r ON r.payment_id = p.id`,
      );
      expect(rows.rowCount).toBe(1);

      // Through 28 Sept: paid 1 000 then reversed 1 000, so nothing is paid.
      const reversed = await statement({ from: '2026-09-22', to: '2026-09-28' });
      expect(reversed.body).toMatchObject({
        fees: {
          accrued_ngn: 2600,
          paid_ngn: 0,
          closing_outstanding_ngn: 2600,
          payments: [
            {
              reference: 'RCPT-001',
              amount_ngn: 1000,
              reversal: { reason: 'Cheque bounced', date: '2026-09-28' },
            },
          ],
        },
      });
      // A period ending before the reversal still shows the payment as paid then.
      const before = await statement({ from: '2026-09-22', to: '2026-09-27' });
      expect(before.body).toMatchObject({
        fees: { paid_ngn: 1000, closing_outstanding_ngn: 1600 },
      });

      const report = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/reports/outstanding-fees`)
        .expect(200);
      expect(report.body).toMatchObject({ totals: { paid_ngn: 0, outstanding_ngn: 2600 } });

      // The amount can be paid again.
      await request(api.app)
        .post('/fee-payments')
        .send({
          warehouse_id: api.fixtures.warehouseId,
          farmer_id: api.fixtures.farmerId,
          recorded_by: api.fixtures.custodianId,
          method: 'bank_transfer',
          paid_on: '2026-09-28',
          reference: 'TRF-555',
          amount_ngn: 2600,
        })
        .expect(201);
    });
  });
});

describe('storage fees: per-commodity schedules', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi({ clock });
  });

  afterAll(async () => {
    await api.close();
  });

  it('uses a commodity rate where one exists and falls back to the default otherwise', async () => {
    const schedule = (body: Record<string, unknown>) =>
      request(api.app)
        .post(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
        .send({
          basis: 'per_bag',
          period: 'day',
          effective_from: '2026-09-01',
          reason: 'Season rates',
          set_by: api.fixtures.ownerId,
          ...body,
        });
    await schedule({ rate_ngn: 10 }).expect(201);
    await schedule({ rate_ngn: 30, commodity: 'MAIZE_WHITE' }).expect(201);

    for (const commodity of ['MAIZE_WHITE', 'MAIZE_YELLOW']) {
      await request(api.app)
        .post('/deposits')
        .send(depositBody(api.fixtures, { commodity, bag_count: 10, captured_at: sept(26) }))
        .expect(201);
    }
    await feeService(api).runAccrual('2026-09-27');

    const { rows } = await api.pool.query<{ commodity: string; total: string }>(
      `SELECT commodity, sum(amount_ngn)::text AS total FROM storage_fee_accruals
       GROUP BY commodity ORDER BY commodity`,
    );
    // Two days each: white maize at its own 30, yellow at the default 10.
    expect(rows).toEqual([
      { commodity: 'MAIZE_WHITE', total: '600.0000' },
      { commodity: 'MAIZE_YELLOW', total: '200.0000' },
    ]);

    const list = await request(api.app)
      .get(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
      .expect(200);
    expect(
      (list.body as { items: { commodity: string | null }[] }).items.map((item) => item.commodity),
    ).toEqual([null, 'MAIZE_WHITE']);
  });
});

describe('storage fees: minimum period', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi({ clock });
  });

  afterAll(async () => {
    await api.close();
  });

  it('tops up the missing days when bags leave before the minimum period', async () => {
    await request(api.app)
      .post(`/warehouses/${api.fixtures.warehouseId}/storage-fee-schedules`)
      .send({
        basis: 'per_bag',
        period: 'day',
        rate_ngn: 10,
        minimum_days: 30,
        effective_from: '2026-09-01',
        reason: 'Minimum stay of a month',
        set_by: api.fixtures.ownerId,
      })
      .expect(201);
    await request(api.app)
      .post('/deposits')
      .send(depositBody(api.fixtures, { bag_count: 10, captured_at: sept(22) }))
      .expect(201);
    // Four bags leave today (28 Sept), after 6 days of a 30-day minimum.
    await request(api.app)
      .post('/dispatches')
      .send(dispatchBody(api.fixtures, { bag_count: 4 }))
      .expect(201);

    const run = await feeService(api).runAccrual('2026-09-28');
    // Daily: 22-27 Sept at 10 bags (600) + 28 Sept at 6 bags (60). Top-up: 24 days × 4 bags × 10.
    expect(run).toMatchObject({ amount_ngn: 1620 });
    const statement = await request(api.app)
      .get(`/farmers/${api.fixtures.farmerId}/statement`)
      .query({ warehouse: api.fixtures.warehouseId })
      .expect(200);
    expect(statement.body).toMatchObject({
      fees: {
        accrued_by_kind: { daily: 660, correction: 0, minimum_topup: 960 },
        closing_outstanding_ngn: 1620,
      },
    });
  });
});
