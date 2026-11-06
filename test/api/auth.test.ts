import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../../src/services/auth.js';
import { depositBody, dispatchBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface SignInBody {
  token: string;
  session: { id: string; expires_at: string };
  custodian: { id: string; full_name: string; phone: string };
  warehouse: { id: string; code: string; name: string };
  roster: { verifiers: { id: string; full_name: string }[] };
}

const PIN = '482915';
const CUSTODIAN_PHONE = '+2348000000001';
const OTHER_PHONE = '+2348000000002';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('staff sign-in (AUTH_REQUIRED=true)', () => {
  let api: TestApi;
  let now = new Date();

  beforeAll(async () => {
    api = await startTestApi({ env: { AUTH_REQUIRED: 'true' }, clock: () => now });
    const auth = new AuthService(api.pool, 168);
    await auth.setPin(CUSTODIAN_PHONE, PIN);
    await auth.setPin(OTHER_PHONE, '019283');
  });

  afterAll(async () => {
    await api.close();
  });

  const signIn = (phone = CUSTODIAN_PHONE, pin = PIN) =>
    request(api.app).post('/auth/sessions').send({ phone, pin });

  const tokenFor = async (phone = CUSTODIAN_PHONE, pin = PIN) => {
    const res = await signIn(phone, pin);
    expect(res.status).toBe(201);
    return (res.body as SignInBody).token;
  };

  it('signs in with phone and PIN, returning a token, the warehouse and the verifier roster', async () => {
    const res = await signIn('0800 000 0001');

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as SignInBody;
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.custodian).toEqual({
      id: api.fixtures.custodianId,
      full_name: 'Test Custodian',
      phone: CUSTODIAN_PHONE,
    });
    expect(body.warehouse).toMatchObject({ id: api.fixtures.warehouseId, code: 'KN-DAWANAU' });
    expect(body.roster.verifiers).toEqual([
      { id: api.fixtures.verifierId, full_name: 'Test Verifier' },
    ]);
    expect(new Date(body.session.expires_at).getTime() - now.getTime()).toBe(168 * 3600_000);

    const { rows } = await api.pool.query<{ token_sha256: Buffer }>(
      'SELECT token_sha256 FROM staff_sessions WHERE id = $1',
      [body.session.id],
    );
    expect(rows[0]?.token_sha256.toString('utf8')).not.toContain(body.token);
  });

  it.each([
    ['a wrong PIN', CUSTODIAN_PHONE, '111112'],
    ['an unknown phone', '+2348099999999', PIN],
    ['a malformed phone', 'not a phone', PIN],
  ])('answers %s with the same 401', async (_case, phone, pin) => {
    const res = await signIn(phone, pin);
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.code).toBe('invalid_credentials');
  });

  it('refuses a suspended custodian with the same 401', async () => {
    await api.pool.query(`UPDATE custodians SET status = 'suspended' WHERE phone = $1`, [
      OTHER_PHONE,
    ]);
    try {
      const res = await signIn(OTHER_PHONE, '019283');
      expect(res.status).toBe(401);
      expect((res.body as ErrorBody).error.code).toBe('invalid_credentials');
    } finally {
      await api.pool.query(`UPDATE custodians SET status = 'active' WHERE phone = $1`, [
        OTHER_PHONE,
      ]);
    }
  });

  it('locks a custodian out after five wrong PINs, then lets them back after 15 minutes', async () => {
    for (let i = 0; i < 5; i++) expect((await signIn(OTHER_PHONE, '555551')).status).toBe(401);

    const locked = await signIn(OTHER_PHONE, '019283');
    expect(locked.status).toBe(429);
    expect((locked.body as ErrorBody).error.code).toBe('too_many_attempts');
    expect(Number(locked.headers['retry-after'])).toBe(15 * 60);

    now = new Date(now.getTime() + 15 * 60_000 + 1);
    expect((await signIn(OTHER_PHONE, '019283')).status).toBe(201);
  });

  describe('intake routes', () => {
    it('need a session', async () => {
      const id = randomUUID();
      const cases = [
        request(api.app).post('/deposits').send(depositBody(api.fixtures)),
        request(api.app).post('/deposits/batch').send({ items: [] }),
        request(api.app).get('/farmers?phone=08031234567'),
        request(api.app).post('/farmers').send({}),
        request(api.app).get(`/deposits/${id}`),
        request(api.app).get(`/deposits/${id}/slip`),
        request(api.app).post(`/deposits/${id}/scale-samples`).send({}),
        request(api.app).post(`/deposits/${id}/photos`).type('image/jpeg').send(JPEG),
      ];
      for (const res of await Promise.all(cases)) {
        expect(res.status).toBe(401);
        expect((res.body as ErrorBody).error.code).toBe('authentication_required');
      }
    });

    it('leave other routes alone', async () => {
      expect((await request(api.app).get('/features')).status).toBe(200);
      expect((await request(api.app).get('/health')).status).toBe(200);
    });

    it('accept a deposit, scale sample and photo by the signed-in custodian', async () => {
      const token = await tokenFor();
      const body = depositBody(api.fixtures);
      const deposit = await request(api.app)
        .post('/deposits')
        .auth(token, { type: 'bearer' })
        .send(body);
      expect(deposit.status).toBe(201);

      const sample = await request(api.app)
        .post(`/deposits/${body.deposit_id}/scale-samples`)
        .auth(token, { type: 'bearer' })
        .send({ bags_weighed: 2, total_kg: 198.5, recorded_by: api.fixtures.custodianId });
      expect(sample.status).toBe(201);

      const photo = await request(api.app)
        .post(`/deposits/${body.deposit_id}/photos?uploaded_by=${api.fixtures.custodianId}`)
        .auth(token, { type: 'bearer' })
        .type('image/jpeg')
        .send(JPEG);
      expect(photo.status).toBe(201);
    });

    it('refuse a body naming another custodian or warehouse', async () => {
      const token = await tokenFor();
      const res = await request(api.app)
        .post('/deposits')
        .auth(token, { type: 'bearer' })
        .send(
          depositBody(api.fixtures, {
            custodian_id: api.fixtures.otherCustodianId,
            warehouse_id: api.fixtures.otherWarehouseId,
          }),
        );
      expect(res.status).toBe(403);
      const error = (res.body as ErrorBody).error;
      expect(error.code).toBe('actor_mismatch');
      expect(error.details).toEqual([
        expect.objectContaining({ field: 'custodian_id' }),
        expect.objectContaining({ field: 'warehouse_id' }),
      ]);

      const farmer = await request(api.app).post('/farmers').auth(token, { type: 'bearer' }).send({
        full_name: 'Musa Bello',
        phone: '08035550000',
        warehouse_id: api.fixtures.warehouseId,
        registered_by: api.fixtures.otherCustodianId,
        consent: true,
      });
      expect(farmer.status).toBe(403);
    });

    it('reject only the batch items naming someone else', async () => {
      const token = await tokenFor();
      const capturedAt = now.toISOString();
      const mine = depositBody(api.fixtures, { captured_at: capturedAt });
      const theirs = depositBody(api.fixtures, {
        captured_at: capturedAt,
        custodian_id: api.fixtures.otherCustodianId,
      });
      const res = await request(api.app)
        .post('/deposits/batch')
        .auth(token, { type: 'bearer' })
        .send({ items: [mine, theirs] });
      expect(res.status).toBe(200);
      const body = res.body as {
        summary: Record<string, number>;
        results: { status: string; error?: { code: string } }[];
      };
      expect(body.summary).toEqual({ created: 1, duplicate: 0, rejected: 1 });
      expect(body.results[1]).toMatchObject({
        status: 'rejected',
        error: { code: 'actor_mismatch' },
      });
    });
  });

  describe('dispatch and farmer balance routes', () => {
    let token: string;
    let dispatchId: string;
    const bearer = () => ({ Authorization: `Bearer ${token}` });

    beforeAll(async () => {
      token = await tokenFor();
      await request(api.app)
        .post('/deposits')
        .set(bearer())
        .send(depositBody(api.fixtures))
        .expect(201);
      const dispatch = dispatchBody(api.fixtures, { bag_count: 1 });
      await request(api.app).post('/dispatches').set(bearer()).send(dispatch).expect(201);
      dispatchId = dispatch.dispatch_id;
    });

    const expectSignInFirst = (res: request.Response) => {
      expect(res.status).toBe(401);
      expect((res.body as ErrorBody).error.code).toBe('authentication_required');
    };

    it('POST /dispatches needs a session', async () => {
      const body = dispatchBody(api.fixtures, { bag_count: 1 });
      expectSignInFirst(await request(api.app).post('/dispatches').send(body));
      expect((await request(api.app).post('/dispatches').set(bearer()).send(body)).status).toBe(
        201,
      );
    });

    it('GET /dispatches needs a session', async () => {
      const path = `/dispatches?warehouse=${api.fixtures.warehouseId}`;
      expectSignInFirst(await request(api.app).get(path));
      expect((await request(api.app).get(path).set(bearer())).status).toBe(200);
    });

    it('GET /dispatches/:id needs a session', async () => {
      const path = `/dispatches/${dispatchId}`;
      expectSignInFirst(await request(api.app).get(path));
      expect((await request(api.app).get(path).set(bearer())).status).toBe(200);
    });

    it('GET /dispatches/:id/delivery-note needs a session', async () => {
      const path = `/dispatches/${dispatchId}/delivery-note`;
      expectSignInFirst(await request(api.app).get(path));
      expect((await request(api.app).get(path).set(bearer())).status).toBe(200);
    });

    it('GET /farmers/:id/balance needs a session', async () => {
      const path = `/farmers/${api.fixtures.farmerId}/balance`;
      expectSignInFirst(await request(api.app).get(path));
      expect((await request(api.app).get(path).set(bearer())).status).toBe(200);
    });

    it('GET /farmers/:id/statement needs a session', async () => {
      const path = `/farmers/${api.fixtures.farmerId}/statement?warehouse=${api.fixtures.warehouseId}`;
      expectSignInFirst(await request(api.app).get(path));
      expect((await request(api.app).get(path).set(bearer())).status).toBe(200);
    });

    it('GET /farmers/:id/lots needs a session', async () => {
      const path = `/farmers/${api.fixtures.farmerId}/lots?warehouse=${api.fixtures.warehouseId}`;
      expectSignInFirst(await request(api.app).get(path));
      expect((await request(api.app).get(path).set(bearer())).status).toBe(200);
    });

    const planBody = (overrides: Record<string, unknown> = {}) => ({
      warehouse_id: api.fixtures.warehouseId,
      farmer_id: api.fixtures.farmerId,
      custodian_id: api.fixtures.custodianId,
      commodity: 'MAIZE_WHITE',
      grade: '1',
      bag_count: 1,
      ...overrides,
    });

    it('POST /dispatches/plan needs a session, by the signed-in custodian', async () => {
      expectSignInFirst(await request(api.app).post('/dispatches/plan').send(planBody()));
      const ok = await request(api.app).post('/dispatches/plan').set(bearer()).send(planBody());
      expect(ok.status).toBe(200);
      const theirs = await request(api.app)
        .post('/dispatches/plan')
        .set(bearer())
        .send(planBody({ custodian_id: api.fixtures.otherCustodianId }));
      expect(theirs.status).toBe(403);
      expect((theirs.body as ErrorBody).error.code).toBe('actor_mismatch');
    });

    it('POST /warehouses/:id/dispatch-blocked needs a session, by the signed-in custodian', async () => {
      const blocked = (warehouseId: string, overrides: Record<string, unknown> = {}) => ({
        path: `/warehouses/${warehouseId}/dispatch-blocked`,
        body: {
          id: randomUUID(),
          custodian_id: api.fixtures.custodianId,
          blocked_at: now.toISOString(),
          ...overrides,
        },
      });
      const mine = blocked(api.fixtures.warehouseId);
      expectSignInFirst(await request(api.app).post(mine.path).send(mine.body));
      expect((await request(api.app).post(mine.path).set(bearer()).send(mine.body)).status).toBe(
        201,
      );
      for (const theirs of [
        blocked(api.fixtures.otherWarehouseId),
        blocked(api.fixtures.warehouseId, { custodian_id: api.fixtures.otherCustodianId }),
      ]) {
        const res = await request(api.app).post(theirs.path).set(bearer()).send(theirs.body);
        expect(res.status).toBe(403);
        expect((res.body as ErrorBody).error.code).toBe('actor_mismatch');
      }
    });

    it('refuse a dispatch naming another custodian or warehouse, and release nothing', async () => {
      const body = dispatchBody(api.fixtures, {
        bag_count: 1,
        custodian_id: api.fixtures.otherCustodianId,
        warehouse_id: api.fixtures.otherWarehouseId,
      });
      const res = await request(api.app).post('/dispatches').set(bearer()).send(body);
      expect(res.status).toBe(403);
      const error = (res.body as ErrorBody).error;
      expect(error.code).toBe('actor_mismatch');
      expect(error.details).toEqual([
        expect.objectContaining({ field: 'custodian_id' }),
        expect.objectContaining({ field: 'warehouse_id' }),
      ]);
      const { rowCount } = await api.pool.query('SELECT 1 FROM dispatches WHERE id = $1', [
        body.dispatch_id,
      ]);
      expect(rowCount).toBe(0);
    });
  });

  describe('stock audit and daily summary routes', () => {
    let token: string;
    const bearer = () => ({ Authorization: `Bearer ${token}` });
    const auditBody = (overrides: Record<string, unknown> = {}) => ({
      warehouse_id: api.fixtures.warehouseId,
      entered_by: api.fixtures.custodianId,
      counted_by: 'Musa Bello',
      witnessed_by: 'Hauwa Sani',
      ...overrides,
    });
    const expectSignInFirst = (res: request.Response) => {
      expect(res.status).toBe(401);
      expect((res.body as ErrorBody).error.code).toBe('authentication_required');
    };

    beforeAll(async () => {
      token = await tokenFor();
    });

    it('need a session', async () => {
      const id = randomUUID();
      const warehouse = api.fixtures.warehouseId;
      const cases = [
        request(api.app).post('/audits').send(auditBody()),
        request(api.app).post(`/audits/${id}/lines`).send({}),
        request(api.app).post(`/audits/${id}/complete`),
        request(api.app).get(`/audits/${id}/report`),
        request(api.app).get(`/deposits?warehouse=${warehouse}`),
        request(api.app).get(`/warehouses/${warehouse}/stock`),
        request(api.app).get(`/warehouses/${warehouse}/dispatch-blocked`),
      ];
      for (const res of await Promise.all(cases)) expectSignInFirst(res);
    });

    it('run an audit entered by the signed-in custodian, at their warehouse only', async () => {
      const started = await request(api.app).post('/audits').set(bearer()).send(auditBody());
      expect(started.status).toBe(201);
      const auditId = (started.body as { audit: { id: string } }).audit.id;
      await request(api.app)
        .post(`/audits/${auditId}/lines`)
        .set(bearer())
        .send({ commodity: 'MAIZE_WHITE', grade: 1, counted_bags: 0 })
        .expect(201);
      await request(api.app).get(`/audits/${auditId}/report`).set(bearer()).expect(200);

      // Another warehouse's custodian can't see or touch it.
      const other = { Authorization: `Bearer ${await tokenFor(OTHER_PHONE, '019283')}` };
      await request(api.app).get(`/audits/${auditId}/report`).set(other).expect(404);
      await request(api.app).post(`/audits/${auditId}/complete`).set(other).expect(404);
      await request(api.app).post(`/audits/${auditId}/complete`).set(bearer()).expect(200);
    });

    it('refuse an audit entered for someone else, or by a verifier alone', async () => {
      for (const body of [
        auditBody({ entered_by: api.fixtures.otherCustodianId }),
        auditBody({ warehouse_id: api.fixtures.otherWarehouseId }),
        auditBody({ entered_by: undefined, conducted_by: api.fixtures.verifierId }),
      ]) {
        const res = await request(api.app).post('/audits').set(bearer()).send(body);
        expect(res.status).toBe(403);
        expect((res.body as ErrorBody).error.code).toBe('actor_mismatch');
      }
    });

    it('read stock and blocked dispatches at the session warehouse only', async () => {
      for (const path of ['stock', 'dispatch-blocked']) {
        await request(api.app)
          .get(`/warehouses/${api.fixtures.warehouseId}/${path}`)
          .set(bearer())
          .expect(200);
        const res = await request(api.app)
          .get(`/warehouses/${api.fixtures.otherWarehouseId}/${path}`)
          .set(bearer());
        expect(res.status).toBe(403);
        expect((res.body as ErrorBody).error.code).toBe('actor_mismatch');
      }
    });
  });

  describe('sessions', () => {
    it('report themselves with a fresh roster', async () => {
      const token = await tokenFor();
      const res = await request(api.app)
        .get('/auth/sessions/current')
        .auth(token, { type: 'bearer' });
      expect(res.status).toBe(200);
      expect((res.body as SignInBody).custodian.id).toBe(api.fixtures.custodianId);
      expect(res.body).not.toHaveProperty('token');
    });

    it('end on sign-out', async () => {
      const token = await tokenFor();
      const out = await request(api.app)
        .delete('/auth/sessions/current')
        .auth(token, { type: 'bearer' });
      expect(out.status).toBe(204);

      const after = await request(api.app).get('/features').auth(token, { type: 'bearer' });
      expect(after.status).toBe(401);
      expect((after.body as ErrorBody).error.code).toBe('session_invalid');
    });

    it('end when they expire', async () => {
      const token = await tokenFor();
      const signedInAt = now;
      now = new Date(signedInAt.getTime() + 168 * 3600_000 + 1);
      try {
        const res = await request(api.app)
          .get('/auth/sessions/current')
          .auth(token, { type: 'bearer' });
        expect(res.status).toBe(401);
      } finally {
        now = signedInAt;
      }
    });

    it('end when the custodian is suspended', async () => {
      const token = await tokenFor();
      await api.pool.query(`UPDATE custodians SET status = 'suspended' WHERE id = $1`, [
        api.fixtures.custodianId,
      ]);
      try {
        const res = await request(api.app)
          .get('/auth/sessions/current')
          .auth(token, { type: 'bearer' });
        expect(res.status).toBe(401);
      } finally {
        await api.pool.query(`UPDATE custodians SET status = 'active' WHERE id = $1`, [
          api.fixtures.custodianId,
        ]);
      }
    });

    it('refuse a made-up token', async () => {
      const res = await request(api.app)
        .get('/features')
        .set('Authorization', `Bearer ${'x'.repeat(43)}`);
      expect(res.status).toBe(401);
    });
  });
});

