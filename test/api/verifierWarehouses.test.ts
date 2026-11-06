import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../../src/services/auth.js';
import { depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

describe('verifiers are scoped to warehouses (D44)', () => {
  let api: TestApi;
  let outsiderId: string;

  beforeAll(async () => {
    api = await startTestApi();
    // An active verifier assigned only to the other warehouse.
    const { rows } = await api.pool.query<{ id: string }>(
      `INSERT INTO verifiers (full_name, phone) VALUES ('Other Verifier', '+2348000000088') RETURNING id`,
    );
    outsiderId = rows[0]?.id ?? '';
    await api.pool.query(
      'INSERT INTO verifier_warehouses (verifier_id, warehouse_id) VALUES ($1, $2)',
      [outsiderId, api.fixtures.otherWarehouseId],
    );
  });

  afterAll(async () => {
    await api.close();
  });

  it('refuses a deposit co-signed by a verifier not assigned to its warehouse', async () => {
    const res = await request(api.app)
      .post('/deposits')
      .send(depositBody(api.fixtures, { verifier_id: outsiderId }));
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'verifier_wrong_warehouse', field: 'verifier_id' }),
    ]);
  });

  it('refuses an audit by a verifier not assigned to the warehouse', async () => {
    const res = await request(api.app).post('/audits').send({
      warehouse_id: api.fixtures.warehouseId,
      conducted_by: outsiderId,
      counted_by: 'Musa Bello',
      witnessed_by: 'Hauwa Sani',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('verifier_wrong_warehouse');
  });

  it('refuses a verifier whose assignment was removed', async () => {
    await api.pool.query(
      `UPDATE verifier_warehouses SET status = 'removed', removed_at = now()
        WHERE verifier_id = $1 AND warehouse_id = $2`,
      [api.fixtures.verifierId, api.fixtures.otherWarehouseId],
    );
    const res = await request(api.app)
      .post('/deposits')
      .send(
        depositBody(api.fixtures, {
          warehouse_id: api.fixtures.otherWarehouseId,
          custodian_id: api.fixtures.otherCustodianId,
        }),
      );
    expect(JSON.stringify(res.body)).toContain('verifier_wrong_warehouse');
  });

  it('is enforced by the database too, not only the API', async () => {
    await expect(
      api.pool.query(
        `INSERT INTO deposits (deposit_id, farmer_id, warehouse_id, custodian_id, verifier_id,
                               commodity, grading_scheme, grade, moisture_bps, bag_count,
                               bag_count_confirmed, bag_size_kg, weight_source, intake_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'MAIZE_WHITE', 'provisional', '1', 1200,
                 5, false, 100, 'bag_estimate', now())`,
        [api.fixtures.farmerId, api.fixtures.warehouseId, api.fixtures.custodianId, outsiderId],
      ),
    ).rejects.toThrow(/deposits_verifier_at_warehouse/);
  });

  it('puts only the warehouse’s own verifiers on the sign-in roster', async () => {
    await new AuthService(api.pool, 168).setPin('+2348000000001', '482915');
    const res = await request(api.app)
      .post('/auth/sessions')
      .send({ phone: '+2348000000001', pin: '482915' });
    const roster = (res.body as { roster: { verifiers: { id: string }[] } }).roster.verifiers;
    expect(roster.map((v) => v.id)).toEqual([api.fixtures.verifierId]);
  });
});
