import type pg from 'pg';

import type { Config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import {
  buildAuditReport,
  samePersonName,
  validateAuditLine,
  validateAuditStart,
  type AuditLineDraft,
  type AuditReport,
  type AuditStartDraft,
} from '../domain/audit.js';
import { fromCentiKg, toCentiKg } from '../domain/quantities.js';
import { domainError } from '../domain/errors.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { checkReferences } from './references.js';

export interface AuditStart extends AuditStartDraft {
  readonly warehouseId: string;
  /** Verifier conducting the count, when one does (D44). */
  readonly conductedBy?: string | undefined;
  /** Custodian entering the figures on the tablet (D57). */
  readonly enteredBy?: string | undefined;
}

export interface AuditView {
  id: string;
  warehouse_id: string;
  conducted_by: string | null;
  entered_by: string | null;
  counted_by: string | null;
  witnessed_by: string | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  notes: string | null;
}

export interface AuditLineView {
  id: string;
  audit_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  recorded_bags: number;
  recorded_kg: number;
  counted_bags: number;
  counted_kg: number;
  /** True when counted_kg was not weighed but taken as counted bags × bag size. */
  counted_kg_estimated: boolean;
  variance_bags: number;
  variance_kg: number;
  notes: string | null;
}

export interface AuditReportView extends AuditReport {
  audit: AuditView;
  /**
   * Stock the system currently records at the warehouse for commodity and
   * grade combinations with no audit line: stock nobody counted.
   */
  uncounted: {
    commodity: string;
    grading_scheme: string;
    grade: string;
    recorded_bags: number;
    recorded_kg: number;
  }[];
}

interface LineRow {
  id: string;
  audit_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  recorded_bags: number;
  recorded_kg: string;
  counted_bags: number;
  counted_kg: string;
  variance_bags: number;
  variance_kg: string;
  notes: string | null;
}

interface StockRow {
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags: string;
  kg: string;
}

const AUDIT_COLUMNS = `id, warehouse_id, conducted_by, entered_by, counted_by, witnessed_by, status,
  started_at, completed_at, notes`;
const LINE_COLUMNS = `id, audit_id, commodity, grading_scheme, grade, recorded_bags, recorded_kg, counted_bags,
  counted_kg, variance_bags, variance_kg, notes`;

/**
 * Stock the system records at a warehouse, per commodity and grade: the
 * stock ledger's balances, so dispatches and adjustments count as well as
 * deposits.
 */
const RECORDED_STOCK = `
  SELECT b.commodity, b.grading_scheme, b.grade,
         sum(b.bags)::bigint AS bags, sum(b.kg) AS kg
  FROM stock_balances b
  WHERE b.warehouse_id = $1`;
const STOCK_GROUP = 'GROUP BY b.commodity, b.grading_scheme, b.grade';

export class AuditService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async start(input: AuditStart): Promise<AuditView> {
    const validated = validateAuditStart(
      input,
      this.config.intake.offlineRejectAfterHours,
      this.clock(),
    );
    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: input.warehouseId, field: 'warehouse_id', mustBeActive: true },
      ...(input.conductedBy === undefined
        ? {}
        : { verifier: { id: input.conductedBy, field: 'conducted_by' } }),
      ...(input.enteredBy === undefined
        ? {}
        : { custodian: { id: input.enteredBy, field: 'entered_by' } }),
    });
    const errors = [...(validated.ok ? [] : validated.errors), ...referenceErrors];
    if (input.conductedBy === undefined && input.enteredBy === undefined) {
      errors.push(
        domainError(
          'audit_actor_required',
          'entered_by',
          'Name the custodian entering the count (entered_by) or the verifier conducting it',
        ),
      );
    }
    if (
      validated.ok &&
      (await this.isCustodianName(input.warehouseId, validated.value.witnessedBy))
    ) {
      errors.push(
        domainError(
          'witness_is_custodian',
          'witnessed_by',
          'The witness must not be a custodian of this warehouse',
        ),
      );
    }
    if (!validated.ok || errors.length > 0) {
      throw new ValidationError('Audit is invalid', { details: errors });
    }
    const { rows } = await this.pool.query<AuditView>(
      `INSERT INTO audits (warehouse_id, conducted_by, entered_by, counted_by, witnessed_by,
                           started_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${AUDIT_COLUMNS}`,
      [
        input.warehouseId,
        input.conductedBy ?? null,
        input.enteredBy ?? null,
        validated.value.countedBy,
        validated.value.witnessedBy,
        validated.value.startedAt ?? this.clock(),
        validated.value.notes,
      ],
    );
    const audit = rows[0];
    if (audit === undefined) throw new Error('audit insert returned no row');
    return audit;
  }

  /**
   * Records one physical count. The recorded figures are snapshotted from
   * the system at this moment, so later deposits don't change the audit.
   */
  async addLine(auditId: string, draft: AuditLineDraft): Promise<AuditLineView> {
    const validated = validateAuditLine(draft, this.config);
    if (!validated.ok) {
      throw new ValidationError('Audit line is invalid', { details: validated.errors });
    }
    const line = validated.value;

    return withTransaction(this.pool, async (client) => {
      const audit = await this.lockAudit(client, auditId);
      if (audit.status !== 'open') {
        throw new ConflictError('This audit is completed; start a new one to recount', {
          code: 'audit_completed',
        });
      }

      const stock = await client.query<StockRow>(
        `${RECORDED_STOCK} AND b.commodity = $2 AND b.grading_scheme = $3 AND b.grade = $4
         ${STOCK_GROUP}`,
        [audit.warehouse_id, line.commodity, line.gradingScheme, line.grade],
      );
      const recorded = stock.rows[0];

      const { rows } = await client.query<LineRow>(
        `INSERT INTO audit_lines (audit_id, commodity, grading_scheme, grade, recorded_bags,
                                  recorded_kg, counted_bags, counted_kg, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (audit_id, commodity, grading_scheme, grade) DO NOTHING
         RETURNING ${LINE_COLUMNS}`,
        [
          auditId,
          line.commodity,
          line.gradingScheme,
          line.grade,
          Number(recorded?.bags ?? 0),
          recorded?.kg ?? '0',
          line.countedBags,
          (line.countedCentiKg / 100).toFixed(2),
          line.notes,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ConflictError(
          `This audit already has a line for ${line.commodity} grade ${line.grade}`,
          { code: 'audit_line_exists' },
        );
      }
      return toLineView(row, line.countedKgEstimated);
    });
  }

  async complete(auditId: string): Promise<AuditView> {
    return withTransaction(this.pool, async (client) => {
      const audit = await this.lockAudit(client, auditId);
      if (audit.status !== 'open') {
        throw new ConflictError('This audit is already completed', { code: 'audit_completed' });
      }
      const { rows } = await client.query<AuditView>(
        `UPDATE audits SET status = 'completed', completed_at = greatest($2::timestamptz, started_at)
         WHERE id = $1 RETURNING ${AUDIT_COLUMNS}`,
        [auditId, this.clock()],
      );
      const updated = rows[0];
      if (updated === undefined) throw new Error('audit vanished while completing');
      return updated;
    });
  }

  async report(auditId: string): Promise<AuditReportView> {
    const audits = await this.pool.query<AuditView>(
      `SELECT ${AUDIT_COLUMNS} FROM audits WHERE id = $1`,
      [auditId],
    );
    const audit = audits.rows[0];
    if (audit === undefined) throw new NotFoundError('Audit not found');

    const [lines, stock] = await Promise.all([
      this.pool.query<LineRow>(
        `SELECT ${LINE_COLUMNS} FROM audit_lines WHERE audit_id = $1
         ORDER BY commodity, grading_scheme, grade`,
        [auditId],
      ),
      this.pool.query<StockRow>(
        `${RECORDED_STOCK} ${STOCK_GROUP} ORDER BY b.commodity, b.grading_scheme, b.grade`,
        [audit.warehouse_id],
      ),
    ]);

    const report = buildAuditReport(
      lines.rows.map((row) => ({
        commodity: row.commodity,
        grade: row.grade,
        recordedBags: row.recorded_bags,
        recordedKg: row.recorded_kg,
        countedBags: row.counted_bags,
        countedKg: row.counted_kg,
      })),
    );
    const lineKey = (row: { commodity: string; grading_scheme: string; grade: string }) =>
      `${row.commodity}/${row.grading_scheme}/${row.grade}`;
    const counted = new Set(lines.rows.map(lineKey));
    const uncounted = stock.rows
      .filter((row) => !counted.has(lineKey(row)) && Number(row.bags) > 0)
      .map((row) => ({
        commodity: row.commodity,
        grading_scheme: row.grading_scheme,
        grade: row.grade,
        recorded_bags: Number(row.bags),
        recorded_kg: fromCentiKg(toCentiKg(row.kg)),
      }));

    return { audit, ...report, uncounted };
  }

  /** The audit's warehouse, so a route can keep a session to its own (D57). */
  async warehouseOf(auditId: string): Promise<string> {
    const { rows } = await this.pool.query<{ warehouse_id: string }>(
      'SELECT warehouse_id FROM audits WHERE id = $1',
      [auditId],
    );
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('Audit not found');
    return row.warehouse_id;
  }

  /**
   * True if the name is any custodian's registered at the warehouse, active
   * or not: whoever manages the stock can't witness its count. Typed names
   * prove little; #48 replaces this with a signed-in verifier.
   */
  private async isCustodianName(warehouseId: string, name: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ full_name: string }>(
      'SELECT full_name FROM custodians WHERE warehouse_id = $1',
      [warehouseId],
    );
    return rows.some((row) => samePersonName(row.full_name, name));
  }

  private async lockAudit(client: pg.PoolClient, auditId: string): Promise<AuditView> {
    const { rows } = await client.query<AuditView>(
      `SELECT ${AUDIT_COLUMNS} FROM audits WHERE id = $1 FOR UPDATE`,
      [auditId],
    );
    const audit = rows[0];
    if (audit === undefined) throw new NotFoundError('Audit not found');
    return audit;
  }
}

function toLineView(row: LineRow, countedKgEstimated: boolean): AuditLineView {
  return {
    id: row.id,
    audit_id: row.audit_id,
    commodity: row.commodity,
    grading_scheme: row.grading_scheme,
    grade: row.grade,
    recorded_bags: row.recorded_bags,
    recorded_kg: fromCentiKg(toCentiKg(row.recorded_kg)),
    counted_bags: row.counted_bags,
    counted_kg: fromCentiKg(toCentiKg(row.counted_kg)),
    counted_kg_estimated: countedKgEstimated,
    variance_bags: row.variance_bags,
    variance_kg: fromCentiKg(toCentiKg(row.variance_kg)),
    notes: row.notes,
  };
}
