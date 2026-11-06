import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdapterUnavailableError } from '../../src/adapters.js';
import { createLogger } from '../../src/logger.js';
import { startServer } from '../../src/server.js';
import { depositBody, dispatchBody, startTestApi, type TestApi } from '../helpers/api.js';
import { testConfig } from '../helpers/env.js';
import type { ErrorBody } from '../helpers/http.js';

const lendingCalls = (app: TestApi['app']) => {
  const id = randomUUID();
  const by = { requested_by: randomUUID() };
  return [
    request(app)
      .post('/lending/locks')
      .send({ deposit_id: 'd', lender_ref: 'L1', amount_ngn: 1, ...by }),
    request(app).post(`/lending/locks/${id}/unlock`).send(by),
    request(app).post(`/lending/locks/${id}/recovery`).send(by),
    request(app).post(`/lending/recoveries/${id}/complete`).send(by),
  ];
};

describe('switches at their defaults', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.close();
  });

  it('reports the switches to the tablet', async () => {
    const res = await request(api.app).get('/features').expect(200);
    expect(res.body).toEqual({
      lending_enabled: false,
      chain_enabled: false,
      confirmation_mode: 'tablet_only',
      weight_mode: 'bag_estimate',
      release_authority: 'paper',
      grading: { scheme: 'provisional', grades: ['1', '2', '3'] },
      sms_gateway: 'mock',
      pricing_provider: 'manual',
      business_timezone: 'Africa/Lagos',
      auth_required: false,
      intake: {
        commodities: [
          { code: 'MAIZE_WHITE', bag_size_kg: 100, moisture_pct: { min: 0, max: 13.5 } },
          { code: 'MAIZE_YELLOW', bag_size_kg: 100, moisture_pct: { min: 0, max: 13.5 } },
        ],
        bag_count_max: 1000,
        bag_count_confirm_above: 300,
        offline_review_after_hours: 48,
        offline_reject_after_hours: 168,
        notes_max_length: 500,
        photos: {
          max_per_deposit: 3,
          max_bytes: 5242880,
          types: ['image/jpeg', 'image/png', 'image/webp'],
        },
      },
    });
  });

  it('LENDING_ENABLED=false: every lending route answers 501 feature_disabled', async () => {
    for (const res of await Promise.all(lendingCalls(api.app))) {
      expect(res.status).toBe(501);
      expect((res.body as ErrorBody).error.code).toBe('feature_disabled');
    }
    // Before looking at the request at all.
    const garbage = await request(api.app).post('/lending/locks').send({});
    expect((garbage.body as ErrorBody).error.code).toBe('feature_disabled');
  });

  it('WEIGHT_MODE=bag_estimate: deposits are weighed by bag count', async () => {
    const res = await request(api.app)
      .post('/deposits')
      .send(depositBody(api.fixtures))
      .expect(201);
    expect(res.body).toMatchObject({ deposit: { weight_source: 'bag_estimate', weight_kg: 2000 } });
  });

  describe('manual prices (provision i)', () => {
    const price = (body: Record<string, unknown>) =>
      request(api.app)
        .post('/prices')
        .send({
          commodity: 'MAIZE_WHITE',
          effective_from: '2026-09-01',
          entered_by: api.fixtures.verifierId,
          ...body,
        });

    it('records prices and lists them', async () => {
      const res = await price({ price_per_tonne_ngn: 400_000 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        price: {
          commodity: 'MAIZE_WHITE',
          grading_scheme: 'provisional',
          grade: null,
          price_per_tonne_ngn: 400_000,
        },
      });
      await price({ grade: 1, price_per_tonne_ngn: 450_000 }).expect(201);
      const list = await request(api.app)
        .get('/prices')
        .query({ commodity: 'MAIZE_WHITE' })
        .expect(200);
      expect(
        (list.body as { items: { grade: string | null }[] }).items.map((item) => item.grade),
      ).toEqual([null, '1']);

      // A grade-specific price wins over the commodity-wide one.
      const stock = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/stock`)
        .expect(200);
      expect(stock.body).toMatchObject({
        lines: [{ grade: '1', price_per_tonne_ngn: 450_000, value_ngn: 900_000 }],
      });
    });

    it('validates prices and refuses a second price for the same day', async () => {
      const bad = await price({
        commodity: 'RICE',
        grade: 9,
        price_per_tonne_ngn: 0,
        entered_by: api.fixtures.custodianId,
      });
      expect(bad.status).toBe(400);
      expect((bad.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'unsupported_commodity' }),
        expect.objectContaining({ code: 'invalid_grade' }),
        expect.objectContaining({ code: 'invalid_price' }),
        expect.objectContaining({ code: 'verifier_not_found' }),
      ]);
      const again = await price({ price_per_tonne_ngn: 1 });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: { code: 'price_exists' } });
    });
  });

  describe('platform fee terms (provision g)', () => {
    const terms = (body: Record<string, unknown>) =>
      request(api.app)
        .post(`/warehouses/${api.fixtures.warehouseId}/platform-fee-terms`)
        .send({ set_by: api.fixtures.verifierId, ...body });

    it('accepts every model; models not built yet report no amount', async () => {
      await terms({ model: 'revenue_share', effective_from: '2026-01-01' }).expect(201);
      const report = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/reports/platform-fees`)
        .expect(200);
      expect(report.body).toMatchObject({
        lines: [{ model: 'revenue_share', amount_ngn: null, implemented: false }],
        total_ngn: null,
      });
      const list = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/platform-fee-terms`)
        .expect(200);
      expect((list.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('validates terms', async () => {
      const missingRate = await terms({ model: 'per_bag', effective_from: '2026-02-01' });
      expect((missingRate.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'invalid_rate' }),
      ]);
      const strayRate = await terms({
        model: 'none',
        per_bag_rate_ngn: 5,
        effective_from: '2026-02-01',
      });
      expect((strayRate.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'invalid_rate' }),
      ]);
      const unknown = await terms({ model: 'barter', effective_from: '2026-02-01' });
      expect((unknown.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'invalid_model' }),
      ]);
      const twice = await terms({ model: 'none', effective_from: '2026-01-01' });
      expect(twice.status).toBe(409);
    });
  });
});

describe('switches turned on', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi({
      env: {
        LENDING_ENABLED: 'true',
        RELEASE_AUTHORITY: 'farmledge',
        CONFIRMATION_MODE: 'sms_two_way',
        WEIGHT_MODE: 'scale_required',
        GRADING_SCHEME: 'ng-maize-2026',
        GRADE_VALUES: 'G1,G2',
      },
    });
  });

  afterAll(async () => {
    await api.close();
  });

  it('LENDING_ENABLED=true: requests are validated, then reach the stub (501 not_implemented)', async () => {
    for (const res of await Promise.all(lendingCalls(api.app))) {
      expect(res.status).toBe(501);
      expect((res.body as ErrorBody).error.code).toBe('not_implemented');
    }
    const invalid = await request(api.app).post('/lending/locks').send({ deposit_id: 'd' });
    expect(invalid.status).toBe(400);
  });

  it('GRADING_SCHEME: a named standard works with no migration', async () => {
    const res = await request(api.app)
      .post('/deposits')
      .send(depositBody(api.fixtures, { grade: 'G1', bag_count: 10 }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ deposit: { grade: 'G1', grading_scheme: 'ng-maize-2026' } });

    const old = await request(api.app)
      .post('/deposits')
      .send(depositBody(api.fixtures, { grade: 1 }));
    expect((old.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'invalid_grade', message: 'Grade must be one of G1, G2' }),
    ]);
  });

  it('WEIGHT_MODE=scale_required: the ledger moves to the measured weight once every bag is weighed', async () => {
    const body = depositBody(api.fixtures, { grade: 'G2', bag_count: 4 });
    const created = await request(api.app).post('/deposits').send(body).expect(201);
    expect(created.body).toMatchObject({ deposit: { weight_source: 'scale', weight_kg: null } });

    const sample = (bags: number, kg: number) =>
      request(api.app)
        .post(`/deposits/${body.deposit_id}/scale-samples`)
        .send({ bags_weighed: bags, total_kg: kg, recorded_by: api.fixtures.custodianId })
        .expect(201);
    const stockKg = async () => {
      const res = await request(api.app)
        .get(`/farmers/${api.fixtures.farmerId}/balance`)
        .expect(200);
      return (res.body as { items: { grade: string; kg: number }[] }).items.find(
        (item) => item.grade === 'G2',
      )?.kg;
    };

    await sample(3, 290.4);
    expect(await stockKg()).toBe(400); // still the estimate
    await sample(1, 96.35);
    expect(await stockKg()).toBe(386.75);

    const ledger = await request(api.app).get('/ledger').query({ kind: 'adjustment' }).expect(200);
    expect((ledger.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ grade: 'G2', bags_delta: 0, kg_delta: -13.25 }),
    ]);
    const deposit = await request(api.app).get(`/deposits/${body.deposit_id}`).expect(200);
    expect(deposit.body).toMatchObject({ deposit: { weight_kg: 386 } });
  });

  it('CONFIRMATION_MODE=sms_two_way: dispatch answers 501 and records nothing', async () => {
    const before = await api.pool.query('SELECT count(*)::int AS n FROM stock_movements');
    const res = await request(api.app)
      .post('/dispatches')
      .send(dispatchBody(api.fixtures, { grade: 'G1', bag_count: 1 }));
    expect(res.status).toBe(501);
    expect((res.body as ErrorBody).error.code).toBe('not_implemented');
    const after = await api.pool.query('SELECT count(*)::int AS n FROM stock_movements');
    expect(after.rows).toEqual(before.rows);
    const confirmations = await api.pool.query('SELECT 1 FROM farmer_confirmations');
    expect(confirmations.rowCount).toBe(0);
  });

  it.each([{ KEY_SERVICE: 'kms' }])(
    'refuses to start with %j: this build has no such adapter',
    async (env) => {
      const config = testConfig(api.config.database.url, 'test', env);
      await expect(startServer(config, createLogger('silent'))).rejects.toBeInstanceOf(
        AdapterUnavailableError,
      );
    },
  );
});
