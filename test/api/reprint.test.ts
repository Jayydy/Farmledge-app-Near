import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../../src/services/auth.js';
import { depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface SlipBody {
  deposit: { deposit_id: string; deposit_no: number };
  proofs: { qr_payload: string }[];
  printable: {
    warehouse: { code: string; name: string };
    farmer: { full_name: string; phone: string };
    custodian: { full_name: string };
    verifier: { full_name: string };
  };
}

describe('reprinting a slip from any tablet at the warehouse (D46)', () => {
  let api: TestApi;
  let token: string;
  let otherToken: string;
  let mine: string;
  let theirs: string;

  beforeAll(async () => {
    api = await startTestApi();
    const auth = new AuthService(api.pool, 168);
    await auth.setPin('+2348000000001', '482915');
    await auth.setPin('+2348000000002', '019283');
    const signIn = async (phone: string, pin: string) =>
      (
        (await request(api.app).post('/auth/sessions').send({ phone, pin })).body as {
          token: string;
        }
      ).token;
    token = await signIn('+2348000000001', '482915');
    otherToken = await signIn('+2348000000002', '019283');

    const body = depositBody(api.fixtures);
    await request(api.app).post('/deposits').auth(token, { type: 'bearer' }).send(body).expect(201);
    mine = body.deposit_id;
    // The same farmer, registered at the other warehouse too.
    await request(api.app)
      .post('/farmers')
      .send({
        full_name: 'Test Farmer',
        phone: '+2348000000004',
        warehouse_id: api.fixtures.otherWarehouseId,
        registered_by: api.fixtures.otherCustodianId,
        consent: true,
      })
      .expect(201);
    const other = depositBody(api.fixtures, {
      warehouse_id: api.fixtures.otherWarehouseId,
      custodian_id: api.fixtures.otherCustodianId,
    });
    await request(api.app).post('/deposits').send(other).expect(201);
    theirs = other.deposit_id;
  });

  afterAll(async () => {
    await api.close();
  });

  it('gives the names a slip prints, alongside the QR payload', async () => {
    const res = await request(api.app)
      .get(`/deposits/${mine}/slip`)
      .auth(token, { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const slip = res.body as SlipBody;
    expect(slip.printable).toEqual({
      warehouse: { code: 'KN-DAWANAU', name: 'Dawanau Test Store' },
      farmer: { full_name: 'Test Farmer', phone: '+2348000000004' },
      custodian: { full_name: 'Test Custodian' },
      verifier: { full_name: 'Test Verifier' },
    });
    expect(slip.proofs[0]?.qr_payload).toContain(mine);
  });

  it('finds a deposit by its number, within the signed-in warehouse', async () => {
    const slip = (
      await request(api.app).get(`/deposits/${mine}/slip`).auth(token, { type: 'bearer' })
    ).body as SlipBody;
    const res = await request(api.app)
      .get(`/deposits?deposit_no=${slip.deposit.deposit_no}`)
      .auth(token, { type: 'bearer' });
    expect(res.status).toBe(200);
    const ids = (res.body as { items: { deposit_id: string }[] }).items.map((d) => d.deposit_id);
    expect(ids).toEqual([mine]);
  });

  it('keeps another warehouse’s deposits out of reach of a session', async () => {
    for (const path of [`/deposits/${theirs}/slip`, `/deposits/${theirs}`]) {
      const res = await request(api.app).get(path).auth(token, { type: 'bearer' });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error.code).toBe('actor_mismatch');
    }
    const list = await request(api.app)
      .get(`/deposits?warehouse=${api.fixtures.otherWarehouseId}`)
      .auth(token, { type: 'bearer' });
    expect(list.status).toBe(403);
    const own = await request(api.app).get('/deposits').auth(otherToken, { type: 'bearer' });
    const ids = (own.body as { items: { deposit_id: string }[] }).items.map((d) => d.deposit_id);
    expect(ids).toEqual([theirs]);
  });

  it('rejects a deposit_no that is not a whole number', async () => {
    const res = await request(api.app).get('/deposits?deposit_no=abc');
    expect(res.status).toBe(400);
  });
});
