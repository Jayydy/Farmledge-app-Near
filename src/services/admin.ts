import type pg from 'pg';

import { isPgError, PgErrorCode, withTransaction } from '../db/transaction.js';
import { domainError, type DomainError } from '../domain/errors.js';
import { NAME_MAX_LENGTH, NAME_MIN_LENGTH } from '../domain/farmer.js';
import { normaliseNigerianMobile } from '../domain/phone.js';
import { checkReason } from '../domain/storageFees.js';
import { ConflictError, ValidationError } from '../http/errors.js';
import { checkReferences, requireAdmin } from './references.js';

/**
 * Sets up warehouse owners (D27). Admin only: an admin creates the owner, or
 * promotes a custodian of the warehouse, and every assignment is logged in
 * `role_assignments` with who, when and why. Admins themselves are created
 * only from the CLI (`npm run create-admin`), never through the API.
 */

export interface WarehouseOwnerInput {
  readonly warehouseId: string;
  /** The admin making the assignment. */
  readonly assignedBy: string;
  readonly reason: string;
  /** Promote this custodian of the warehouse; or give `fullName` and `phone`. */
  readonly custodianId?: string | undefined;
  readonly fullName?: string | undefined;
  readonly phone?: string | undefined;
}

export interface AdminInput {
  readonly fullName: string;
  readonly phone: string;
  readonly reason: string;
  /** Whoever ran the CLI. */
  readonly operator: string;
}

export interface WarehouseOwnerView {
  id: string;
  warehouse_id: string;
  full_name: string;
  phone: string;
  status: string;
  created_at: Date;
}

export interface AdminView {
  id: string;
  full_name: string;
  phone: string;
  status: string;
  created_at: Date;
}

export interface RoleAssignmentView {
  id: string;
  role: 'platform_admin' | 'warehouse_owner';
  admin_id: string | null;
  owner_id: string | null;
  warehouse_id: string | null;
  from_custodian_id: string | null;
  assigned_by: string | null;
  assigned_via: 'admin_api' | 'cli';
  operator: string | null;
  reason: string;
  assigned_at: Date;
}

const ASSIGNMENT_COLUMNS = `id, role, admin_id, owner_id, warehouse_id, from_custodian_id,
  assigned_by, assigned_via, operator, reason, assigned_at`;

