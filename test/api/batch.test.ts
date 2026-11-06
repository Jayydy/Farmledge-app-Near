import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface BatchResponse {
  summary: { created: number; duplicate: number; rejected: number };
  results: {
    index: number;
    deposit_id: string | null;
    status: 'created' | 'duplicate' | 'rejected';
    deposit?: { deposit_id: string; captured_at: string };
    error?: { code: string; details?: { code: string; field: string }[] };
  }[];
}

describe('POST /deposits/batch', () => {
  let api: TestApi;
  let server: Server;

  beforeAll(async () => {
    api = await startTestApi();
    server = api.app.listen(0);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await api.close();
  });

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const item = (overrides: Record<string, unknown> = {}) =>
    depositBody(api.fixtures, { captured_at: hoursAgo(2), ...overrides });
  const batch = (items: unknown) => request(server).post('/deposits/batch').send({ items });
  const stored = async (ids: (string | undefined)[]) => {
    const { rows } = await api.pool.query<{ deposit_id: string }>(
      'SELECT deposit_id FROM deposits WHERE deposit_id = ANY($1)',
      [ids],
    );
    return rows.map((r) => r.deposit_id).sort();
  };

  it('processes each item independently and reports a result per item', async () => {
    const good = item();
    const alsoGood = item({ captured_at: hoursAgo(48) });
    const tooWet = item({ moisture_pct: 14 });
    const noCaptureTime = item();
    delete noCaptureTime.captured_at;
    const unknownFarmer = item({ farmer_id: randomUUID() });
    const reusedId = { ...good, bag_count: 99 };

    const res = await batch([good, tooWet, noCaptureTime, alsoGood, unknownFarmer, good, reusedId]);

    expect(res.status).toBe(200);
    const body = res.body as BatchResponse;
    expect(body.summary).toEqual({ created: 2, duplicate: 1, rejected: 4 });
    expect(body.results.map((r) => [r.index, r.deposit_id, r.status, r.error?.code])).toEqual([
      [0, good.deposit_id, 'created', undefined],
      [1, tooWet.deposit_id, 'rejected', 'validation_failed'],
      [2, noCaptureTime.deposit_id, 'rejected', 'validation_failed'],
      [3, alsoGood.deposit_id, 'created', undefined],
      [4, unknownFarmer.deposit_id, 'rejected', 'validation_failed'],
      [5, good.deposit_id, 'duplicate', undefined],
      [6, good.deposit_id, 'rejected', 'deposit_id_conflict'],
    ]);
    expect(body.results[1]?.error?.details?.map((d) => d.code)).toEqual(['moisture_out_of_range']);
    expect(body.results[2]?.error?.details).toEqual([
      expect.objectContaining({ code: 'required', field: 'captured_at' }),
    ]);
    expect(body.results[4]?.error?.details?.map((d) => d.code)).toEqual(['farmer_not_found']);
    expect(body.results[3]?.deposit?.captured_at).toBe(alsoGood.captured_at);

    expect(
      await stored([good, tooWet, noCaptureTime, alsoGood, unknownFarmer].map((d) => d.deposit_id)),
    ).toEqual([good.deposit_id, alsoGood.deposit_id].sort());
  });

  it('rejects items that are not objects without failing the batch', async () => {
    const good = item();
    const res = await batch([42, null, good]);
    const body = res.body as BatchResponse;
    expect(body.results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'created']);
    expect(body.results[0]?.deposit_id).toBeNull();
  });

  it('is idempotent when a whole batch is retried', async () => {
    const items = [item(), item({ grade: 7 }), item()];
    const first = (await batch(items)).body as BatchResponse;
    const retry = (await batch(items)).body as BatchResponse;

    expect(first.summary).toEqual({ created: 2, duplicate: 0, rejected: 1 });
    expect(retry.summary).toEqual({ created: 0, duplicate: 2, rejected: 1 });
    expect(retry.results[0]?.deposit).toEqual(first.results[0]?.deposit);
  });

  it('shares idempotency with single submissions, in both directions', async () => {
    const single = item();
    await request(server).post('/deposits').send(single).expect(201);
    const viaBatch = (await batch([single])).body as BatchResponse;
    expect(viaBatch.results[0]?.status).toBe('duplicate');

    const batched = item();
    await batch([batched]);
    const viaSingle = await request(server).post('/deposits').send(batched);
    expect(viaSingle.status).toBe(200);
    expect((viaSingle.body as { duplicate: boolean }).duplicate).toBe(true);

    expect(await stored([single.deposit_id, batched.deposit_id])).toHaveLength(2);
  });

  it('creates each deposit once when the same batch is sent concurrently', async () => {
    const items = Array.from({ length: 10 }, () => item());
    const responses = await Promise.all([batch(items), batch(items), batch(items)]);

    const totals = responses.map((r) => (r.body as BatchResponse).summary);
    expect(totals.reduce((sum, s) => sum + s.created, 0)).toBe(10);
    expect(totals.reduce((sum, s) => sum + s.duplicate, 0)).toBe(20);
    expect(await stored(items.map((i) => i.deposit_id))).toHaveLength(10);
  });

  it.each([
    ['empty', []],
    ['over 100 items', Array.from({ length: 101 }, () => ({}))],
  ])('rejects an %s batch', async (_label, items) => {
    const res = await batch(items);
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'invalid_batch_size', field: 'items' }),
    ]);
  });

  it('rejects a body without an items array', async () => {
    const res = await request(server).post('/deposits/batch').send({ deposits: [] });
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'required', field: 'items' }),
    ]);
  });

  it('rejects offline captures older than the window', async () => {
    const res = await batch([item({ captured_at: hoursAgo(31 * 24) })]);
    expect((res.body as BatchResponse).results[0]?.error?.details?.map((d) => d.code)).toEqual([
      'captured_at_too_old',
    ]);
  });
});
