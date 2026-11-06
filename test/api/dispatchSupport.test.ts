import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import type { ErrorBody } from '../helpers/http.js';
import { anchoredLot, DAY, pledge } from '../invariants/helpers.js';

interface LotItem {
  deposit_id: string;
  deposit_no: number;
  bags: number;
  kg: number;
  state: string;
  receipt_id: string | null;
  excluded_reason: string | null;
}

interface PlanBody {
  lots_drawn: { deposit_id: string; deposit_no: number; bags: number; kg: number }[];
  book_kg: number;
  balance_after: { free_bags: number; held_on_chain_bags: number; held_on_chain_lots: number[] };
}

/**
 * What the dispatch and balance screens need (D54): a farmer's lots with
 * their state, the free/on-chain split, a dispatch plan, the unweighed
 * reason, the dispatch list by date, and blocked-dispatch records.
 *
 * One farmer, four lots of white maize grade 1, oldest first: minted,
 * pledged (mint pending), then two free lots of 6 and 4 bags.
 */
describe('dispatch support API', () => {
  let h: ChainHarness;
  let minted: { depositId: string; depositNo: number };
  let pledged: { depositId: string; depositNo: number };
  let older: { depositId: string; depositNo: number };
  let newer: { depositId: string; depositNo: number };

  beforeAll(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
    minted = await anchoredLot(h, DAY, 20);
    expect((await pledge(h, minted.depositId)).status).toBe(201);
    pledged = await anchoredLot(h, DAY + 1, 10);
    (h.chain as FakeChain).failNextCall('mint_from_anchor', 'timeout');
    expect((await pledge(h, pledged.depositId, { kg: 900 })).status).toBe(202);
    older = await anchoredLot(h, DAY + 2, 6);
    newer = await anchoredLot(h, DAY + 3, 4);
    h.clock.set(middayOf(DAY + 4));
  });

  afterAll(async () => {
    await h.close();
  });

  const lots = (query: Record<string, string> = {}) =>
    request(h.app)
      .get(`/farmers/${h.fixtures.farmerId}/lots`)
      .query({ warehouse: h.fixtures.warehouseId, ...query });

  const plan = (overrides: Record<string, unknown> = {}) =>
    request(h.app)
      .post('/dispatches/plan')
      .send({
        warehouse_id: h.fixtures.warehouseId,
        farmer_id: h.fixtures.farmerId,
        custodian_id: h.fixtures.custodianId,
        commodity: 'MAIZE_WHITE',
        grade: '1',
        bag_count: 1,
        ...overrides,
      });

  const dispatchCount = async () =>
    Number((await h.pool.query<{ n: string }>('SELECT count(*) AS n FROM dispatches')).rows[0]?.n);

  describe('GET /farmers/:id/lots', () => {
    it('lists every lot oldest first, and says why each excluded lot cannot leave', async () => {
      const res = await lots();
      expect(res.status).toBe(200);
      const items = (res.body as { items: LotItem[] }).items;
      expect(items.map((lot) => [lot.deposit_no, lot.bags, lot.state])).toEqual([
        [minted.depositNo, 20, 'minted'],
        [pledged.depositNo, 10, 'pledged'],
        [older.depositNo, 6, 'free'],
        [newer.depositNo, 4, 'free'],
      ]);
      expect(items[0]).toMatchObject({ receipt_id: '1' });
      expect(items[0]?.excluded_reason).toMatch(/^Minted as receipt #1: governed on-chain/);
      expect(items[1]).toMatchObject({ receipt_id: null });
      expect(items[1]?.excluded_reason).toMatch(/^Pledged: a receipt is being minted/);
      expect(items.slice(2).map((lot) => lot.excluded_reason)).toEqual([null, null]);
    });

    it('filters by commodity and grade', async () => {
      const yellow = await lots({ commodity: 'MAIZE_YELLOW' });
      expect((yellow.body as { items: LotItem[] }).items).toEqual([]);
      const grade2 = await lots({ commodity: 'MAIZE_WHITE', grade: '2' });
      expect((grade2.body as { items: LotItem[] }).items).toEqual([]);
    });

    it('needs a warehouse and a known farmer', async () => {
      const noWarehouse = await request(h.app).get(`/farmers/${h.fixtures.farmerId}/lots`);
      expect(noWarehouse.status).toBe(400);
      const badCommodity = await lots({ commodity: 'SORGHUM' });
      expect(badCommodity.status).toBe(400);
      const unknown = await request(h.app)
        .get(`/farmers/${randomUUID()}/lots`)
        .query({ warehouse: h.fixtures.warehouseId });
      expect(unknown.status).toBe(404);
    });
  });

  describe('GET /farmers/:id/balance', () => {
    it('splits each line into free and held on-chain, naming the held lots', async () => {
      const res = await request(h.app)
        .get(`/farmers/${h.fixtures.farmerId}/balance`)
        .query({ warehouse: h.fixtures.warehouseId });
      expect(res.status).toBe(200);
      const [line] = (res.body as { items: Record<string, unknown>[] }).items;
      expect(line).toMatchObject({
        bags: 40,
        free_bags: 10,
        held_on_chain_bags: 30,
        held_on_chain_lots: [minted.depositNo, pledged.depositNo],
      });
      expect(Number(line?.free_kg) + Number(line?.held_on_chain_kg)).toBeCloseTo(
        Number(line?.kg),
        2,
      );
    });
  });

  describe('POST /dispatches/plan', () => {
    it('draws the oldest free lots first, skipping pledged and minted ones', async () => {
      const res = await plan({ bag_count: 8 });
      expect(res.status).toBe(200);
      const body = res.body as PlanBody;
      expect(body.lots_drawn.map((lot) => [lot.deposit_no, lot.bags])).toEqual([
        [older.depositNo, 6],
        [newer.depositNo, 2],
      ]);
      expect(body.book_kg).toBeCloseTo(
        body.lots_drawn.reduce((sum, lot) => sum + lot.kg, 0),
        2,
      );
      expect(body.balance_after).toMatchObject({
        free_bags: 2,
        held_on_chain_bags: 30,
        held_on_chain_lots: [minted.depositNo, pledged.depositNo],
      });
    });

    it('takes the bags from one lot when the tablet names it', async () => {
      const res = await plan({ bag_count: 3, deposit_id: newer.depositId });
      expect(res.status).toBe(200);
      expect((res.body as PlanBody).lots_drawn.map((lot) => [lot.deposit_no, lot.bags])).toEqual([
        [newer.depositNo, 3],
      ]);
    });

    it('refuses more than the free balance, and a pledged or minted lot, as a dispatch would', async () => {
      const over = await plan({ bag_count: 11 });
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({
        error: { code: 'insufficient_balance', details: { available_bags: 10 } },
      });
      for (const lot of [pledged, minted]) {
        const named = await plan({ deposit_id: lot.depositId });
        expect(named.status).toBe(409);
        expect((named.body as ErrorBody).error.code).toBe('lot_governed_on_chain');
      }
      const tooMany = await plan({ bag_count: 5, deposit_id: newer.depositId });
      expect((tooMany.body as ErrorBody).error.code).toBe('insufficient_balance');
    });

    it('validates the goods', async () => {
      const res = await plan({ commodity: 'SORGHUM', bag_count: 0 });
      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'unsupported_commodity' }),
        expect.objectContaining({ code: 'invalid_bag_count' }),
      ]);
    });

    it('records nothing', async () => {
      const before = await dispatchCount();
      expect((await plan({ bag_count: 2 })).status).toBe(200);
      expect(await dispatchCount()).toBe(before);
    });
  });

  describe('not_weighed_reason', () => {
    it('is required without an exit weight, and refused with one', async () => {
      const before = await dispatchCount();
      const missing = await h.dispatch({ bag_count: 1, not_weighed_reason: undefined });
      expect(missing.status).toBe(400);
      expect((missing.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'not_weighed_reason_required' }),
      ]);
      const both = await h.dispatch({
        bag_count: 1,
        exit_weight_kg: 95,
        not_weighed_reason: 'No scale',
      });
      expect(both.status).toBe(400);
      expect((both.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'not_weighed_reason_with_weight' }),
      ]);
      expect(await dispatchCount()).toBe(before);
    });

    it('is kept on the dispatch and printed on the delivery note', async () => {
      const res = await h.dispatch({ bag_count: 1, not_weighed_reason: '  Scale broken  ' });
      expect(res.status).toBe(201);
      const { dispatch } = res.body as {
        dispatch: { dispatch_id: string; not_weighed_reason: string; exit_weight_kg: null };
      };
      expect(dispatch).toMatchObject({ exit_weight_kg: null, not_weighed_reason: 'Scale broken' });
      const note = await request(h.app).get(`/dispatches/${dispatch.dispatch_id}/delivery-note`);
      expect(note.body).toMatchObject({
        delivery_note: { goods: { exit_weight_kg: null, not_weighed_reason: 'Scale broken' } },
      });

      const weighed = await h.dispatch({ bag_count: 1, exit_weight_kg: 94 });
      expect(weighed.status).toBe(201);
      expect(weighed.body).toMatchObject({ dispatch: { not_weighed_reason: null } });
    });

    it('is part of what a repeated dispatch_id must match', async () => {
      const body = { dispatch_id: randomUUID(), bag_count: 1, not_weighed_reason: 'No scale' };
      expect((await h.dispatch(body)).status).toBe(201);
      const changed = await h.dispatch({ ...body, not_weighed_reason: 'Scale broken' });
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({
        error: {
          code: 'dispatch_id_conflict',
          details: { differing_fields: ['not_weighed_reason'] },
        },
      });
    });
  });

  describe('GET /dispatches?from=&to=', () => {
    it('lists the dispatches of a business-day range', async () => {
      // Every dispatch above was at midday UTC on DAY + 4: 2026-10-05 in Lagos.
      const list = (query: Record<string, string>) =>
        request(h.app)
          .get('/dispatches')
          .query({ warehouse: h.fixtures.warehouseId, ...query });
      const all = ((await list({})).body as { items: unknown[] }).items.length;
      expect(all).toBeGreaterThan(0);
      const onTheDay = await list({ from: '2026-10-05', to: '2026-10-05' });
      expect((onTheDay.body as { items: unknown[] }).items).toHaveLength(all);
      const before = await list({ to: '2026-10-04' });
      expect((before.body as { items: unknown[] }).items).toEqual([]);
      const after = await list({ from: '2026-10-06' });
      expect((after.body as { items: unknown[] }).items).toEqual([]);
      expect((await list({ from: '5 Oct' })).status).toBe(400);
    });
  });

  describe('POST /warehouses/:id/dispatch-blocked', () => {
    const blocked = (overrides: Record<string, unknown> = {}) => {
      const now = h.clock.now().getTime();
      return request(h.app)
        .post(`/warehouses/${h.fixtures.warehouseId}/dispatch-blocked`)
        .send({
          id: randomUUID(),
          custodian_id: h.fixtures.custodianId,
          blocked_at: new Date(now - 3_600_000).toISOString(),
          offline_since: new Date(now - 3 * 3_600_000).toISOString(),
          ...overrides,
        });
    };

    it('records when, who and how long offline, and nothing about the farmer or goods', async () => {
      const res = await blocked();
      expect(res.status).toBe(201);
      const event = (res.body as { dispatch_blocked: Record<string, unknown> }).dispatch_blocked;
      expect(Object.keys(event).sort()).toEqual([
        'blocked_at',
        'custodian_id',
        'id',
        'offline_seconds',
        'offline_since',
        'warehouse_id',
      ]);
      expect(event.offline_seconds).toBe(2 * 3600);
    });

    it('accepts a tablet that never had a connection', async () => {
      const res = await blocked({ offline_since: undefined });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        dispatch_blocked: { offline_since: null, offline_seconds: null },
      });
    });

    it('is idempotent on id, and refuses a reused id with different content', async () => {
      const id = randomUUID();
      const blockedAt = new Date(h.clock.now().getTime() - 60_000).toISOString();
      expect((await blocked({ id, blocked_at: blockedAt })).status).toBe(201);
      const repeat = await blocked({ id, blocked_at: blockedAt });
      expect(repeat.status).toBe(200);
      expect(repeat.body).toMatchObject({ duplicate: true });
      const changed = await blocked({ id });
      expect(changed.status).toBe(409);
      expect((changed.body as ErrorBody).error.code).toBe('id_conflict');
      const { rows } = await h.pool.query('SELECT 1 FROM dispatch_blocked_events WHERE id = $1', [
        id,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('refuses a time in the future, or offline_since after blocked_at', async () => {
      const future = await blocked({
        blocked_at: new Date(h.clock.now().getTime() + 3_600_000).toISOString(),
      });
      expect(future.status).toBe(400);
      expect((future.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'captured_at_in_future', field: 'blocked_at' }),
      ]);
      const backwards = await blocked({
        offline_since: new Date(h.clock.now().getTime() - 60_000).toISOString(),
      });
      expect(backwards.status).toBe(400);
      expect((backwards.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ field: 'offline_since' }),
      ]);
    });

    it('counts blocked dispatches by business date, from every tablet at the warehouse', async () => {
      const { rows } = await h.pool.query<{ id: string }>(
        `INSERT INTO custodians (warehouse_id, full_name, phone)
         VALUES ($1, 'Second Custodian', '+2348000000099') RETURNING id`,
        [h.fixtures.warehouseId],
      );
      const now = h.clock.now().getTime();
      const yesterday = new Date(now - 24 * 3_600_000).toISOString();
      for (const custodianId of [h.fixtures.custodianId, rows[0]?.id]) {
        await blocked({
          custodian_id: custodianId,
          blocked_at: yesterday,
          offline_since: undefined,
        }).expect(201);
      }
      const count = async (warehouseId: string, query: Record<string, string>) => {
        const res = await request(h.app)
          .get(`/warehouses/${warehouseId}/dispatch-blocked`)
          .query(query);
        expect(res.status).toBe(200);
        return (res.body as { blocked: number }).blocked;
      };
      const day = (iso: string) => iso.slice(0, 10); // midday UTC: the same date in Lagos
      const today = day(h.clock.now().toISOString());
      expect(
        await count(h.fixtures.warehouseId, { from: day(yesterday), to: day(yesterday) }),
      ).toBe(2);
      const todays = await count(h.fixtures.warehouseId, { from: today, to: today });
      expect(todays).toBeGreaterThan(0);
      expect(await count(h.fixtures.warehouseId, { from: day(yesterday), to: today })).toBe(
        todays + 2,
      );
      expect(await count(h.fixtures.otherWarehouseId, {})).toBe(0);
      const bad = await request(h.app)
        .get(`/warehouses/${h.fixtures.warehouseId}/dispatch-blocked`)
        .query({ from: '11/10/2026' });
      expect(bad.status).toBe(400);
      await request(h.app).get(`/warehouses/${randomUUID()}/dispatch-blocked`).expect(404);
    });
  });
});
