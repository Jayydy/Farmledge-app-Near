import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depositBody, dispatchBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

// 11:00 in Lagos on 28 September.
const NOW = new Date('2026-09-28T10:00:00Z');

describe('warehouse reports API', () => {
  let api: TestApi;
  let reports: string;

  beforeAll(async () => {
    api = await startTestApi({ clock: () => NOW });
    reports = `/warehouses/${api.fixtures.warehouseId}/reports`;
    const post = (path: string, body: Record<string, unknown>) =>
      request(api.app)
        .post(path)
        .send(body)
        .expect((res) => {
          if (res.status >= 300) throw new Error(`${path}: ${JSON.stringify(res.body)}`);
        });
    // Today: 30 bags grade 1, 10 bags yellow grade 2. Yesterday: 5 bags grade 1.
    await post('/deposits', depositBody(api.fixtures, { bag_count: 30 }));
    await post(
      '/deposits',
      depositBody(api.fixtures, { bag_count: 10, commodity: 'MAIZE_YELLOW', grade: 2 }),
    );
    await post(
      '/deposits',
      depositBody(api.fixtures, { bag_count: 5, captured_at: '2026-09-27T10:00:00Z' }),
    );
    // Dispatches today: one weighed within tolerance, one well over, one not weighed.
    await post('/dispatches', dispatchBody(api.fixtures, { bag_count: 10, exit_weight_kg: 990 }));
    await post('/dispatches', dispatchBody(api.fixtures, { bag_count: 5, exit_weight_kg: 450 }));
    await post('/dispatches', dispatchBody(api.fixtures, { bag_count: 2 }));
  });

  afterAll(async () => {
    await api.close();
  });

  it('summarises one day of intake and dispatch', async () => {
    const res = await request(api.app).get(`${reports}/daily`).expect(200);
    expect(res.body).toMatchObject({
      date: '2026-09-28',
      intake: {
        lines: [
          { commodity: 'MAIZE_WHITE', grade: '1', deposits: 1, bags: 30, kg: 3000 },
          { commodity: 'MAIZE_YELLOW', grade: '2', deposits: 1, bags: 10, kg: 1000 },
        ],
        totals: { deposits: 2, bags: 40, kg: 4000 },
      },
      dispatch: {
        lines: [
          {
            commodity: 'MAIZE_WHITE',
            grade: '1',
            dispatches: 3,
            bags: 17,
            book_kg: 1700,
            exit_weight_kg: 1440,
          },
        ],
        totals: { dispatches: 3, bags: 17, book_kg: 1700 },
      },
      adjustments: { count: 0 },
      voided_deposits: { count: 0, bags: 0 },
    });

    const yesterday = await request(api.app)
      .get(`${reports}/daily`)
      .query({ date: '2026-09-27' })
      .expect(200);
    expect(yesterday.body).toMatchObject({
      intake: { totals: { deposits: 1, bags: 5 } },
      dispatch: { totals: { dispatches: 0 } },
    });
  });

  it('reports shrinkage: stock in versus out, and weighed losses over tolerance', async () => {
    const res = await request(api.app).get(`${reports}/shrinkage`).expect(200);
    const white = (res.body as { lines: { commodity: string }[] }).lines.find(
      (line) => line.commodity === 'MAIZE_WHITE',
    );
    expect(white).toMatchObject({
      bags_in: 35,
      kg_in: 3500,
      bags_out: 17,
      book_kg_out: 1700,
      dispatches: 3,
      unweighed_dispatches: 1,
      // Weighed: 1 500 kg booked, 1 440 kg left the gate.
      weighed: { dispatches: 2, book_kg: 1500, exit_kg: 1440, shrinkage_kg: 60, shrinkage_pct: 4 },
      tolerance_pct: 2,
      over_tolerance: [expect.objectContaining({ shrinkage_kg: 50, shrinkage_pct: 10 })],
    });
  });

  it('lists audits with their variance', async () => {
    const started = await request(api.app)
      .post('/audits')
      .send({
        warehouse_id: api.fixtures.warehouseId,
        conducted_by: api.fixtures.verifierId,
        counted_by: 'Musa Bello',
        witnessed_by: 'Hauwa Sani',
      })
      .expect(201);
    const auditId = (started.body as { audit: { id: string } }).audit.id;
    await request(api.app)
      .post(`/audits/${auditId}/lines`)
      .send({ commodity: 'MAIZE_WHITE', grade: 1, counted_bags: 17 })
      .expect(201);

    const res = await request(api.app).get(`${reports}/audits`).expect(200);
    expect(res.body).toMatchObject({
      period: { from: '2026-08-30', to: '2026-09-28' },
      audits: [
        {
          audit_id: auditId,
          status: 'open',
          counted_by: 'Musa Bello',
          witnessed_by: 'Hauwa Sani',
          lines_counted: 1,
          totals: { recorded_bags: 18, counted_bags: 17, difference_bags: -1 },
        },
      ],
    });
    const earlier = await request(api.app)
      .get(`${reports}/audits`)
      .query({ to: '2026-09-01' })
      .expect(200);
    expect((earlier.body as { audits: unknown[] }).audits).toEqual([]);
  });

  it('reports platform fees under the terms in force', async () => {
    const none = await request(api.app).get(`${reports}/platform-fees`).expect(200);
    expect(none.body).toMatchObject({
      lines: [
        { model: 'none', effective_from: null, bags_in: 45, amount_ngn: 0, implemented: true },
      ],
      total_ngn: 0,
    });

    await request(api.app)
      .post(`/warehouses/${api.fixtures.warehouseId}/platform-fee-terms`)
      .send({
        model: 'per_bag',
        per_bag_rate_ngn: 50,
        effective_from: '2026-09-28',
        set_by: api.fixtures.verifierId,
      })
      .expect(201);
    const perBag = await request(api.app).get(`${reports}/platform-fees`).expect(200);
    expect(perBag.body).toMatchObject({
      lines: [
        { model: 'none', bags_in: 5, amount_ngn: 0 },
        {
          model: 'per_bag',
          effective_from: '2026-09-28',
          per_bag_rate_ngn: 50,
          bags_in: 40,
          amount_ngn: 2000,
        },
      ],
      total_ngn: 2000,
    });
  });

  it('validates report queries and warehouses', async () => {
    const res = await request(api.app)
      .get(`${reports}/shrinkage`)
      .query({ from: '2026-09-28', to: '2026-09-01' });
    expect(res.status).toBe(400);
    const bad = await request(api.app).get(`${reports}/daily`).query({ date: 'yesterday' });
    expect((bad.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'invalid_date' }),
    ]);
    for (const report of ['daily', 'outstanding-fees', 'audits', 'shrinkage', 'platform-fees']) {
      await request(api.app).get(`/warehouses/${randomUUID()}/reports/${report}`).expect(404);
    }
  });
});
