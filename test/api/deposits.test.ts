import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface DepositResponse {
  deposit: {
    deposit_id: string;
    weight_kg: number;
    weight_source: string;
    status: string;
    bag_count: number;
    bag_size_kg: number;
    notes: string | null;
    captured_at: string;
  };
  duplicate: boolean;
}

interface PageResponse {
  items: { deposit_id: string; status: string }[];
  next_cursor: string | null;
}

describe('deposits API', () => {
  let api: TestApi;
  let server: Server;

  beforeAll(async () => {
    api = await startTestApi();
    // One real server so concurrent requests really run in parallel.
    server = api.app.listen(0);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await api.close();
  });

  const post = (body: object) => request(server).post('/deposits').send(body);
  const countRows = async (depositId: string) => {
    const { rows } = await api.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM deposits WHERE deposit_id = $1',
      [depositId],
    );
    return rows[0]?.n;
  };

  describe('POST /deposits', () => {
    it('records a bag-estimate deposit with its derived weight', async () => {
      const body = depositBody(api.fixtures, { bag_count: 37, notes: ' two torn sacks ' });
      const res = await post(body);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        duplicate: false,
        deposit: {
          deposit_id: body.deposit_id,
          weight_source: 'bag_estimate',
          weight_kg: 3700,
          bag_size_kg: 100,
          status: 'recorded',
          notes: 'two torn sacks',
          photo_count: 0,
          scale_samples: { count: 0, bags_weighed: 0, total_kg: null },
        },
      });
    });

    it('keeps the tablet capture time', async () => {
      const capturedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const res = await post(depositBody(api.fixtures, { captured_at: capturedAt }));
      expect((res.body as DepositResponse).deposit.captured_at).toBe(capturedAt);
    });

    it('returns the original, not a duplicate, when the same deposit is repeated', async () => {
      const body = depositBody(api.fixtures);
      const first = await post(body);
      const second = await post({ ...body, deposit_id: body.deposit_id.toUpperCase() });

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect((second.body as DepositResponse).duplicate).toBe(true);
      expect((second.body as DepositResponse).deposit).toEqual(
        (first.body as DepositResponse).deposit,
      );
      expect(await countRows(body.deposit_id)).toBe(1);
    });

    it('creates exactly one deposit from 20 concurrent identical submissions', async () => {
      const body = depositBody(api.fixtures);
      const responses = await Promise.all(Array.from({ length: 20 }, () => post(body)));

      expect(responses.map((r) => r.status).sort()).toEqual([...Array<number>(19).fill(200), 201]);
      const deposits = responses.map((r) => (r.body as DepositResponse).deposit);
      expect(new Set(deposits.map((d) => JSON.stringify(d))).size).toBe(1);
      expect(await countRows(body.deposit_id)).toBe(1);
    });

    it('lets exactly one of several concurrent conflicting submissions win', async () => {
      const depositId = randomUUID();
      const responses = await Promise.all(
        [10, 11, 12, 13, 14].map((bags) =>
          post(depositBody(api.fixtures, { deposit_id: depositId, bag_count: bags })),
        ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      expect(await countRows(depositId)).toBe(1);
    });

    it('rejects a reused deposit_id with different content, naming the differences', async () => {
      const body = depositBody(api.fixtures);
      await post(body).expect(201);
      const res = await post({ ...body, bag_count: 21, grade: 2 });

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toMatchObject({
        code: 'deposit_id_conflict',
        details: { deposit_id: body.deposit_id, differing_fields: ['grade', 'bag_count'] },
      });
    });

    it('returns every rule failure at once', async () => {
      const res = await post(
        depositBody(api.fixtures, {
          deposit_id: 'not-a-uuid',
          commodity: 'SORGHUM',
          grade: 4,
          moisture_pct: 13.6,
          bag_count: 1001,
        }),
      );

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.code).toBe('validation_failed');
      expect(
        ((res.body as ErrorBody).error.details as { code: string }[]).map((d) => d.code),
      ).toEqual([
        'invalid_deposit_id',
        'unsupported_commodity',
        'invalid_grade',
        'bag_count_too_large',
      ]);
    });

    describe('moisture as a percentage', () => {
      it('stores basis points and returns the percentage', async () => {
        const body = depositBody(api.fixtures, { moisture_pct: 13.5 });
        const res = await post(body);
        expect((res.body as { deposit: { moisture_pct: number } }).deposit.moisture_pct).toBe(13.5);
        const { rows } = await api.pool.query(
          'SELECT moisture_bps FROM deposits WHERE deposit_id = $1',
          [body.deposit_id],
        );
        expect(rows).toEqual([{ moisture_bps: 1350 }]);
      });

      it('rejects moisture above the configured limit', async () => {
        const res = await post(depositBody(api.fixtures, { moisture_pct: 13.6 }));
        expect((res.body as ErrorBody).error.details).toEqual([
          expect.objectContaining({ code: 'moisture_out_of_range', field: 'moisture_pct' }),
        ]);
      });

      it('rejects more than one decimal place', async () => {
        const res = await post(depositBody(api.fixtures, { moisture_pct: 12.55 }));
        expect((res.body as ErrorBody).error.details).toEqual([
          expect.objectContaining({ code: 'invalid_moisture', field: 'moisture_pct' }),
        ]);
      });

      it('no longer accepts basis points', async () => {
        const body = depositBody(api.fixtures, { moisture_bps: 1250 });
        delete body.moisture_pct;
        const res = await post(body);
        expect((res.body as ErrorBody).error.details).toEqual([
          expect.objectContaining({ code: 'required', field: 'moisture_pct' }),
        ]);
      });
    });

    describe('bag count limits', () => {
      it('asks for confirmation above 300 bags', async () => {
        const res = await post(depositBody(api.fixtures, { bag_count: 301 }));
        expect(res.status).toBe(400);
        expect((res.body as ErrorBody).error.details).toEqual([
          expect.objectContaining({ code: 'bag_count_needs_confirmation', field: 'bag_count' }),
        ]);
      });

      it('accepts 300 bags without confirmation', async () => {
        const res = await post(depositBody(api.fixtures, { bag_count: 300 }));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ deposit: { bag_count_confirmed: false } });
      });

      it('accepts a confirmed large deposit and records the confirmation', async () => {
        const res = await post(
          depositBody(api.fixtures, { bag_count: 1000, confirm_bag_count: true }),
        );
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          deposit: { bag_count: 1000, weight_kg: 100_000, bag_count_confirmed: true },
        });
      });

      it('rejects more than 1000 bags even when confirmed', async () => {
        const res = await post(
          depositBody(api.fixtures, { bag_count: 1001, confirm_bag_count: true }),
        );
        expect((res.body as ErrorBody).error.details).toEqual([
          expect.objectContaining({ code: 'bag_count_too_large' }),
        ]);
      });
    });

    describe('late offline captures', () => {
      const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

      it('accepts a capture under 48 hours old without review', async () => {
        const res = await post(depositBody(api.fixtures, { captured_at: hoursAgo(47) }));
        expect(res.body).toMatchObject({ deposit: { needs_review: false, review_reasons: [] } });
      });

      it('accepts a capture over 48 hours old but flags it for review', async () => {
        const res = await post(depositBody(api.fixtures, { captured_at: hoursAgo(49) }));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          deposit: { needs_review: true, review_reasons: ['late_capture'] },
        });
      });

      it('rejects a capture over 7 days old', async () => {
        const res = await post(depositBody(api.fixtures, { captured_at: hoursAgo(7 * 24 + 1) }));
        expect((res.body as ErrorBody).error.details).toEqual([
          expect.objectContaining({ code: 'captured_at_too_old', field: 'captured_at' }),
        ]);
      });
    });

    it('rejects wrong JSON types and missing fields', async () => {
      const body = depositBody(api.fixtures, { grade: true });
      delete body.bag_count;
      const res = await post(body);
      expect((res.body as ErrorBody).error.details).toEqual([
        {
          code: 'invalid_type',
          field: 'grade',
          message: 'grade must be a grade code (string) or a number',
        },
        { code: 'required', field: 'bag_count', message: 'bag_count is required' },
      ]);
    });

    it('accepts a grade as a code or a number and returns the code', async () => {
      for (const grade of [2, '2']) {
        const res = await post(depositBody(api.fixtures, { grade }));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ deposit: { grade: '2', grading_scheme: 'provisional' } });
      }
    });

    it.each([
      ['farmer_id', '00000000-0000-4000-8000-000000000000', 'farmer_not_found'],
      ['warehouse_id', '00000000-0000-4000-8000-000000000000', 'warehouse_not_found'],
      ['custodian_id', '00000000-0000-4000-8000-000000000000', 'custodian_not_found'],
      ['verifier_id', '00000000-0000-4000-8000-000000000000', 'verifier_not_found'],
      ['farmer_id', 'not-a-uuid', 'invalid_id'],
    ])('rejects an unknown %s (%s)', async (field, value, code) => {
      const body = depositBody(api.fixtures, { [field]: value });
      const res = await post(body);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code, field }),
      ]);
      expect(await countRows(body.deposit_id)).toBe(0);
    });

    it('rejects a custodian from another warehouse', async () => {
      const res = await post(
        depositBody(api.fixtures, { custodian_id: api.fixtures.otherCustodianId }),
      );
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'custodian_wrong_warehouse' }),
      ]);
    });

    it('rejects a farmer not registered at the warehouse', async () => {
      const res = await post(
        depositBody(api.fixtures, {
          warehouse_id: api.fixtures.otherWarehouseId,
          custodian_id: api.fixtures.otherCustodianId,
        }),
      );
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'farmer_not_at_warehouse', field: 'farmer_id' }),
      ]);
    });

    it('rejects a suspended custodian', async () => {
      const { rows } = await api.pool.query<{ id: string }>(
        `INSERT INTO custodians (warehouse_id, full_name, phone, status)
         VALUES ($1, 'Suspended', '+2348000000077', 'suspended') RETURNING id`,
        [api.fixtures.warehouseId],
      );
      const res = await post(depositBody(api.fixtures, { custodian_id: rows[0]?.id }));
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'custodian_suspended' }),
      ]);
    });

    it('answers a repeat from what was stored even after a reference changes', async () => {
      const { rows } = await api.pool.query<{ id: string }>(
        `INSERT INTO custodians (warehouse_id, full_name, phone)
         VALUES ($1, 'Leaving Soon', '+2348000000078') RETURNING id`,
        [api.fixtures.warehouseId],
      );
      const body = depositBody(api.fixtures, { custodian_id: rows[0]?.id });
      await post(body).expect(201);
      await api.pool.query(`UPDATE custodians SET status = 'suspended' WHERE id = $1`, [
        rows[0]?.id,
      ]);

      const retry = await post(body);
      expect(retry.status).toBe(200);
      expect((retry.body as DepositResponse).duplicate).toBe(true);
    });
  });

  describe('GET /deposits/:depositId', () => {
    it('returns a deposit by its client ID in either case', async () => {
      const body = depositBody(api.fixtures);
      await post(body).expect(201);

      const res = await request(server).get(`/deposits/${body.deposit_id.toUpperCase()}`);
      expect(res.status).toBe(200);
      expect((res.body as DepositResponse).deposit.deposit_id).toBe(body.deposit_id);
    });

    it('returns 404 for an unknown deposit', async () => {
      const res = await request(server).get(`/deposits/${randomUUID()}`);
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error.code).toBe('not_found');
    });
  });

  describe('GET /deposits', () => {
    let farmerId: string;
    const created: string[] = [];

    beforeAll(async () => {
      const farmer = await request(server).post('/farmers').send({
        full_name: 'Paged Farmer',
        phone: '08077777777',
        warehouse_id: api.fixtures.warehouseId,
        registered_by: api.fixtures.custodianId,
        consent: true,
      });
      farmerId = (farmer.body as { farmer: { id: string } }).farmer.id;
      for (let i = 0; i < 5; i++) {
        const body = depositBody(api.fixtures, { farmer_id: farmerId });
        await post(body).expect(201);
        created.push(body.deposit_id);
      }
      await api.pool.query(`UPDATE deposits SET status = 'submitted' WHERE deposit_id = $1`, [
        created[0],
      ]);
    });

    it('pages through a farmer’s deposits newest first without gaps or repeats', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: Record<string, string | number> = { farmer: farmerId, limit: 2 };
        if (cursor !== null) query.cursor = cursor;
        const res = await request(server).get('/deposits').query(query);
        expect(res.status).toBe(200);
        const page = res.body as PageResponse;
        seen.push(...page.items.map((d) => d.deposit_id));
        cursor = page.next_cursor;
        pages++;
      } while (cursor !== null);

      expect(pages).toBe(3);
      expect(seen).toEqual([...created].reverse());
    });

    it('filters deposits needing review', async () => {
      const late = depositBody(api.fixtures, {
        farmer_id: farmerId,
        captured_at: new Date(Date.now() - 72 * 3_600_000).toISOString(),
      });
      await post(late).expect(201);
      created.push(late.deposit_id);

      const flagged = await request(server)
        .get('/deposits')
        .query({ farmer: farmerId, needs_review: 'true' });
      expect((flagged.body as PageResponse).items.map((d) => d.deposit_id)).toEqual([
        late.deposit_id,
      ]);
      const clean = await request(server)
        .get('/deposits')
        .query({ farmer: farmerId, needs_review: 'false' });
      expect((clean.body as PageResponse).items).toHaveLength(created.length - 1);
    });

    it('filters by business date of intake', async () => {
      const lagosDay = (at: Date) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(at);
      const late = created.at(-1);
      const { rows } = await api.pool.query<{ intake_at: Date }>(
        'SELECT intake_at FROM deposits WHERE deposit_id = $1',
        [late],
      );
      const day = lagosDay(rows[0]?.intake_at ?? new Date());
      const that = await request(server)
        .get('/deposits')
        .query({ farmer: farmerId, from: day, to: day });
      expect((that.body as PageResponse).items.map((d) => d.deposit_id)).toEqual([late]);
      const today = await request(server)
        .get('/deposits')
        .query({ farmer: farmerId, from: lagosDay(new Date()) });
      expect((today.body as PageResponse).items).toHaveLength(created.length - 1);
    });

    it('filters by warehouse and status', async () => {
      const res = await request(server)
        .get('/deposits')
        .query({ warehouse: api.fixtures.warehouseId, farmer: farmerId, status: 'submitted' });
      expect((res.body as PageResponse).items.map((d) => d.deposit_id)).toEqual([created[0]]);

      const other = await request(server)
        .get('/deposits')
        .query({ warehouse: api.fixtures.otherWarehouseId });
      expect((other.body as PageResponse).items).toEqual([]);
    });

    it.each([
      [{ status: 'lost' }, 'status'],
      [{ limit: '0' }, 'limit'],
      [{ limit: '201' }, 'limit'],
      [{ warehouse: 'abc' }, 'warehouse'],
      [{ cursor: 'garbage' }, 'cursor'],
      [{ needs_review: 'yes' }, 'needs_review'],
      [{ from: '2026-13-01' }, 'from'],
    ])('rejects invalid query %j', async (query, field) => {
      const res = await request(server).get('/deposits').query(query);
      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([expect.objectContaining({ field })]);
    });
  });
});
