import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adjustmentBody, depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface MovementBody {
  kind: string;
  bags_delta: number;
  kg_delta: number;
  occurred_at: string;
  deposit_id: string | null;
}

const NOW = new Date('2026-09-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('stock ledger API', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi({ clock: () => NOW });
  });

  afterAll(async () => {
    await api.close();
  });

  const deposit = (overrides: Record<string, unknown>) =>
    request(api.app).post('/deposits').send(depositBody(api.fixtures, overrides)).expect(201);
  const balance = async (grade = '1') => {
    const res = await request(api.app)
      .get(`/farmers/${api.fixtures.farmerId}/balance`)
      .query({ warehouse: api.fixtures.warehouseId })
      .expect(200);
    const items = (res.body as { items: { grade: string; bags: number; kg: number }[] }).items;
    return items.find((item) => item.grade === grade) ?? { bags: 0, kg: 0 };
  };

  describe('balances', () => {
    it('derives balances from deposits, including offline captures that arrive late', async () => {
      await deposit({ bag_count: 20, captured_at: daysAgo(1) });
      // Captured earlier, submitted later: lands on its capture time.
      const late = depositBody(api.fixtures, { bag_count: 10, captured_at: daysAgo(3) });
      await request(api.app).post('/deposits').send(late).expect(201);

      expect(await balance()).toMatchObject({ bags: 30, kg: 3000 });

      const ledger = await request(api.app)
        .get('/ledger')
        .query({ farmer: api.fixtures.farmerId, kind: 'deposit_in' })
        .expect(200);
      const items = (ledger.body as { items: MovementBody[] }).items;
      // Newest first by when it happened, so the late capture comes last.
      expect(items.map((item) => item.bags_delta)).toEqual([20, 10]);
      expect(items[1]).toMatchObject({ deposit_id: late.deposit_id, occurred_at: daysAgo(3) });
    });

    it('reverses a deposit that is cancelled', async () => {
      const body = depositBody(api.fixtures, { grade: 3, bag_count: 4 });
      await request(api.app).post('/deposits').send(body).expect(201);
      expect(await balance('3')).toMatchObject({ bags: 4 });
      await api.pool.query(`UPDATE deposits SET status = 'cancelled' WHERE deposit_id = $1`, [
        body.deposit_id,
      ]);
      expect(await balance('3')).toMatchObject({ bags: 0 });

      const ledger = await request(api.app)
        .get('/ledger')
        .query({ warehouse: api.fixtures.warehouseId, kind: 'deposit_void' })
        .expect(200);
      expect((ledger.body as { items: MovementBody[] }).items).toEqual([
        expect.objectContaining({ deposit_id: body.deposit_id, bags_delta: -4, kg_delta: -400 }),
      ]);
    });

    it('404s for an unknown farmer', async () => {
      await request(api.app).get(`/farmers/${randomUUID()}/balance`).expect(404);
    });
  });

  describe('POST /adjustments', () => {
    it('records an adjustment with reason and authoriser, and applies it to the balance', async () => {
      const before = await balance();
      const body = adjustmentBody(api.fixtures, { bags_delta: -1, kg_delta: -87.35 });
      const res = await request(api.app).post('/adjustments').send(body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        duplicate: false,
        adjustment: {
          adjustment_id: body.adjustment_id,
          reason_code: 'spoilage',
          notes: 'Rat damage in bay 3',
          recorded_by: api.fixtures.custodianId,
          authorised_by: api.fixtures.verifierId,
          bags_delta: -1,
          kg_delta: -87.35,
        },
      });
      expect(await balance()).toEqual({
        ...before,
        bags: before.bags - 1,
        kg: Math.round((before.kg - 87.35) * 100) / 100,
        free_bags: before.bags - 1,
        free_kg: Math.round((before.kg - 87.35) * 100) / 100,
      });
    });

    it('is idempotent on adjustment_id and refuses a reused id with different content', async () => {
      const body = adjustmentBody(api.fixtures, {
        bags_delta: 1,
        kg_delta: 100,
        reason_code: 'audit_correction',
      });
      await request(api.app).post('/adjustments').send(body).expect(201);
      const before = await balance();
      const repeat = await request(api.app).post('/adjustments').send(body);
      expect(repeat.status).toBe(200);
      expect(repeat.body).toMatchObject({ duplicate: true });
      expect(await balance()).toEqual(before);

      const conflict = await request(api.app)
        .post('/adjustments')
        .send({ ...body, bags_delta: 2 });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({
        error: { code: 'adjustment_id_conflict', details: { differing_fields: ['bags_delta'] } },
      });
    });

    it('never lets a balance go negative', async () => {
      const { bags } = await balance();
      const res = await request(api.app)
        .post('/adjustments')
        .send(adjustmentBody(api.fixtures, { bags_delta: -(bags + 1), kg_delta: 0 }));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: { code: 'insufficient_balance', details: { available_bags: bags } },
      });
    });

    it('validates the body and the people named', async () => {
      const res = await request(api.app)
        .post('/adjustments')
        .send(
          adjustmentBody(api.fixtures, {
            bags_delta: 0,
            kg_delta: 0,
            reason_code: 'scale_reweigh',
            recorded_by: api.fixtures.otherCustodianId,
          }),
        );
      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'empty_adjustment' }),
        expect.objectContaining({ code: 'invalid_reason' }),
      ]);

      const people = await request(api.app)
        .post('/adjustments')
        .send(
          adjustmentBody(api.fixtures, {
            recorded_by: api.fixtures.otherCustodianId,
            authorised_by: api.fixtures.custodianId,
          }),
        );
      expect(people.status).toBe(400);
      expect((people.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'custodian_wrong_warehouse', field: 'recorded_by' }),
        expect.objectContaining({ code: 'verifier_not_found', field: 'authorised_by' }),
      ]);
    });
  });

  describe('GET /ledger', () => {
    it('filters by date in the business time zone and paginates', async () => {
      const day = new Date(Date.parse(daysAgo(3))).toISOString().slice(0, 10);
      const onDay = await request(api.app)
        .get('/ledger')
        .query({ farmer: api.fixtures.farmerId, from: day, to: day })
        .expect(200);
      expect((onDay.body as { items: MovementBody[] }).items).toEqual([
        expect.objectContaining({ kind: 'deposit_in', bags_delta: 10 }),
      ]);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: request.Response = await request(api.app)
          .get('/ledger')
          .query({ warehouse: api.fixtures.warehouseId, limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200);
        const body = page.body as { items: { id: string }[]; next_cursor: string | null };
        seen.push(...body.items.map((item) => item.id));
        cursor = body.next_cursor;
      } while (cursor !== null);
      const all = await api.pool.query('SELECT id FROM stock_movements WHERE warehouse_id = $1', [
        api.fixtures.warehouseId,
      ]);
      expect(new Set(seen).size).toBe(all.rowCount);
    });

    it.each([
      [{ kind: 'gift' }, 'kind'],
      [{ commodity: 'RICE' }, 'commodity'],
      [{ from: '2026-13-01' }, 'from'],
      [{ limit: '0' }, 'limit'],
      [{ cursor: 'garbage' }, 'cursor'],
    ])('rejects %j', async (query, field) => {
      const res = await request(api.app).get('/ledger').query(query);
      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([expect.objectContaining({ field })]);
    });
  });

  describe('GET /warehouses/:id/stock', () => {
    it('summarises stock by commodity and grade, valued at the manual price', async () => {
      await request(api.app)
        .post('/prices')
        .send({
          commodity: 'MAIZE_WHITE',
          price_per_tonne_ngn: 450_000,
          effective_from: '2026-09-01',
          entered_by: api.fixtures.verifierId,
        })
        .expect(201);
      const res = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/stock`)
        .expect(200);
      const body = res.body as {
        lines: {
          grade: string;
          bags: number;
          kg: number;
          farmer_count: number;
          value_ngn: number | null;
        }[];
        totals: { bags: number };
      };
      const grade1 = body.lines.find((line) => line.grade === '1');
      const expected = await balance();
      expect(grade1).toMatchObject({
        bags: expected.bags,
        kg: expected.kg,
        farmer_count: 1,
        price_per_tonne_ngn: 450_000,
        value_ngn: Math.round((expected.kg / 1000) * 450_000 * 100) / 100,
      });
      // The cancelled grade-3 deposit leaves nothing behind.
      expect(body.lines.find((line) => line.grade === '3')).toBeUndefined();
    });

    it('404s for an unknown warehouse', async () => {
      await request(api.app).get(`/warehouses/${randomUUID()}/stock`).expect(404);
    });
  });

  describe('database rules', () => {
    it('keeps the ledger append-only and non-negative even for hand-written SQL', async () => {
      await expect(api.pool.query('UPDATE stock_movements SET bags_delta = 1')).rejects.toThrow(
        /append-only/,
      );
      await expect(api.pool.query('DELETE FROM stock_movements')).rejects.toThrow(/append-only/);
      await expect(
        api.pool.query(
          `UPDATE deposits SET bag_count = bag_count + 1
           WHERE deposit_id = (SELECT deposit_id FROM deposits LIMIT 1)`,
        ),
      ).rejects.toThrow(/correct it with an adjustment/);
    });
  });
});