export class AdminService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Creates a warehouse owner, or promotes a custodian of the warehouse to
   * owner, and logs the assignment. Only an active admin may (403
   * `admin_required` for a custodian or owner).
   */
  async createWarehouseOwner(
    input: WarehouseOwnerInput,
  ): Promise<{ owner: WarehouseOwnerView; assignment: RoleAssignmentView }> {
    const errors: DomainError[] = [];
    const promoting = input.custodianId !== undefined;
    const naming = input.fullName !== undefined || input.phone !== undefined;
    let person: { fullName: string; phone: string } | null = null;
    if (promoting === naming) {
      errors.push(
        domainError(
          'invalid_owner_subject',
          'custodian_id',
          'Give either custodian_id, to promote a custodian, or full_name and phone',
        ),
      );
    } else if (naming) {
      person = checkPerson(input.fullName ?? '', input.phone ?? '', errors);
    }
    const reason = checkReason(input.reason, errors);
    if (errors.length > 0 || reason === null) {
      throw new ValidationError('Warehouse owner is invalid', { details: errors });
    }

    const admin = await requireAdmin(
      this.pool,
      input.assignedBy,
      'assigned_by',
      'set up warehouse owners',
    );
    const problems = await checkReferences(this.pool, {
      warehouse: { id: input.warehouseId, field: 'warehouse_id', mustBeActive: true },
      ...(input.custodianId === undefined
        ? {}
        : { custodian: { id: input.custodianId, field: 'custodian_id' } }),
    });
    if (problems.length > 0) {
      throw new ValidationError('Warehouse owner is invalid', { details: problems });
    }
    const warehouseId = input.warehouseId.toLowerCase();
    const custodianId = input.custodianId?.toLowerCase() ?? null;

    return withTransaction(this.pool, async (client) => {
      if (custodianId !== null) {
        const { rows } = await client.query<{ full_name: string; phone: string }>(
          'SELECT full_name, phone FROM custodians WHERE id = $1',
          [custodianId],
        );
        const custodian = rows[0];
        if (custodian === undefined) throw new Error('custodian vanished during promotion');
        person = { fullName: custodian.full_name, phone: custodian.phone };
      }
      if (person === null) throw new Error('owner has neither a custodian nor a name');

      let owner: WarehouseOwnerView;
      try {
        const { rows } = await client.query<WarehouseOwnerView>(
          `INSERT INTO warehouse_owners (warehouse_id, full_name, phone)
           VALUES ($1, $2, $3)
           RETURNING id, warehouse_id, full_name, phone, status, created_at`,
          [warehouseId, person.fullName, person.phone],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('owner insert returned no row');
        owner = row;
      } catch (err) {
        if (isPgError(err, PgErrorCode.uniqueViolation)) {
          throw new ConflictError('A warehouse owner with this phone number already exists', {
            code: 'owner_phone_taken',
            details: { phone: person.phone },
          });
        }
        throw err;
      }

      const { rows } = await client.query<RoleAssignmentView>(
        `INSERT INTO role_assignments (role, owner_id, warehouse_id, from_custodian_id,
                                       assigned_by, assigned_via, reason, assigned_at)
         VALUES ('warehouse_owner', $1, $2, $3, $4, 'admin_api', $5, $6)
         RETURNING ${ASSIGNMENT_COLUMNS}`,
        [owner.id, warehouseId, custodianId, admin.id, reason, this.clock()],
      );
      const assignment = rows[0];
      if (assignment === undefined) throw new Error('assignment insert returned no row');
      return { owner, assignment };
    });
  }

  /** Creates an admin from the CLI and logs the assignment with the operator. */
  async createAdmin(
    input: AdminInput,
  ): Promise<{ admin: AdminView; assignment: RoleAssignmentView }> {
    const errors: DomainError[] = [];
    const person = checkPerson(input.fullName, input.phone, errors);
    const reason = checkReason(input.reason, errors);
    const operator = input.operator.trim();
    if (operator === '' || operator.length > 200) {
      errors.push(
        domainError('required', 'operator', 'operator is required: who is creating this admin'),
      );
    }
    if (errors.length > 0 || person === null || reason === null) {
      throw new ValidationError('Admin is invalid', { details: errors });
    }

    return withTransaction(this.pool, async (client) => {
      let admin: AdminView;
      try {
        const { rows } = await client.query<AdminView>(
          `INSERT INTO platform_admins (full_name, phone) VALUES ($1, $2)
           RETURNING id, full_name, phone, status, created_at`,
          [person.fullName, person.phone],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('admin insert returned no row');
        admin = row;
      } catch (err) {
        if (isPgError(err, PgErrorCode.uniqueViolation)) {
          throw new ConflictError('An admin with this phone number already exists', {
            code: 'admin_phone_taken',
            details: { phone: person.phone },
          });
        }
        throw err;
      }
      const { rows } = await client.query<RoleAssignmentView>(
        `INSERT INTO role_assignments (role, admin_id, assigned_via, operator, reason, assigned_at)
         VALUES ('platform_admin', $1, 'cli', $2, $3, $4)
         RETURNING ${ASSIGNMENT_COLUMNS}`,
        [admin.id, operator, reason, this.clock()],
      );
      const assignment = rows[0];
      if (assignment === undefined) throw new Error('assignment insert returned no row');
      return { admin, assignment };
    });
  }
}

function checkPerson(
  fullNameInput: string,
  phoneInput: string,
  errors: DomainError[],
): { fullName: string; phone: string } | null {
  const fullName = fullNameInput.trim().replace(/\s+/g, ' ');
  const before = errors.length;
  if (fullName.length < NAME_MIN_LENGTH || fullName.length > NAME_MAX_LENGTH) {
    errors.push(
      domainError(
        'invalid_name',
        'full_name',
        `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters`,
      ),
    );
  }
  const phone = normaliseNigerianMobile(phoneInput);
  if (!phone.ok) errors.push(...phone.errors);
  return errors.length > before || !phone.ok ? null : { fullName, phone: phone.value };
}
