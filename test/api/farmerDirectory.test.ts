import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../../src/services/auth.js';
import { startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface DirectoryBody {
  items: { id: string; phone: string; full_name: string }[];
  next_cursor: string | null;
}

describe('GET /warehouses/:id/farmers (tablet lookup cache)', () => {
  let api: TestApi;
  let token: string;

  beforeAll(async () => {
    // Off: the directory needs a session whatever AUTH_REQUIRED says.
    api = await startTestApi({ env: { AUTH_REQUIRED: 'false' } });
    await new AuthService(api.pool, 168).setPin('+2348000000001', '482915');
    const res = await request(api.app)
      .post('/auth/sessions')
      .send({ phone: '+2348000000001', pin: '482915' });
    token = (res.body as { token: string }).token;

    for (let i = 0; i < 4; i++) {
      await request(api.app)
        .post('/farmers')
        .send({
          full_name: `Farmer ${i}`,
          phone: `0803000000${i}`,
          warehouse_id: api.fixtures.warehouseId,
          registered_by: api.fixtures.custodianId,
          consent: true,
        })
        .expect(201);
    }
    // At the other warehouse only: must never appear.
    await request(api.app)
      .post('/farmers')
      .send({
        full_name: 'Elsewhere',
        phone: '08039999999',
        warehouse_id: api.fixtures.otherWarehouseId,
        registered_by: api.fixtures.otherCustodianId,
        consent: true,
      })
      .expect(201);
  });

  afterAll(async () => {
    await api.close();
  });

  const list = (warehouseId: string, query = '') =>
    request(api.app)
      .get(`/warehouses/${warehouseId}/farmers${query}`)
      .auth(token, { type: 'bearer' });

  it('lists only that warehouse’s farmers, with id, phone and name only', async () => {
    const res = await list(api.fixtures.warehouseId);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as DirectoryBody;
    expect(body.items).toHaveLength(5); // the fixture farmer + 4
    expect(body.next_cursor).toBeNull();
    for (const item of body.items)
      expect(Object.keys(item).sort()).toEqual(['full_name', 'id', 'phone']);
    expect(body.items.map((item) => item.full_name)).not.toContain('Elsewhere');
  });

  it('pages by cursor', async () => {
    const first = (await list(api.fixtures.warehouseId, '?limit=3')).body as DirectoryBody;
    expect(first.items).toHaveLength(3);
    expect(first.next_cursor).toBe(first.items[2]?.id);
    const second = (
      await list(api.fixtures.warehouseId, `?limit=3&cursor=${first.next_cursor ?? ''}`)
    ).body as DirectoryBody;
    expect(second.items).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(5);
  });

  it('needs a session even when AUTH_REQUIRED is off', async () => {
    const res = await request(api.app).get(`/warehouses/${api.fixtures.warehouseId}/farmers`);
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.code).toBe('authentication_required');
  });

  it('refuses another warehouse’s directory', async () => {
    const res = await list(api.fixtures.otherWarehouseId);
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error.code).toBe('actor_mismatch');
    expect((await list(randomUUID())).status).toBe(403);
  });

  it('validates limit and cursor', async () => {
    expect((await list(api.fixtures.warehouseId, '?limit=5000')).status).toBe(400);
    expect((await list(api.fixtures.warehouseId, '?cursor=nope')).status).toBe(400);
  });
});