describe('staff sign-in (AUTH_REQUIRED=false)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.close();
  });

  it('still trusts the named custodian when no token is sent', async () => {
    const res = await request(api.app).post('/deposits').send(depositBody(api.fixtures));
    expect(res.status).toBe(201);
  });

  it('still checks the actor when a token is sent', async () => {
    await new AuthService(api.pool, 168).setPin(CUSTODIAN_PHONE, PIN);
    const signIn = await request(api.app)
      .post('/auth/sessions')
      .send({ phone: CUSTODIAN_PHONE, pin: PIN });
    const res = await request(api.app)
      .post('/deposits')
      .auth((signIn.body as SignInBody).token, { type: 'bearer' })
      .send(depositBody(api.fixtures, { custodian_id: api.fixtures.otherCustodianId }));
    expect(res.status).toBe(403);
  });

  it('still checks the dispatch actor when a token is sent', async () => {
    const signIn = await request(api.app)
      .post('/auth/sessions')
      .send({ phone: CUSTODIAN_PHONE, pin: PIN });
    const res = await request(api.app)
      .post('/dispatches')
      .auth((signIn.body as SignInBody).token, { type: 'bearer' })
      .send(dispatchBody(api.fixtures, { custodian_id: api.fixtures.otherCustodianId }));
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error.code).toBe('actor_mismatch');
  });
});
