import type { Queryable } from '../db/pool.js';
import { domainError, type DomainError } from '../domain/errors.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';

interface Ref {
  readonly id: string;
  /** API field the ID came from, used in error messages. */
  readonly field: string;
}

export interface ReferenceCheck {
  readonly warehouse?: Ref & { readonly mustBeActive: boolean };
  /** Must be active and, when `warehouse` is given, work there. */
  readonly custodian?: Ref;
  /** Must be active and, when `warehouse` is given, assigned there (D44). */
  readonly verifier?: Ref;
  /** Must exist and, when `warehouse` is given, be registered there. */
  readonly farmer?: Ref;
}

interface ReferenceRow {
  warehouse_status: string | null;
  custodian_status: string | null;
  custodian_warehouse_id: string | null;
  verifier_status: string | null;
  verifier_at_warehouse: boolean;
  farmer_exists: boolean;
  farmer_at_warehouse: boolean;
}

/**
 * Checks, in one query, that referenced records exist and may be used.
 * Returns every problem found; empty means all good.
 */
export async function checkReferences(
  db: Queryable,
  check: ReferenceCheck,
): Promise<DomainError[]> {
  const { warehouse, custodian, verifier, farmer } = check;
  const { rows } = await db.query<ReferenceRow>(
    `SELECT
       (SELECT status FROM warehouses WHERE id = $1::uuid) AS warehouse_status,
       (SELECT status FROM custodians WHERE id = $2::uuid) AS custodian_status,
       (SELECT warehouse_id FROM custodians WHERE id = $2::uuid) AS custodian_warehouse_id,
       (SELECT status FROM verifiers WHERE id = $3::uuid) AS verifier_status,
       EXISTS (SELECT 1 FROM verifier_warehouses
               WHERE verifier_id = $3::uuid AND warehouse_id = $1::uuid AND status = 'active')
         AS verifier_at_warehouse,
       EXISTS (SELECT 1 FROM farmers WHERE id = $4::uuid) AS farmer_exists,
       EXISTS (SELECT 1 FROM farmer_warehouses
               WHERE farmer_id = $4::uuid AND warehouse_id = $1::uuid) AS farmer_at_warehouse`,
    [warehouse?.id ?? null, custodian?.id ?? null, verifier?.id ?? null, farmer?.id ?? null],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('reference check returned no row');

  const errors: DomainError[] = [];
  const warehouseFound = row.warehouse_status !== null;

  if (warehouse !== undefined) {
    if (!warehouseFound) {
      errors.push(domainError('warehouse_not_found', warehouse.field, 'Warehouse not found'));
    } else if (warehouse.mustBeActive && row.warehouse_status !== 'active') {
      errors.push(domainError('warehouse_inactive', warehouse.field, 'Warehouse is not active'));
    }
  }

  if (custodian !== undefined) {
    if (row.custodian_status === null) {
      errors.push(domainError('custodian_not_found', custodian.field, 'Custodian not found'));
    } else if (row.custodian_status !== 'active') {
      errors.push(domainError('custodian_suspended', custodian.field, 'Custodian is suspended'));
    } else if (
      warehouse !== undefined &&
      warehouseFound &&
      row.custodian_warehouse_id !== warehouse.id.toLowerCase()
    ) {
      errors.push(
        domainError(
          'custodian_wrong_warehouse',
          custodian.field,
          'Custodian does not work at this warehouse',
        ),
      );
    }
  }

  if (verifier !== undefined) {
    if (row.verifier_status === null) {
      errors.push(domainError('verifier_not_found', verifier.field, 'Verifier not found'));
    } else if (row.verifier_status !== 'active') {
      errors.push(domainError('verifier_suspended', verifier.field, 'Verifier is suspended'));
    } else if (warehouse !== undefined && warehouseFound && !row.verifier_at_warehouse) {
      errors.push(
        domainError(
          'verifier_wrong_warehouse',
          verifier.field,
          'Verifier is not assigned to this warehouse',
        ),
      );
    }
  }

  if (farmer !== undefined) {
    if (!row.farmer_exists) {
      errors.push(domainError('farmer_not_found', farmer.field, 'Farmer not found'));
    } else if (warehouse !== undefined && warehouseFound && !row.farmer_at_warehouse) {
      errors.push(
        domainError(
          'farmer_not_at_warehouse',
          farmer.field,
          'Farmer is not registered at this warehouse; register them first',
        ),
      );
    }
  }

  return errors;
}

export interface Actor {
  readonly id: string;
  readonly role: 'custodian' | 'warehouse_owner';
}

/**
 * Who `id` is at `warehouseId`: an active warehouse owner, or an active
 * custodian there. Throws a 400 for anyone else (unknown, suspended, or
 * from another warehouse).
 */
export async function resolveActor(
  db: Queryable,
  id: string,
  warehouseId: string,
  field: string,
): Promise<Actor> {
  const { rows } = await db.query<{ role: Actor['role']; status: string; warehouse_id: string }>(
    `SELECT 'warehouse_owner' AS role, status, warehouse_id FROM warehouse_owners WHERE id = $1::uuid
     UNION ALL
     SELECT 'custodian', status, warehouse_id FROM custodians WHERE id = $1::uuid`,
    [id],
  );
  const row = rows[0];
  const problem =
    row === undefined
      ? domainError('owner_not_found', field, 'No custodian or warehouse owner with this ID')
      : row.warehouse_id !== warehouseId.toLowerCase()
        ? domainError('owner_wrong_warehouse', field, 'This person does not work at this warehouse')
        : row.status !== 'active'
          ? domainError('owner_suspended', field, 'This person is suspended')
          : null;
  if (problem !== null || row === undefined) {
    throw new ValidationError('Request is invalid', { details: [problem] });
  }
  return { id: id.toLowerCase(), role: row.role };
}

/**
 * The warehouse owner named by `id`. A custodian of the warehouse gets 403
 * `owner_required`: the action is the owner's alone.
 */
export async function requireOwner(
  db: Queryable,
  id: string,
  warehouseId: string,
  field: string,
  action: string,
): Promise<Actor> {
  const actor = await resolveActor(db, id, warehouseId, field);
  if (actor.role !== 'warehouse_owner') {
    throw new ForbiddenError(`Only the warehouse owner can ${action}`, {
      code: 'owner_required',
      details: [
        { code: 'owner_required', field, message: `Only the warehouse owner can ${action}` },
      ],
    });
  }
  return actor;
}

/**
 * The active Farmledge admin named by `id`. A custodian, owner or verifier
 * gets 403 `admin_required`: setting up roles is for Farmledge staff alone.
 */
export async function requireAdmin(
  db: Queryable,
  id: string,
  field: string,
  action: string,
): Promise<{ readonly id: string }> {
  const { rows } = await db.query<{ role: string; status: string }>(
    `SELECT 'platform_admin' AS role, status FROM platform_admins WHERE id = $1::uuid
     UNION ALL
     SELECT 'warehouse_owner', status FROM warehouse_owners WHERE id = $1::uuid
     UNION ALL
     SELECT 'custodian', status FROM custodians WHERE id = $1::uuid
     UNION ALL
     SELECT 'verifier', status FROM verifiers WHERE id = $1::uuid`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new ValidationError('Request is invalid', {
      details: [domainError('admin_not_found', field, 'No Farmledge admin with this ID')],
    });
  }
  if (row.role !== 'platform_admin') {
    throw new ForbiddenError(`Only a Farmledge admin can ${action}`, {
      code: 'admin_required',
      details: [{ code: 'admin_required', field, message: `Only a Farmledge admin can ${action}` }],
    });
  }
  if (row.status !== 'active') {
    throw new ValidationError('Request is invalid', {
      details: [domainError('admin_suspended', field, 'This admin is suspended')],
    });
  }
  return { id: id.toLowerCase() };
}
