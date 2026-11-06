import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depositBody, dispatchBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface DispatchResponse {
  dispatch: {
    dispatch_id: string;
    delivery_note_no: string;
    book_kg: number;
    status: string;
    confirmation: { mode: string; status: string };
    lots_drawn: { deposit_id: string; deposit_no: number; bags: number; kg: number }[];
  };
  duplicate: boolean;
}

describe('dispatches API', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
    // 30 bags of white maize grade 1 (3 000 kg), and 10 of grade 2.
    for (const overrides of [{ bag_count: 20 }, { bag_count: 10 }, { bag_count: 10, grade: 2 }]) {
      await request(api.app)
        .post('/deposits')
        .send(depositBody(api.fixtures, overrides))
        .expect(201);
    }
  });

  afterAll(async () => {
    await api.close();
  });

  const post = (overrides: Record<string, unknown> = {}) =>
    request(api.app).post('/dispatches').send(dispatchBody(api.fixtures, overrides));
  const bags = async (grade: string) => {
    const res = await request(api.app).get(`/farmers/${api.fixtures.farmerId}/balance`).expect(200);
    const items = (res.body as { items: { grade: string; bags: number; kg: number }[] }).items;
    return items.find((item) => item.grade === grade) ?? { bags: 0, kg: 0 };
  };

  it('records a dispatch, takes it off the balance and numbers its delivery note', async () => {
    const res = await post({
      bag_count: 5,
      exit_weight_kg: 490,
      buyer_name: 'Alhaji Musa Traders',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      duplicate: false,
      dispatch: {
        grade: '1',
        bag_count: 5,
        book_kg: 500,
        exit_weight_kg: 490,
        shrinkage_kg: 10,
        shrinkage_pct: 2,
        buyer_name: 'Alhaji Musa Traders',
        delivery_note_no: 'KN-DAWANAU-DN-000001',
        status: 'completed',
        confirmation: { mode: 'tablet', status: 'approved' },
        chain_tx_hash: null,
      },
    });
    expect(await bags('1')).toEqual(expect.objectContaining({ bags: 25, kg: 2500 }));

    const second = await post({ bag_count: 1 });
    expect((second.body as DispatchResponse).dispatch.delivery_note_no).toBe(
      'KN-DAWANAU-DN-000002',
    );
  });

  it('rejects a dispatch beyond the balance and changes nothing', async () => {
    const before = await bags('2');
    const res = await post({ grade: 2, bag_count: 11 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: 'insufficient_balance', details: { available_bags: 10, available_kg: 1000 } },
    });
    expect(await bags('2')).toEqual(before);

    // A grade the farmer holds none of.
    const none = await post({ grade: 3, bag_count: 1 });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: { details: { available_bags: 0 } } });
  });

  it('lets the whole balance leave, taking the kg to exactly zero', async () => {
    const res = await post({ grade: 2, bag_count: 10 });
    expect(res.status).toBe(201);
    expect((res.body as DispatchResponse).dispatch.book_kg).toBe(1000);
    expect(await bags('2')).toEqual({ bags: 0, kg: 0 });
  });

  it('is idempotent on dispatch_id and refuses a reused id with different content', async () => {
    const body = dispatchBody(api.fixtures, { bag_count: 2 });
    await request(api.app).post('/dispatches').send(body).expect(201);
    const before = await bags('1');

    const repeat = await request(api.app).post('/dispatches').send(body);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({
      duplicate: true,
      dispatch: { dispatch_id: body.dispatch_id },
    });
    expect(await bags('1')).toEqual(before);

    const conflict = await request(api.app)
      .post('/dispatches')
      .send({ ...body, bag_count: 3 });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { code: 'dispatch_id_conflict', details: { differing_fields: ['bag_count'] } },
    });
  });

  it('applies concurrent dispatches one at a time, never overdrawing', async () => {
    const { bags: available } = await bags('1');
    const each = Math.ceil(available / 2) + 1;
    const results = await Promise.all([post({ bag_count: each }), post({ bag_count: each })]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect((await bags('1')).bags).toBe(available - each);
  });

  it('requires the farmer to confirm on the tablet', async () => {
    const res = await post({ farmer_confirmed: false });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'farmer_confirmation_required', field: 'farmer_confirmed' }),
    ]);
  });

  it('validates the body and references', async () => {
    const res = await post({
      dispatch_id: 'not-a-uuid',
      grade: 9,
      bag_count: 0,
      custodian_id: api.fixtures.otherCustodianId,
    });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'invalid_dispatch_id' }),
      expect.objectContaining({ code: 'invalid_grade' }),
      expect.objectContaining({ code: 'invalid_bag_count' }),
    ]);

    const wrongPlace = await post({ custodian_id: api.fixtures.otherCustodianId });
    expect((wrongPlace.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'custodian_wrong_warehouse' }),
    ]);
  });

  it('texts the farmer, writes a dispatch leaf per lot drawn and the confirmation', async () => {
    const sentBefore = api.sms.sent.length;
    const res = await post({ bag_count: 1 });
    const { dispatch } = res.body as DispatchResponse;

    expect(api.sms.sent.slice(sentBefore)).toEqual([
      {
        to: '+2348000000004',
        body: expect.stringContaining(
          `1 bags of white maize grade 1 left Dawanau Test Store from lot #${dispatch.lots_drawn[0]?.deposit_no} (note ${dispatch.delivery_note_no})`,
        ) as string,
      },
    ]);
    const notification = await api.pool.query<{ status: string; provider: string }>(
      `SELECT status, provider FROM notifications WHERE template = 'dispatch_recorded'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(notification.rows[0]).toEqual({ status: 'sent', provider: 'mock' });

    // data_version 3: an unminted lot leaves off-chain; its dispatch goes in
    // the daily book as a leaf, one per lot drawn (D29, INV-4).
    expect(dispatch.lots_drawn).toHaveLength(1);
    const leaves = await api.pool.query<{ kind: number; content: { bags: number } }>(
      `SELECT b.kind, b.content FROM book_entries b
         JOIN lot_movements lm ON lm.id = b.lot_movement_id
         JOIN stock_movements sm ON sm.id = lm.stock_movement_id
        WHERE sm.dispatch_id = $1`,
      [dispatch.dispatch_id],
    );
    expect(leaves.rows).toEqual([
      { kind: 1, content: expect.objectContaining({ bags: 1, kind: 1 }) as unknown },
    ]);
  });

  it('serves the dispatch and a printable delivery note', async () => {
    const created = (await post({ bag_count: 1, buyer_name: 'Kano Feeds' }))
      .body as DispatchResponse;
    const id = created.dispatch.dispatch_id;

    const got = await request(api.app).get(`/dispatches/${id.toUpperCase()}`).expect(200);
    expect(got.body).toMatchObject({ dispatch: { dispatch_id: id } });

    const note = await request(api.app).get(`/dispatches/${id}/delivery-note`).expect(200);
    expect(note.body).toMatchObject({
      delivery_note: {
        delivery_note_no: created.dispatch.delivery_note_no,
        environment: 'test',
        warehouse: { code: 'KN-DAWANAU', name: 'Dawanau Test Store' },
        farmer: { full_name: 'Test Farmer', phone: '+2348000000004' },
        custodian: { full_name: 'Test Custodian' },
        buyer_name: 'Kano Feeds',
        goods: { commodity: 'MAIZE_WHITE', grading_scheme: 'provisional', grade: '1', bags: 1 },
        farmer_confirmation: { mode: 'tablet', status: 'approved' },
      },
    });

    await request(api.app).get(`/dispatches/${randomUUID()}`).expect(404);
    await request(api.app).get(`/dispatches/${randomUUID()}/delivery-note`).expect(404);
  });

  it('never refuses an exit for shrinkage: it records the variance and flags it for review', async () => {
    const over = await post({ bag_count: 1, exit_weight_kg: 90 });
    expect(over.status).toBe(201);
    expect(over.body).toMatchObject({
      dispatch: {
        shrinkage_kg: 10,
        shrinkage_pct: 10,
        shrinkage_tolerance_pct: 2,
        needs_review: true,
        review_reasons: ['shrinkage_above_threshold'],
      },
    });
    const within = await post({ bag_count: 1, exit_weight_kg: 99 });
    expect(within.body).toMatchObject({ dispatch: { needs_review: false, review_reasons: [] } });

    const flagged = await request(api.app)
      .get('/dispatches')
      .query({ warehouse: api.fixtures.warehouseId, needs_review: 'true' })
      .expect(200);
    const ids = (flagged.body as { items: { dispatch_id: string }[] }).items.map(
      (item) => item.dispatch_id,
    );
    expect(ids).toContain((over.body as DispatchResponse).dispatch.dispatch_id);
    expect(ids).not.toContain((within.body as DispatchResponse).dispatch.dispatch_id);
  });

  it('lets the owner set the warehouse tolerance; past exits keep the tolerance they were judged by', async () => {
    const tolerance = (body: Record<string, unknown>) =>
      request(api.app)
        .post(`/warehouses/${api.fixtures.warehouseId}/shrinkage-tolerance`)
        .send({
          tolerance_pct: 5,
          reason: 'Dusty store; trial figure',
          set_by: api.fixtures.ownerId,
          ...body,
        });

    const custodian = await tolerance({ set_by: api.fixtures.custodianId });
    expect(custodian.status).toBe(403);
    expect((await tolerance({ tolerance_pct: 101 })).status).toBe(400);

    const set = await tolerance({});
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({
      items: [
        {
          commodity: 'MAIZE_WHITE',
          tolerance_pct: 5,
          source: 'warehouse',
          reason: 'Dusty store; trial figure',
        },
        { commodity: 'MAIZE_YELLOW', tolerance_pct: 5, source: 'warehouse' },
      ],
    });

    const fourPct = await post({ bag_count: 1, exit_weight_kg: 96 });
    expect(fourPct.body).toMatchObject({
      dispatch: { shrinkage_tolerance_pct: 5, needs_review: false },
    });
    const earlier = await request(api.app)
      .get('/dispatches')
      .query({ needs_review: 'true' })
      .expect(200);
    expect((earlier.body as { items: { shrinkage_tolerance_pct: number }[] }).items).toEqual([
      expect.objectContaining({ shrinkage_tolerance_pct: 2 }),
    ]);
  });

  it('keeps audits honest: dispatched stock is not reported as missing', async () => {
    const { bags: recorded } = await bags('1');
    const audit = await request(api.app)
      .post('/audits')
      .send({
        warehouse_id: api.fixtures.warehouseId,
        conducted_by: api.fixtures.verifierId,
        counted_by: 'Musa Bello',
        witnessed_by: 'Hauwa Sani',
      })
      .expect(201);
    const line = await request(api.app)
      .post(`/audits/${(audit.body as { audit: { id: string } }).audit.id}/lines`)
      .send({ commodity: 'MAIZE_WHITE', grade: '1', counted_bags: recorded })
      .expect(201);
    expect(line.body).toMatchObject({ line: { recorded_bags: recorded, variance_bags: 0 } });
  });
});

describe('shrinkage tolerance per commodity', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
    await request(api.app)
      .post('/deposits')
      .send(depositBody(api.fixtures, { bag_count: 10 }))
      .expect(201);
  });

  afterAll(async () => {
    await api.close();
  });

  const setTolerance = (body: Record<string, unknown>) =>
    request(api.app)
      .post(`/warehouses/${api.fixtures.warehouseId}/shrinkage-tolerance`)
      .send({ reason: 'Trial figure', set_by: api.fixtures.ownerId, ...body });
  const tolerances = async () =>
    (
      (
        await request(api.app)
          .get(`/warehouses/${api.fixtures.warehouseId}/shrinkage-tolerance`)
          .expect(200)
      ).body as { items: { commodity: string; tolerance_pct: number; source: string }[] }
    ).items.map(({ commodity, tolerance_pct, source }) => ({ commodity, tolerance_pct, source }));

  it('uses the configured default when the warehouse has set nothing', async () => {
    expect(await tolerances()).toEqual([
      { commodity: 'MAIZE_WHITE', tolerance_pct: 2, source: 'default' },
      { commodity: 'MAIZE_YELLOW', tolerance_pct: 2, source: 'default' },
    ]);
  });

  it('falls back to the warehouse default for a commodity with no tolerance of its own', async () => {
    await setTolerance({ tolerance_pct: 1.5, commodity: 'MAIZE_WHITE' }).expect(201);
    expect(await tolerances()).toEqual([
      { commodity: 'MAIZE_WHITE', tolerance_pct: 1.5, source: 'commodity' },
      { commodity: 'MAIZE_YELLOW', tolerance_pct: 2, source: 'default' },
    ]);

    await setTolerance({ tolerance_pct: 3 }).expect(201);
    // A later warehouse default never overrides a commodity's own tolerance.
    expect(await tolerances()).toEqual([
      { commodity: 'MAIZE_WHITE', tolerance_pct: 1.5, source: 'commodity' },
      { commodity: 'MAIZE_YELLOW', tolerance_pct: 3, source: 'warehouse' },
    ]);

    // Exits are judged against the commodity's tolerance: 2% loss > 1.5%.
    const exit = await request(api.app)
      .post('/dispatches')
      .send(dispatchBody(api.fixtures, { bag_count: 1, exit_weight_kg: 98 }))
      .expect(201);
    expect(exit.body).toMatchObject({
      dispatch: { shrinkage_tolerance_pct: 1.5, needs_review: true },
    });
  });

  it('rejects an unknown commodity', async () => {
    const res = await setTolerance({ tolerance_pct: 1, commodity: 'SORGHUM' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('unsupported_commodity');
  });
});
