import type pg from 'pg';

import { readDatabaseEnvironment } from '../../src/db/environmentGuard.js';

/**
 * Sample records for tests. They are only ever loaded into throwaway test
 * databases; loadFixtures refuses any database not stamped `test`.
 */

export interface Fixtures {
  warehouseId: string;
  otherWarehouseId: string;
  custodianId: string;
  otherCustodianId: string;
  verifierId: string;
  /** Registered at `warehouseId` only. */
  farmerId: string;
  /** Owner of `warehouseId`. */
  ownerId: string;
  /** Owner of `otherWarehouseId`. */
  otherOwnerId: string;
  /** A Farmledge admin, who set up both owners. */
  adminId: string;
}

export async function loadFixtures(client: pg.ClientBase): Promise<Fixtures> {
  const environment = await readDatabaseEnvironment(client);
  if (environment !== 'test') {
    throw new Error(`Refusing to load fixtures into a ${environment ?? 'uninitialised'} database`);
  }

  const insert = async (sql: string, params: unknown[]): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(sql, params);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`fixture insert returned no id: ${sql}`);
    return id;
  };

  const warehouseSql = `INSERT INTO warehouses (code, name, state, lga)
                        VALUES ($1, $2, 'Kano', $3) RETURNING id`;
  const warehouseId = await insert(warehouseSql, ['KN-DAWANAU', 'Dawanau Test Store', 'Dala']);
  const otherWarehouseId = await insert(warehouseSql, ['KN-BICHI', 'Bichi Test Store', 'Bichi']);

  const custodianSql = `INSERT INTO custodians (warehouse_id, full_name, phone)
                        VALUES ($1, $2, $3) RETURNING id`;
  const custodianId = await insert(custodianSql, [warehouseId, 'Test Custodian', '+2348000000001']);
  const otherCustodianId = await insert(custodianSql, [
    otherWarehouseId,
    'Other Custodian',
    '+2348000000002',
  ]);

  const verifierId = await insert(
    `INSERT INTO verifiers (full_name, phone) VALUES ($1, $2) RETURNING id`,
    ['Test Verifier', '+2348000000003'],
  );

  // Assigned to both warehouses (D44); tests of an unassigned verifier make their own.
  for (const id of [warehouseId, otherWarehouseId]) {
    await client.query(
      'INSERT INTO verifier_warehouses (verifier_id, warehouse_id) VALUES ($1, $2)',
      [verifierId, id],
    );
  }

  const farmerId = await insert(
    `INSERT INTO farmers (full_name, phone, lookup_consent, consent_given_at, data_consent_at)
     VALUES ($1, $2, true, now(), now()) RETURNING id`,
    ['Test Farmer', '+2348000000004'],
  );
  await client.query(
    `INSERT INTO farmer_warehouses (farmer_id, warehouse_id, registered_by) VALUES ($1, $2, $3)`,
    [farmerId, warehouseId, custodianId],
  );

  // Admins and owners need their role assignment logged in the same
  // transaction, so each is inserted with it in one statement.
  const adminId = await insert(
    `WITH admin AS (
       INSERT INTO platform_admins (full_name, phone) VALUES ($1, $2) RETURNING id
     ), logged AS (
       INSERT INTO role_assignments (role, admin_id, assigned_via, operator, reason, assigned_at)
       SELECT 'platform_admin', id, 'cli', 'fixtures', 'Test admin', now() FROM admin
     )
     SELECT id FROM admin`,
    ['Test Admin', '+2348000000007'],
  );
  const ownerSql = `WITH owner AS (
                      INSERT INTO warehouse_owners (warehouse_id, full_name, phone)
                      VALUES ($1, $2, $3) RETURNING id, warehouse_id
                    ), logged AS (
                      INSERT INTO role_assignments (role, owner_id, warehouse_id, assigned_by,
                                                    assigned_via, reason, assigned_at)
                      SELECT 'warehouse_owner', id, warehouse_id, $4, 'admin_api',
                             'Test owner', now() FROM owner
                    )
                    SELECT id FROM owner`;
  const ownerId = await insert(ownerSql, [warehouseId, 'Test Owner', '+2348000000005', adminId]);
  const otherOwnerId = await insert(ownerSql, [
    otherWarehouseId,
    'Other Owner',
    '+2348000000006',
    adminId,
  ]);

  return {
    warehouseId,
    otherWarehouseId,
    custodianId,
    otherCustodianId,
    verifierId,
    farmerId,
    ownerId,
    otherOwnerId,
    adminId,
  };
}

export interface DepositInput {
  depositId: string;
  bagCount?: number;
  bagSizeKg?: number;
  weightSource?: string;
  custodianId?: string;
}

export async function insertDeposit(
  client: pg.ClientBase,
  fixtures: Fixtures,
  input: DepositInput,
): Promise<{ estimated_weight_kg: string; environment: string; status: string }> {
  const { rows } = await client.query<{
    estimated_weight_kg: string;
    environment: string;
    status: string;
  }>(
    `INSERT INTO deposits (deposit_id, farmer_id, warehouse_id, custodian_id, verifier_id,
                           commodity, grading_scheme, grade, moisture_bps, bag_count,
                           bag_size_kg, weight_source, intake_at)
     VALUES ($1, $2, $3, $4, $5, 'MAIZE_WHITE', 'provisional', '1', 1250, $6, $7, $8, now())
     RETURNING estimated_weight_kg, environment, status`,
    [
      input.depositId,
      fixtures.farmerId,
      fixtures.warehouseId,
      input.custodianId ?? fixtures.custodianId,
      fixtures.verifierId,
      input.bagCount ?? 20,
      input.bagSizeKg ?? 100,
      input.weightSource ?? 'bag_estimate',
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('deposit insert returned no row');
  return row;
}
