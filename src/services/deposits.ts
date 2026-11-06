import type pg from 'pg';

import type { Config } from '../config/index.js';
import {
  depositDifferences,
  depositRules,
  validateDeposit,
  type DepositContent,
  type DepositDraft,
  type DepositRules,
} from '../domain/deposit.js';
import { depositRecordedSms } from '../domain/smsTemplates.js';
import { bpsToMoisturePercent } from '../domain/units.js';
import { intakeWeightSource, type WeightSource } from '../domain/weightPolicy.js';
import { withTransaction } from '../db/transaction.js';
import { ConflictError, ValidationError } from '../http/errors.js';
import type { KeyService } from '../keys/keyService.js';
import { openBookWrite, slipEntries, writeBookEntries, type SlipEntry } from './book.js';
import type { NotificationService } from './notifications.js';
import { checkReferences } from './references.js';

export const DEPOSIT_STATUSES = [
  'recorded',
  'submitted',
  'minted',
  'rejected',
  'cancelled',
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export interface DepositSubmission extends DepositDraft {
  readonly farmerId: string;
  readonly warehouseId: string;
  readonly custodianId: string;
  readonly verifierId: string;
}

export interface DepositView {
  deposit_id: string;
  /** The lot's number at its warehouse: its identity on-chain, assigned once (INV-3). */
  deposit_no: number;
  farmer_id: string;
  warehouse_id: string;
  custodian_id: string;
  verifier_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  /** Percentage, e.g. 12.5 (stored internally as basis points). */
  moisture_pct: number;
  bag_count: number;
  /** True when a count above the confirmation threshold was explicitly confirmed. */
  bag_count_confirmed: boolean;
  bag_size_kg: number;
  /** The weight a receipt would be minted with; null for a scale deposit not yet fully weighed. */
  weight_kg: number | null;
  weight_source: string;
  status: string;
  notes: string | null;
  captured_at: Date;
  created_at: Date;
  /** True when review_reasons is not empty. */
  needs_review: boolean;
  /** e.g. `late_capture`: captured offline long before it reached the server. */
  review_reasons: string[];
  photo_count: number;
  /** Spot-check samples; they never change weight_kg of a bag-estimate deposit. */
  scale_samples: { count: number; bags_weighed: number; total_kg: number | null };
}

/** The counter slip: the deposit, and its leaf and salt for the slip's QR code (INV-7). */
export interface DepositSlip {
  deposit: DepositView;
  proofs: SlipEntry[];
  /** Names a slip prints, so any tablet at the warehouse can reprint it (D46). */
  printable: {
    warehouse: { code: string; name: string };
    farmer: { full_name: string; phone: string };
    custodian: { full_name: string };
    verifier: { full_name: string };
  };
}

export interface DepositOutcome {
  /** `duplicate`: this deposit_id was already recorded with the same content. */
  kind: 'created' | 'duplicate';
  deposit: DepositView;
}

export interface DepositListFilter {
  warehouseId?: string | undefined;
  farmerId?: string | undefined;
  /** The warehouse's deposit number, as printed on the slip. */
  depositNo?: number | undefined;
  status?: DepositStatus | undefined;
  needsReview?: boolean | undefined;
  /** Intake on these business dates (BUSINESS_TIMEZONE), inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface DepositPage {
  items: DepositView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  next_cursor: string | null;
}

interface DepositRow {
  deposit_id: string;
  deposit_no: string;
  farmer_id: string;
  warehouse_id: string;
  custodian_id: string;
  verifier_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  moisture_bps: number;
  bag_count: number;
  bag_count_confirmed: boolean;
  bag_size_kg: number;
  weight_kg: string | null;
  weight_source: string;
  status: string;
  notes: string | null;
  intake_at: Date;
  created_at: Date;
  review_reasons: string[];
  photo_count: number;
  sample_count: number;
  bags_weighed: string;
  scale_total_kg: string | null;
  cursor_created_at: string;
  id: string;
}

const DEPOSIT_SELECT = `
  SELECT d.id, d.deposit_id, d.deposit_no, d.farmer_id, d.warehouse_id, d.custodian_id, d.verifier_id,
         d.commodity, d.grading_scheme, d.grade, d.moisture_bps, d.bag_count, d.bag_count_confirmed,
         d.bag_size_kg, w.weight_kg, d.weight_source, d.status, d.notes, d.intake_at,
         d.created_at, d.review_reasons,
         w.bags_weighed, w.scale_total_kg,
         (SELECT count(*) FROM scale_samples s WHERE s.deposit_id = d.deposit_id)::int
           AS sample_count,
         (SELECT count(*) FROM deposit_photos p WHERE p.deposit_id = d.deposit_id)::int
           AS photo_count,
         to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           AS cursor_created_at
  FROM deposits d
  JOIN deposit_weights w USING (deposit_id)`;

function toView(row: DepositRow): DepositView {
  return {
    deposit_id: row.deposit_id,
    deposit_no: Number(row.deposit_no),
    farmer_id: row.farmer_id,
    warehouse_id: row.warehouse_id,
    custodian_id: row.custodian_id,
    verifier_id: row.verifier_id,
    commodity: row.commodity,
    grading_scheme: row.grading_scheme,
    grade: row.grade,
    moisture_pct: bpsToMoisturePercent(row.moisture_bps),
    bag_count: row.bag_count,
    bag_count_confirmed: row.bag_count_confirmed,
    bag_size_kg: row.bag_size_kg,
    weight_kg: row.weight_kg === null ? null : Number(row.weight_kg),
    weight_source: row.weight_source,
    status: row.status,
    notes: row.notes,
    captured_at: row.intake_at,
    created_at: row.created_at,
    needs_review: row.review_reasons.length > 0,
    review_reasons: row.review_reasons,
    photo_count: row.photo_count,
    scale_samples: {
      count: row.sample_count,
      bags_weighed: Number(row.bags_weighed),
      total_kg: row.scale_total_kg === null ? null : Number(row.scale_total_kg),
    },
  };
}

function toContent(row: DepositRow): DepositContent {
  return {
    farmerId: row.farmer_id,
    warehouseId: row.warehouse_id,
    custodianId: row.custodian_id,
    verifierId: row.verifier_id,
    commodity: row.commodity,
    grade: row.grade,
    moistureBps: row.moisture_bps,
    bagCount: row.bag_count,
    notes: row.notes,
  };
}

export class DepositService {
  private readonly rules: DepositRules;
  private readonly weightSource: WeightSource;
  private readonly businessTimeZone: string;

  constructor(
    private readonly pool: pg.Pool,
    config: Config,
    private readonly notifications: NotificationService,
    private readonly keys: KeyService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.rules = depositRules(config);
    this.weightSource = intakeWeightSource(config.features.weightMode);
    this.businessTimeZone = config.businessTimeZone;
  }

  /**
   * Records a deposit, idempotently on `deposit_id`. A repeat with the same
   * content returns the original (`duplicate`); a repeat with different
   * content is a 409, so a reused ID can never silently lose a deposit.
   * Safe under concurrent submissions: the unique `deposit_id` and
   * `ON CONFLICT DO NOTHING` let exactly one insert win.
   */
  async submit(submission: DepositSubmission): Promise<DepositOutcome> {
    const validated = validateDeposit(submission, this.rules, this.clock());
    if (!validated.ok) {
      throw new ValidationError('Deposit is invalid', { details: validated.errors });
    }
    const deposit = validated.value;
    // Without a capture time the deposit happened now, by the same clock that validated it.
    const intakeAt = deposit.capturedAt ?? this.clock();
    const content: DepositContent = {
      farmerId: submission.farmerId.toLowerCase(),
      warehouseId: submission.warehouseId.toLowerCase(),
      custodianId: submission.custodianId.toLowerCase(),
      verifierId: submission.verifierId.toLowerCase(),
      commodity: deposit.commodity,
      grade: deposit.grade,
      moistureBps: deposit.moistureBps,
      bagCount: deposit.bagCount,
      notes: deposit.notes,
    };

    // A repeat is answered from what was stored, even if (say) the
    // custodian has since been suspended, so retries always converge.
    const existing = await this.findRow(deposit.depositId);
    if (existing !== null) return this.repeatOutcome(existing, content);

    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: content.warehouseId, field: 'warehouse_id', mustBeActive: true },
      custodian: { id: content.custodianId, field: 'custodian_id' },
      verifier: { id: content.verifierId, field: 'verifier_id' },
      farmer: { id: content.farmerId, field: 'farmer_id' },
    });
    if (referenceErrors.length > 0) {
      throw new ValidationError('Deposit is invalid', { details: referenceErrors });
    }

    // The insert posts the deposit to the stock ledger (a database trigger)
    // and queues the farmer's SMS in the same transaction.
    const { inserted, notificationId } = await withTransaction(this.pool, async (client) => {
      await openBookWrite(client, content.warehouseId, this.clock());
      const result = await client.query<{ warehouse_name: string }>(
        `INSERT INTO deposits (deposit_id, farmer_id, warehouse_id, custodian_id, verifier_id,
                               commodity, grading_scheme, grade, moisture_bps, bag_count,
                               bag_count_confirmed, bag_size_kg, weight_source, intake_at, notes,
                               review_reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16)
         ON CONFLICT (deposit_id) DO NOTHING
         RETURNING (SELECT name FROM warehouses WHERE id = $3) AS warehouse_name`,
        [
          deposit.depositId,
          content.farmerId,
          content.warehouseId,
          content.custodianId,
          content.verifierId,
          deposit.commodity,
          deposit.gradingScheme,
          deposit.grade,
          deposit.moistureBps,
          deposit.bagCount,
          deposit.bagCountConfirmed,
          deposit.bagSizeKg,
          this.weightSource,
          intakeAt,
          deposit.notes,
          deposit.reviewReasons,
        ],
      );
      const created = result.rows[0];
      if (created === undefined) return { inserted: false, notificationId: null };
      // INV-4 / INV-7: the deposit leaf, salted now so the counter slip carries it.
      const lotMovement = await client.query<{ id: string }>(
        `SELECT lm.id FROM lot_movements lm
           JOIN stock_movements sm ON sm.id = lm.stock_movement_id
          WHERE sm.deposit_id = $1 AND sm.kind = 'deposit_in'`,
        [deposit.depositId],
      );
      await writeBookEntries(
        client,
        this.keys,
        lotMovement.rows.map((row) => row.id),
      );
      return {
        inserted: true,
        notificationId: await this.notifications.queue(client, {
          farmerId: content.farmerId,
          template: 'deposit_recorded',
          body: depositRecordedSms({
            warehouseName: created.warehouse_name,
            bags: deposit.bagCount,
            commodity: deposit.commodity,
            grade: deposit.grade,
          }),
        }),
      };
    });
    await this.notifications.deliver([notificationId]);

    const row = await this.findRow(deposit.depositId);
    if (row === null) throw new Error(`deposit ${deposit.depositId} missing after insert`);
    // Lost the race to a concurrent submission of the same deposit_id.
    if (!inserted) return this.repeatOutcome(row, content);
    return { kind: 'created', deposit: toView(row) };
  }

  /** The counter slip, with the deposit leaf and salt for its QR code. */
  async slip(depositId: string): Promise<DepositSlip | null> {
    const deposit = await this.get(depositId);
    if (deposit === null) return null;
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM book_entries WHERE deposit_id = $1 AND kind = 0`,
      [deposit.deposit_id],
    );
    const names = await this.pool.query<{
      warehouse_code: string;
      warehouse_name: string;
      farmer_name: string;
      farmer_phone: string;
      custodian_name: string;
      verifier_name: string;
    }>(
      `SELECT w.code AS warehouse_code, w.name AS warehouse_name,
              f.full_name AS farmer_name, f.phone AS farmer_phone,
              c.full_name AS custodian_name, v.full_name AS verifier_name
         FROM deposits d
         JOIN warehouses w ON w.id = d.warehouse_id
         JOIN farmers f ON f.id = d.farmer_id
         JOIN custodians c ON c.id = d.custodian_id
         JOIN verifiers v ON v.id = d.verifier_id
        WHERE d.deposit_id = $1`,
      [deposit.deposit_id],
    );
    const n = names.rows[0];
    if (n === undefined) throw new Error(`deposit ${deposit.deposit_id} has no parties`);
    return {
      deposit,
      proofs: await slipEntries(
        this.pool,
        rows.map((row) => row.id),
      ),
      printable: {
        warehouse: { code: n.warehouse_code, name: n.warehouse_name },
        farmer: { full_name: n.farmer_name, phone: n.farmer_phone },
        custodian: { full_name: n.custodian_name },
        verifier: { full_name: n.verifier_name },
      },
    };
  }

  async get(depositId: string): Promise<DepositView | null> {
    const row = await this.findRow(depositId.toLowerCase());
    return row === null ? null : toView(row);
  }

  /** Newest first, by keyset pagination so pages stay stable while deposits arrive. */
  async list(filter: DepositListFilter): Promise<DepositPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.warehouseId !== undefined) add('d.warehouse_id = ?', filter.warehouseId);
    if (filter.farmerId !== undefined) add('d.farmer_id = ?', filter.farmerId);
    if (filter.depositNo !== undefined) add('d.deposit_no = ?', filter.depositNo);
    if (filter.status !== undefined) add('d.status = ?', filter.status);
    if (filter.needsReview !== undefined) {
      add(`(d.review_reasons <> '{}') = ?`, filter.needsReview);
    }
    if (filter.from !== undefined || filter.to !== undefined) {
      params.push(this.businessTimeZone);
      const zone = `$${params.length}`;
      if (filter.from !== undefined)
        add(`(d.intake_at AT TIME ZONE ${zone})::date >= ?::date`, filter.from);
      if (filter.to !== undefined)
        add(`(d.intake_at AT TIME ZONE ${zone})::date <= ?::date`, filter.to);
    }
    if (filter.cursor !== undefined) {
      const cursor = decodeCursor(filter.cursor);
      params.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(filter.limit + 1);
    const { rows } = await this.pool.query<DepositRow>(
      `${DEPOSIT_SELECT}
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT $${params.length}`,
      params,
    );

    const page = rows.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      items: page.map(toView),
      next_cursor:
        rows.length > filter.limit && last !== undefined
          ? encodeCursor(last.cursor_created_at, last.id)
          : null,
    };
  }

  private async findRow(depositId: string): Promise<DepositRow | null> {
    const { rows } = await this.pool.query<DepositRow>(
      `${DEPOSIT_SELECT} WHERE d.deposit_id = $1`,
      [depositId],
    );
    return rows[0] ?? null;
  }

  private repeatOutcome(row: DepositRow, submitted: DepositContent): DepositOutcome {
    const differences = depositDifferences(toContent(row), submitted);
    if (differences.length > 0) {
      throw new ConflictError(
        'This deposit_id was already used for a different deposit; generate a new ID',
        {
          code: 'deposit_id_conflict',
          details: { deposit_id: row.deposit_id, differing_fields: differences },
        },
      );
    }
    return { kind: 'duplicate', deposit: toView(row) };
  }
}

/** Opaque to clients: base64url of the last row's exact created_at and id. */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f-]{36}$/.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new ValidationError('Request is invalid', {
    details: [{ code: 'invalid_query', field: 'cursor', message: 'cursor is not valid' }],
  });
}
