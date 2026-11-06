import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminService } from '../../src/services/admin.js';
import { startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

const NOW = new Date('2026-10-03T09:00:00.000Z');

interface OwnerResponse {
  owner: { id: string; warehouse_id: string; full_name: string; phone: string };
  assignment: {
    role: string;
    owner_id: string;
    warehouse_id: string;
    from_custodian_id: string | null;
    assigned_by: string;
    assigned_via: string;
    reason: string;
    assigned_at: string;
  };
}

describe('admin API: setting up warehouse owners', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi({ clock: () => NOW });
  });

  afterAll(async () => {
    await api.close();
  });

  const createOwner = (body: Record<string, unknown>) =>
    request(api.app)
      .post('/admin/warehouse-owners')
      .send({
        warehouse_id: api.fixtures.warehouseId,
        assigned_by: api.fixtures.adminId,
        reason: 'Signed trial agreement',
        ...body,
      });

  const countOwners = async (): Promise<number> => {
    const { rows } = await api.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM warehouse_owners',
    );
    return Number(rows[0]?.n);
  };
  const countAssignments = async (): Promise<number> => {
    const { rows } = await api.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM role_assignments',
    );
    return Number(rows[0]?.n);
  };

  it('lets an admin create an owner, logging who, when and why', async () => {
    const res = await createOwner({ full_name: '  Amina   Bello ', phone: '0803 555 0101' });
    expect(res.status).toBe(201);
    const body = res.body as OwnerResponse;
    expect(body.owner).toMatchObject({
      warehouse_id: api.fixtures.warehouseId,
      full_name: 'Amina Bello',
      phone: '+2348035550101',
    });
    expect(body.assignment).toEqual(
      expect.objectContaining({
        role: 'warehouse_owner',
        owner_id: body.owner.id,
        warehouse_id: api.fixtures.warehouseId,
        from_custodian_id: null,
        assigned_by: api.fixtures.adminId,
        assigned_via: 'admin_api',
        reason: 'Signed trial agreement',
        assigned_at: NOW.toISOString(),
      }),
    );

    // The new owner can act as owner straight away.
    await request(api.app)
      .post(`/warehouses/${api.fixtures.warehouseId}/shrinkage-tolerance`)
      .send({ tolerance_pct: 3, reason: 'Trial', set_by: body.owner.id })
      .expect(201);
  });

  it('lets an admin promote a custodian of the warehouse, recording where they came from', async () => {
    const { rows } = await api.pool.query<{ id: string }>(
      `INSERT INTO custodians (warehouse_id, full_name, phone)
       VALUES ($1, 'Senior Custodian', '+2348035550102') RETURNING id`,
      [api.fixtures.warehouseId],
    );
    const custodianId = rows[0]?.id;
    const res = await createOwner({ custodian_id: custodianId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      owner: { full_name: 'Senior Custodian', phone: '+2348035550102' },
      assignment: { from_custodian_id: custodianId, assigned_by: api.fixtures.adminId },
    });
  });

  it('refuses a custodian creating a warehouse owner', async () => {
    const [owners, assignments] = [await countOwners(), await countAssignments()];
    const res = await createOwner({
      assigned_by: api.fixtures.custodianId,
      full_name: 'Custodian Friend',
      phone: '0803 555 0103',
    });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error.code).toBe('admin_required');
    expect(await countOwners()).toBe(owners);
    expect(await countAssignments()).toBe(assignments);
  });

  it('refuses a custodian promoting another custodian to owner', async () => {
    const res = await createOwner({
      assigned_by: api.fixtures.custodianId,
      custodian_id: api.fixtures.otherCustodianId,
      warehouse_id: api.fixtures.otherWarehouseId,
    });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error.code).toBe('admin_required');
  });

  it('refuses a custodian changing their own role', async () => {
    const owners = await countOwners();
    const res = await createOwner({
      assigned_by: api.fixtures.custodianId,
      custodian_id: api.fixtures.custodianId,
    });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error.code).toBe('admin_required');
    expect(await countOwners()).toBe(owners);

    // Still a custodian: owner-only actions are still refused.
    const tolerance = await request(api.app)
      .post(`/warehouses/${api.fixtures.warehouseId}/shrinkage-tolerance`)
      .send({ tolerance_pct: 9, reason: 'Self-promoted', set_by: api.fixtures.custodianId });
    expect(tolerance.status).toBe(403);
    expect((tolerance.body as ErrorBody).error.code).toBe('owner_required');
  });

  it('refuses a warehouse owner or verifier creating another owner', async () => {
    for (const assignedBy of [api.fixtures.ownerId, api.fixtures.verifierId]) {
      const res = await createOwner({
        assigned_by: assignedBy,
        full_name: 'Second Owner',
        phone: '0803 555 0104',
      });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error.code).toBe('admin_required');
    }
  });

  it('rejects an unknown or suspended admin', async () => {
    const unknown = await createOwner({
      assigned_by: '00000000-0000-4000-8000-000000000000',
      full_name: 'Nobody Knows',
      phone: '0803 555 0105',
    });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('admin_not_found');

    const { admin } = await new AdminService(api.pool).createAdmin({
      fullName: 'Former Staff',
      phone: '0803 555 0106',
      reason: 'Temporary cover',
      operator: 'ops',
    });
    await api.pool.query(`UPDATE platform_admins SET status = 'suspended' WHERE id = $1`, [
      admin.id,
    ]);
    const suspended = await createOwner({
      assigned_by: admin.id,
      full_name: 'Late Owner',
      phone: '0803 555 0107',
    });
    expect(suspended.status).toBe(400);
    expect(JSON.stringify(suspended.body)).toContain('admin_suspended');
  });

  it('validates the request: one subject, a reason, a real phone', async () => {
    const both = await createOwner({
      custodian_id: api.fixtures.custodianId,
      full_name: 'Both Ways',
      phone: '0803 555 0108',
    });
    expect(both.status).toBe(400);
    expect(JSON.stringify(both.body)).toContain('invalid_owner_subject');

    const neither = await createOwner({});
    expect(JSON.stringify(neither.body)).toContain('invalid_owner_subject');

    const bad = await createOwner({ full_name: 'X', phone: '123', reason: ' ' });
    expect(bad.status).toBe(400);
    const codes = (bad.body as ErrorBody & { error: { details: { code: string }[] } }).error.details
      .map((detail) => detail.code)
      .sort();
    expect(codes).toEqual(['invalid_name', 'invalid_phone', 'reason_required']);

    const otherWarehouse = await createOwner({
      custodian_id: api.fixtures.otherCustodianId,
    });
    expect(JSON.stringify(otherWarehouse.body)).toContain('custodian_wrong_warehouse');
  });

  it('refuses a second owner with the same phone', async () => {
    const res = await createOwner({ full_name: 'Amina Again', phone: '+2348035550101' });
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error.code).toBe('owner_phone_taken');
  });

  it('has no endpoint for creating admins', async () => {
    const res = await request(api.app)
      .post('/admin/admins')
      .send({ full_name: 'Self Made', phone: '0803 555 0109', assigned_by: api.fixtures.adminId });
    expect(res.status).toBe(404);
  });
});

describe('creating admins from the CLI', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.close();
  });

  it('creates the admin and logs the operator and reason', async () => {
    const { admin, assignment } = await new AdminService(api.pool, () => NOW).createAdmin({
      fullName: 'Ops Lead',
      phone: '0803 555 0201',
      reason: 'First admin for the Kano trial',
      operator: 'deploy@farmledge',
    });
    expect(admin).toMatchObject({ full_name: 'Ops Lead', phone: '+2348035550201' });
    expect(assignment).toMatchObject({
      role: 'platform_admin',
      admin_id: admin.id,
      assigned_by: null,
      assigned_via: 'cli',
      operator: 'deploy@farmledge',
      reason: 'First admin for the Kano trial',
      assigned_at: NOW,
    });
  });

  it('requires an operator and a reason', async () => {
    await expect(
      new AdminService(api.pool).createAdmin({
        fullName: 'No Trail',
        phone: '0803 555 0202',
        reason: '',
        operator: ' ',
      }),
    ).rejects.toMatchObject({
      status: 400,
      details: [
        expect.objectContaining({ code: 'reason_required' }),
        expect.objectContaining({ field: 'operator' }),
      ],
    });
  });
});
