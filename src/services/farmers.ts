import type pg from 'pg';

import { withTransaction } from '../db/transaction.js';
import { validateFarmerRegistration, type FarmerRegistrationDraft } from '../domain/farmer.js';
import { normaliseNigerianMobile } from '../domain/phone.js';
import { ConflictError, ValidationError } from '../http/errors.js';
import { checkReferences } from './references.js';

export interface FarmerRegistration extends FarmerRegistrationDraft {
  readonly warehouseId: string;
  /** Custodian registering the farmer; must work at the warehouse. */
  readonly registeredBy: string;
}

export interface FarmerView {
  id: string;
  full_name: string;
  phone: string;
  lookup_consent: boolean;
  data_consent_at: Date | null;
  created_at: Date;
  /** registered_at is an ISO string (built with json_agg). */
  warehouses: { warehouse_id: string; registered_by: string; registered_at: string }[];
}

export interface FarmerRegistrationOutcome {
  farmer: FarmerView;
  /** False when the phone already belonged to a farmer, who was linked to a new warehouse. */
  farmerCreated: boolean;
}

/** A farmer as the tablet caches them: nothing beyond what lookup needs (D43). */
export interface FarmerDirectoryEntry {
  id: string;
  phone: string;
  full_name: string;
}

export interface FarmerDirectoryPage {
  items: FarmerDirectoryEntry[];
  /** Pass as `cursor` for the next page; null on the last page. */
  next_cursor: string | null;
}

interface FarmerRow {
  id: string;
  full_name: string;
  phone: string;
  lookup_consent: boolean;
  data_consent_at: Date | null;
  created_at: Date;
  warehouses: FarmerView['warehouses'] | null;
}

const FARMER_SELECT = `
  SELECT f.id, f.full_name, f.phone, f.lookup_consent, f.data_consent_at, f.created_at,
         (SELECT json_agg(json_build_object(
                   'warehouse_id', fw.warehouse_id,
                   'registered_by', fw.registered_by,
                   'registered_at', fw.registered_at) ORDER BY fw.registered_at)
            FROM farmer_warehouses fw WHERE fw.farmer_id = f.id) AS warehouses
  FROM farmers f`;

export class FarmerService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Registers a farmer at a warehouse. One person has one farmer record,
   * keyed by phone: registering a known phone at a new warehouse links the
   * existing record, and registering it twice at one warehouse is a conflict.
   */
  async register(input: FarmerRegistration): Promise<FarmerRegistrationOutcome> {
    const validated = validateFarmerRegistration(input);
    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: input.warehouseId, field: 'warehouse_id', mustBeActive: true },
      custodian: { id: input.registeredBy, field: 'registered_by' },
    });
    const errors = [...(validated.ok ? [] : validated.errors), ...referenceErrors];
    if (!validated.ok || errors.length > 0) {
      throw new ValidationError('Farmer registration is invalid', { details: errors });
    }
    const farmer = validated.value;

    return withTransaction(this.pool, async (client) => {
      // ON CONFLICT makes concurrent first registrations of one phone converge on one row.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO farmers (full_name, phone, lookup_consent, consent_given_at, data_consent_at)
         VALUES ($1, $2, $3, CASE WHEN $3 THEN now() END, now())
         ON CONFLICT (phone) DO NOTHING
         RETURNING id`,
        [farmer.fullName, farmer.phone, farmer.lookupConsent],
      );
      let farmerId = inserted.rows[0]?.id;
      const farmerCreated = farmerId !== undefined;
      if (farmerId === undefined) {
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM farmers WHERE phone = $1',
          [farmer.phone],
        );
        farmerId = existing.rows[0]?.id;
        if (farmerId === undefined) throw new Error('farmer vanished after phone conflict');
      }

      const linked = await client.query(
        `INSERT INTO farmer_warehouses (farmer_id, warehouse_id, registered_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (farmer_id, warehouse_id) DO NOTHING`,
        [farmerId, input.warehouseId, input.registeredBy],
      );
      if (linked.rowCount === 0) {
        throw new ConflictError('This phone number is already registered at this warehouse', {
          code: 'farmer_already_registered',
          details: { farmer_id: farmerId },
        });
      }

      const view = await this.fetch(client, 'f.id = $1', [farmerId]);
      if (view[0] === undefined) throw new Error('registered farmer not found');
      return { farmer: view[0], farmerCreated };
    });
  }

  /**
   * One page of the farmers registered at a warehouse, for the tablet's
   * offline lookup cache: id, phone and name only (D43), ordered by id.
   */
  async listAtWarehouse(
    warehouseId: string,
    limit: number,
    after: string | undefined,
  ): Promise<FarmerDirectoryPage> {
    const { rows } = await this.pool.query<FarmerDirectoryEntry>(
      `SELECT f.id, f.phone, f.full_name
         FROM farmer_warehouses fw JOIN farmers f ON f.id = fw.farmer_id
        WHERE fw.warehouse_id = $1 AND ($2::uuid IS NULL OR f.id > $2::uuid)
        ORDER BY f.id
        LIMIT $3`,
      [warehouseId, after ?? null, limit + 1],
    );
    const items = rows.slice(0, limit);
    return {
      items,
      next_cursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  /** Farmers with this phone (written any common way). At most one, as phones are unique. */
  async findByPhone(phone: string): Promise<FarmerView[]> {
    const normalised = normaliseNigerianMobile(phone);
    if (!normalised.ok) {
      throw new ValidationError('Request is invalid', { details: normalised.errors });
    }
    return this.fetch(this.pool, 'f.phone = $1', [normalised.value]);
  }

  private async fetch(
    db: Pick<pg.ClientBase, 'query'>,
    where: string,
    params: unknown[],
  ): Promise<FarmerView[]> {
    const { rows } = await db.query<FarmerRow>(`${FARMER_SELECT} WHERE ${where}`, params);
    return rows.map((row) => ({ ...row, warehouses: row.warehouses ?? [] }));
  }
}
