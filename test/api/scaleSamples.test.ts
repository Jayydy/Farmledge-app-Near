import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

describe('scale samples API', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.close();
  });

  const createDeposit = async (overrides: Record<string, unknown> = {}) => {
    const body = depositBody(api.fixtures, overrides);
    await request(api.app).post('/deposits').send(body).expect(201);
    return body.deposit_id;
  };
  const addSample = (depositId: string, body: Record<string, unknown>) =>
    request(api.app)
      .post(`/deposits/${depositId}/scale-samples`)
      .send({ recorded_by: api.fixtures.custodianId, ...body });

  it('stores a sample and never changes the deposit’s weight', async () => {
    const depositId = await createDeposit({ bag_count: 10 });

    const res = await addSample(depositId, { bags_weighed: 3, total_kg: 285.4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      scale_sample: {
        deposit_id: depositId,
        bags_weighed: 3,
        total_kg: 285.4,
        kg_per_bag: 95.13,
        recorded_by: api.fixtures.custodianId,
      },
    });

    await addSample(depositId, { bags_weighed: 7, total_kg: 650 }).expect(201);

    const deposit = await request(api.app).get(`/deposits/${depositId}`);
    expect(deposit.body).toMatchObject({
      deposit: {
        weight_kg: 1000,
        weight_source: 'bag_estimate',
        scale_samples: { count: 2, bags_weighed: 10, total_kg: 935.4 },
      },
    });
    const { rows } = await api.pool.query(
      'SELECT estimated_weight_kg, bag_count FROM deposits WHERE deposit_id = $1',
      [depositId],
    );
    expect(rows).toEqual([{ estimated_weight_kg: '1000', bag_count: 10 }]);
  });

  it('refuses samples covering more bags than the deposit has', async () => {
    const depositId = await createDeposit({ bag_count: 5 });
    await addSample(depositId, { bags_weighed: 4, total_kg: 400 }).expect(201);

    const res = await addSample(depositId, { bags_weighed: 2, total_kg: 200 });
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: 'scale_samples_exceed_bags',
      details: { bag_count: 5, bags_already_weighed: 4 },
    });
  });

  describe('sample_id (idempotency)', () => {
    it('answers a repeat with the stored sample, even when it covered the last bags', async () => {
      const depositId = await createDeposit({ bag_count: 4 });
      const sample = { sample_id: randomUUID(), bags_weighed: 4, total_kg: 396.2 };

      const first = await addSample(depositId, sample);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        duplicate: false,
        scale_sample: { sample_id: sample.sample_id, bags_weighed: 4 },
      });

      const repeat = await addSample(depositId, {
        ...sample,
        sample_id: sample.sample_id.toUpperCase(),
      });
      expect(repeat.status).toBe(200);
      expect(repeat.body).toEqual({ ...(first.body as object), duplicate: true });

      const { rows } = await api.pool.query('SELECT 1 FROM scale_samples WHERE deposit_id = $1', [
        depositId,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('stores concurrent repeats once', async () => {
      const depositId = await createDeposit({ bag_count: 10 });
      const sample = { sample_id: randomUUID(), bags_weighed: 2, total_kg: 200 };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => addSample(depositId, sample)),
      );
      expect(results.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 201]);
      const { rows } = await api.pool.query('SELECT 1 FROM scale_samples WHERE sample_id = $1', [
        sample.sample_id,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('refuses the same sample_id with different content', async () => {
      const depositId = await createDeposit({ bag_count: 10 });
      const sampleId = randomUUID();
      await addSample(depositId, { sample_id: sampleId, bags_weighed: 2, total_kg: 200 }).expect(
        201,
      );

      const res = await addSample(depositId, {
        sample_id: sampleId,
        bags_weighed: 3,
        total_kg: 200,
      });
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toMatchObject({
        code: 'sample_id_conflict',
        details: { differing_fields: ['bags_weighed'] },
      });
    });

    it('rejects a sample_id that is not a UUID', async () => {
      const depositId = await createDeposit();
      const res = await addSample(depositId, { sample_id: 'abc', bags_weighed: 1, total_kg: 99 });
      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'invalid_sample_id', field: 'sample_id' }),
      ]);
    });

    it('stays optional', async () => {
      const depositId = await createDeposit();
      const res = await addSample(depositId, { bags_weighed: 1, total_kg: 99 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ duplicate: false, scale_sample: { sample_id: null } });
    });
  });

  it('checks concurrent samples one at a time', async () => {
    const depositId = await createDeposit({ bag_count: 5 });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => addSample(depositId, { bags_weighed: 2, total_kg: 200 })),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409]);
  });

  it('validates the sample and who recorded it', async () => {
    const depositId = await createDeposit();

    const bad = await addSample(depositId, { bags_weighed: 0, total_kg: 1.234 });
    expect(
      ((bad.body as ErrorBody).error.details as { code: string }[]).map((d) => d.code),
    ).toEqual(['invalid_bags_weighed', 'invalid_kg']);

    const wrongCustodian = await addSample(depositId, {
      bags_weighed: 1,
      total_kg: 100,
      recorded_by: api.fixtures.otherCustodianId,
    });
    expect((wrongCustodian.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'custodian_wrong_warehouse', field: 'recorded_by' }),
    ]);
  });

  it('returns 404 for an unknown deposit', async () => {
    const res = await addSample(randomUUID(), { bags_weighed: 1, total_kg: 100 });
    expect(res.status).toBe(404);
  });

  describe('GET /warehouses/:id/scale-summary', () => {
    let from: string;

    beforeAll(async () => {
      from = new Date().toISOString();
      const white = await createDeposit({ bag_count: 20 });
      const yellow = await createDeposit({ bag_count: 20, commodity: 'MAIZE_YELLOW' });
      await addSample(white, { bags_weighed: 4, total_kg: 392.2 }).expect(201);
      await addSample(white, { bags_weighed: 6, total_kg: 593.3 }).expect(201);
      await addSample(yellow, { bags_weighed: 5, total_kg: 520 }).expect(201);
    });

    it('averages measured kg per bag against the bag size assumed at intake', async () => {
      const res = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/scale-summary`)
        .query({ commodity: 'MAIZE_WHITE', from });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        warehouse_id: api.fixtures.warehouseId,
        sample_count: 2,
        bags_weighed: 10,
        total_kg: 985.5,
        avg_kg_per_bag: 98.55,
        nominal_kg_per_bag: 100,
        variance_kg_per_bag: -1.45,
        variance_pct: -1.45,
      });
    });

    it('covers all commodities by default and respects the date range', async () => {
      const all = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/scale-summary`)
        .query({ from });
      expect(all.body).toMatchObject({ sample_count: 3, bags_weighed: 15, total_kg: 1505.5 });

      const none = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/scale-summary`)
        .query({ to: '2020-01-01' });
      expect(none.body).toMatchObject({ sample_count: 0, avg_kg_per_bag: null });
    });

    it('returns an empty summary for a warehouse with no samples', async () => {
      const res = await request(api.app).get(
        `/warehouses/${api.fixtures.otherWarehouseId}/scale-summary`,
      );
      expect(res.body).toMatchObject({ sample_count: 0, bags_weighed: 0, variance_pct: null });
    });

    it('returns 404 for an unknown warehouse and 400 for a bad filter', async () => {
      await request(api.app).get(`/warehouses/${randomUUID()}/scale-summary`).expect(404);
      await request(api.app).get('/warehouses/nope/scale-summary').expect(404);
      const bad = await request(api.app)
        .get(`/warehouses/${api.fixtures.warehouseId}/scale-summary`)
        .query({ commodity: 'RICE', from: 'soon' });
      expect(bad.status).toBe(400);
    });
  });
});
