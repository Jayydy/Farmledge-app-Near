import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface FarmerBody {
  farmer: {
    id: string;
    full_name: string;
    phone: string;
    lookup_consent: boolean;
    data_consent_at: string | null;
    warehouses: { warehouse_id: string; registered_by: string }[];
  };
  farmer_created: boolean;
}

describe('farmers API', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.close();
  });

  const register = (overrides: Record<string, unknown> = {}) =>
    request(api.app)
      .post('/farmers')
      .send({
        full_name: 'Aisha Bello',
        phone: '0803 123 4567',
        warehouse_id: api.fixtures.warehouseId,
        registered_by: api.fixtures.custodianId,
        consent: true,
        ...overrides,
      });

  it('registers a farmer with a normalised phone and recorded consent', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    const body = res.body as FarmerBody;
    expect(body.farmer_created).toBe(true);
    expect(body.farmer).toMatchObject({
      full_name: 'Aisha Bello',
      phone: '+2348031234567',
      lookup_consent: false,
      warehouses: [
        { warehouse_id: api.fixtures.warehouseId, registered_by: api.fixtures.custodianId },
      ],
    });
    expect(body.farmer.data_consent_at).not.toBeNull();
  });

  it('rejects a registration without consent, and stores nothing', async () => {
    const res = await register({ phone: '08030000001', consent: false });

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'consent_required', field: 'consent' }),
    ]);
    const { rowCount } = await api.pool.query(
      `SELECT 1 FROM farmers WHERE phone = '+2348030000001'`,
    );
    expect(rowCount).toBe(0);
  });

  it('rejects a missing consent flag as a shape error', async () => {
    const res = await register({ phone: '08030000002', consent: undefined });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      { code: 'required', field: 'consent', message: 'consent is required' },
    ]);
  });

  it('rejects the same phone twice at one warehouse, however it is written', async () => {
    const res = await register({ phone: '+234 803 123 4567', full_name: 'Someone Else' });

    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error.code).toBe('farmer_already_registered');
  });

  it('links an existing farmer to a second warehouse instead of duplicating them', async () => {
    const res = await register({
      warehouse_id: api.fixtures.otherWarehouseId,
      registered_by: api.fixtures.otherCustodianId,
    });

    expect(res.status).toBe(201);
    const body = res.body as FarmerBody;
    expect(body.farmer_created).toBe(false);
    expect(body.farmer.warehouses.map((w) => w.warehouse_id).sort()).toEqual(
      [api.fixtures.warehouseId, api.fixtures.otherWarehouseId].sort(),
    );
    const { rows } = await api.pool.query(
      `SELECT count(*)::int AS n FROM farmers WHERE phone = '+2348031234567'`,
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('records lookup consent with its date when given', async () => {
    const res = await register({ phone: '09012345678', lookup_consent: true });
    expect(res.status).toBe(201);
    const { rows } = await api.pool.query<{ consent_given_at: Date | null }>(
      `SELECT consent_given_at FROM farmers WHERE phone = '+2349012345678'`,
    );
    expect(rows[0]?.consent_given_at).toBeInstanceOf(Date);
  });

  it('reports every invalid field and reference together', async () => {
    const res = await register({
      full_name: 'A',
      phone: '12345',
      registered_by: api.fixtures.otherCustodianId,
    });

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'invalid_name' }),
      expect.objectContaining({ code: 'invalid_phone' }),
      expect.objectContaining({ code: 'custodian_wrong_warehouse', field: 'registered_by' }),
    ]);
  });

  it('rejects an unknown warehouse', async () => {
    const res = await register({
      phone: '08030000003',
      warehouse_id: '00000000-0000-4000-8000-000000000000',
    });
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'warehouse_not_found', field: 'warehouse_id' }),
    ]);
  });

  describe('GET /farmers?phone=', () => {
    it('finds a farmer by phone written any common way', async () => {
      for (const phone of ['08031234567', '+2348031234567', '234 803 123 4567']) {
        const res = await request(api.app).get('/farmers').query({ phone });
        expect(res.status).toBe(200);
        const items = (res.body as { items: { phone: string }[] }).items;
        expect(items.map((f) => f.phone)).toEqual(['+2348031234567']);
      }
    });

    it('returns an empty list for an unknown phone', async () => {
      const res = await request(api.app).get('/farmers').query({ phone: '08099999999' });
      expect(res.body).toEqual({ items: [] });
    });

    it('rejects a missing or invalid phone', async () => {
      const missing = await request(api.app).get('/farmers');
      expect((missing.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'required', field: 'phone' }),
      ]);
      const invalid = await request(api.app).get('/farmers').query({ phone: 'abc' });
      expect((invalid.body as ErrorBody).error.details).toEqual([
        expect.objectContaining({ code: 'invalid_phone' }),
      ]);
    });
  });
});
