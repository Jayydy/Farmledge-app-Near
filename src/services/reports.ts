import type pg from 'pg';

import type { Config } from '../config/index.js';
import { buildAuditReport, type VarianceFigures } from '../domain/audit.js';
import { fromCentiKg, percentOf, toCentiKg } from '../domain/quantities.js';
import { NotFoundError } from '../http/errors.js';
import { shrinkageTolerance } from './dispatches.js';

/**
 * Warehouse reports. Each is one or two aggregate queries over the ledger
 * and its source tables, keyed by indexed warehouse and time columns, so
 * they stay fast enough to open every day.
 */

export interface DailyReport {
  warehouse_id: string;
  date: string;
  intake: {
    lines: {
      commodity: string;
      grading_scheme: string;
      grade: string;
      deposits: number;
      bags: number;
      kg: number;
    }[];
    totals: { deposits: number; bags: number; kg: number };
  };
  dispatch: {
    lines: {
      commodity: string;
      grading_scheme: string;
      grade: string;
      dispatches: number;
      bags: number;
      book_kg: number;
      exit_weight_kg: number | null;
    }[];
    totals: { dispatches: number; bags: number; book_kg: number };
  };
  adjustments: { count: number; bags_delta: number; kg_delta: number };
  voided_deposits: { count: number; bags: number };
}

export interface AuditHistoryReport {
  warehouse_id: string;
  period: { from: string; to: string };
  audits: {
    audit_id: string;
    status: string;
    started_at: Date;
    completed_at: Date | null;
    conducted_by: string | null;
    entered_by: string | null;
    counted_by: string | null;
    witnessed_by: string | null;
    lines_counted: number;
    totals: VarianceFigures;
  }[];
}

export interface ShrinkageReport {
  warehouse_id: string;
  period: { from: string; to: string };
  lines: ShrinkageLine[];
}

export interface ShrinkageLine {
  commodity: string;
  /** Stock in versus out during the period. */
  bags_in: number;
  kg_in: number;
  bags_out: number;
  book_kg_out: number;
  dispatches: number;
  /** Dispatches without an exit weight are left out of the shrinkage figures. */
  unweighed_dispatches: number;
  weighed: {
    dispatches: number;
    book_kg: number;
    exit_kg: number;
    shrinkage_kg: number;
    shrinkage_pct: number | null;
  };
  /** Tolerance in force now (the warehouse's setting, or the default). */
  tolerance_pct: number;
  /** Exits flagged when dispatched: shrinkage above the tolerance then in force. */
  over_tolerance: {
    dispatch_id: string;
    delivery_note_no: string;
    shrinkage_kg: number;
    shrinkage_pct: number | null;
  }[];
}

const kg = (value: string | number | null) => fromCentiKg(toCentiKg(value ?? 0));

export class ReportService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {}

  private get tz(): string {
    return this.config.businessTimeZone;
  }

  async daily(warehouseId: string, date: string): Promise<DailyReport> {
    await this.assertWarehouse(warehouseId);
    const params = [warehouseId, date, this.tz];
    const [intake, dispatch, other] = await Promise.all([
      this.pool.query<{
        commodity: string;
        grading_scheme: string;
        grade: string;
        deposits: number;
        bags: string;
        kg: string;
      }>(
        `SELECT commodity, grading_scheme, grade, count(*)::int AS deposits,
                sum(bags_delta) AS bags, sum(kg_delta) AS kg
         FROM stock_movements
         WHERE warehouse_id = $1 AND kind = 'deposit_in'
           AND (occurred_at AT TIME ZONE $3)::date = $2::date
         GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        params,
      ),
      this.pool.query<{
        commodity: string;
        grading_scheme: string;
        grade: string;
        dispatches: number;
        bags: string;
        book_kg: string;
        exit_kg: string | null;
      }>(
        `SELECT commodity, grading_scheme, grade, count(*)::int AS dispatches,
                sum(bag_count) AS bags, sum(book_kg) AS book_kg, sum(exit_weight_kg) AS exit_kg
         FROM dispatches
         WHERE warehouse_id = $1 AND status = 'completed'
           AND (dispatched_at AT TIME ZONE $3)::date = $2::date
         GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        params,
      ),
      this.pool.query<{
        adjustments: number;
        adj_bags: string;
        adj_kg: string;
        voids: number;
        void_bags: string;
      }>(
        `SELECT count(*) FILTER (WHERE kind = 'adjustment')::int AS adjustments,
                COALESCE(sum(bags_delta) FILTER (WHERE kind = 'adjustment'), 0) AS adj_bags,
                COALESCE(sum(kg_delta) FILTER (WHERE kind = 'adjustment'), 0) AS adj_kg,
                count(*) FILTER (WHERE kind = 'deposit_void')::int AS voids,
                COALESCE(-sum(bags_delta) FILTER (WHERE kind = 'deposit_void'), 0) AS void_bags
         FROM stock_movements
         WHERE warehouse_id = $1 AND (occurred_at AT TIME ZONE $3)::date = $2::date`,
        params,
      ),
    ]);
    const intakeLines = intake.rows.map((row) => ({
      ...row,
      bags: Number(row.bags),
      kg: kg(row.kg),
    }));
    const dispatchLines = dispatch.rows.map((row) => ({
      commodity: row.commodity,
      grading_scheme: row.grading_scheme,
      grade: row.grade,
      dispatches: row.dispatches,
      bags: Number(row.bags),
      book_kg: kg(row.book_kg),
      exit_weight_kg: row.exit_kg === null ? null : kg(row.exit_kg),
    }));
    const extra = other.rows[0];
    return {
      warehouse_id: warehouseId,
      date,
      intake: {
        lines: intakeLines,
        totals: {
          deposits: intakeLines.reduce((sum, line) => sum + line.deposits, 0),
          bags: intakeLines.reduce((sum, line) => sum + line.bags, 0),
          kg: fromCentiKg(intakeLines.reduce((sum, line) => sum + toCentiKg(line.kg), 0)),
        },
      },
      dispatch: {
        lines: dispatchLines,
        totals: {
          dispatches: dispatchLines.reduce((sum, line) => sum + line.dispatches, 0),
          bags: dispatchLines.reduce((sum, line) => sum + line.bags, 0),
          book_kg: fromCentiKg(
            dispatchLines.reduce((sum, line) => sum + toCentiKg(line.book_kg), 0),
          ),
        },
      },
      adjustments: {
        count: extra?.adjustments ?? 0,
        bags_delta: Number(extra?.adj_bags ?? 0),
        kg_delta: kg(extra?.adj_kg ?? 0),
      },
      voided_deposits: { count: extra?.voids ?? 0, bags: Number(extra?.void_bags ?? 0) },
    };
  }

  /** Audits started in the period, each with its total variance. */
  async audits(warehouseId: string, from: string, to: string): Promise<AuditHistoryReport> {
    await this.assertWarehouse(warehouseId);
    const { rows } = await this.pool.query<{
      id: string;
      status: string;
      started_at: Date;
      completed_at: Date | null;
      conducted_by: string | null;
      entered_by: string | null;
      counted_by: string | null;
      witnessed_by: string | null;
      lines:
        | {
            commodity: string;
            grade: string;
            recorded_bags: number;
            recorded_kg: string;
            counted_bags: number;
            counted_kg: string;
          }[]
        | null;
    }>(
      `SELECT a.id, a.status, a.started_at, a.completed_at, a.conducted_by, a.entered_by,
              a.counted_by, a.witnessed_by,
              (SELECT json_agg(json_build_object(
                        'commodity', l.commodity, 'grade', l.grade,
                        'recorded_bags', l.recorded_bags, 'recorded_kg', l.recorded_kg::text,
                        'counted_bags', l.counted_bags, 'counted_kg', l.counted_kg::text))
                 FROM audit_lines l WHERE l.audit_id = a.id) AS lines
       FROM audits a
       WHERE a.warehouse_id = $1
         AND (a.started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
       ORDER BY a.started_at DESC`,
      [warehouseId, from, to, this.tz],
    );
    return {
      warehouse_id: warehouseId,
      period: { from, to },
      audits: rows.map((row) => {
        const lines = row.lines ?? [];
        const report = buildAuditReport(
          lines.map((line) => ({
            commodity: line.commodity,
            grade: line.grade,
            recordedBags: line.recorded_bags,
            recordedKg: line.recorded_kg,
            countedBags: line.counted_bags,
            countedKg: line.counted_kg,
          })),
        );
        return {
          audit_id: row.id,
          status: row.status,
          started_at: row.started_at,
          completed_at: row.completed_at,
          conducted_by: row.conducted_by,
          entered_by: row.entered_by,
          counted_by: row.counted_by,
          witnessed_by: row.witnessed_by,
          lines_counted: lines.length,
          totals: report.totals,
        };
      }),
    };
  }

  /** Stock in versus out per commodity, and weighed shrinkage at exit. */
  async shrinkage(warehouseId: string, from: string, to: string): Promise<ShrinkageReport> {
    await this.assertWarehouse(warehouseId);
    const params = [warehouseId, from, to, this.tz];
    const [intake, dispatches] = await Promise.all([
      this.pool.query<{ commodity: string; bags: string; kg: string }>(
        `SELECT commodity, sum(bags_delta) AS bags, sum(kg_delta) AS kg
         FROM stock_movements
         WHERE warehouse_id = $1 AND kind IN ('deposit_in', 'deposit_void')
           AND (occurred_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
         GROUP BY commodity`,
        params,
      ),
      this.pool.query<{
        id: string;
        commodity: string;
        delivery_note_no: string;
        bag_count: number;
        book_kg: string;
        exit_weight_kg: string | null;
        shrinkage_kg: string | null;
        review_reasons: string[];
      }>(
        `SELECT id, commodity, delivery_note_no, bag_count, book_kg, exit_weight_kg, shrinkage_kg,
                review_reasons
         FROM dispatches
         WHERE warehouse_id = $1 AND status = 'completed'
           AND (dispatched_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`,
        params,
      ),
    ]);

    const commodities = new Set([
      ...intake.rows.map((row) => row.commodity),
      ...dispatches.rows.map((row) => row.commodity),
    ]);
    const lines: ShrinkageLine[] = [];
    for (const commodity of [...commodities].sort()) {
      const tolerance = await shrinkageTolerance(this.pool, this.config, warehouseId, commodity);
      const intakeRow = intake.rows.find((row) => row.commodity === commodity);
      const own = dispatches.rows.filter((row) => row.commodity === commodity);
      const weighed = own.filter((row) => row.exit_weight_kg !== null);
      const weighedBook = weighed.reduce((sum, row) => sum + toCentiKg(row.book_kg), 0);
      const weighedExit = weighed.reduce((sum, row) => sum + toCentiKg(row.exit_weight_kg ?? 0), 0);
      lines.push({
        commodity,
        bags_in: Number(intakeRow?.bags ?? 0),
        kg_in: kg(intakeRow?.kg ?? 0),
        bags_out: own.reduce((sum, row) => sum + row.bag_count, 0),
        book_kg_out: fromCentiKg(own.reduce((sum, row) => sum + toCentiKg(row.book_kg), 0)),
        dispatches: own.length,
        unweighed_dispatches: own.length - weighed.length,
        weighed: {
          dispatches: weighed.length,
          book_kg: fromCentiKg(weighedBook),
          exit_kg: fromCentiKg(weighedExit),
          shrinkage_kg: fromCentiKg(weighedBook - weighedExit),
          shrinkage_pct: percentOf(weighedBook - weighedExit, weighedBook),
        },
        tolerance_pct: tolerance.bps / 100,
        over_tolerance: weighed
          .filter((row) => row.review_reasons.includes('shrinkage_above_threshold'))
          .map((row) => ({
            dispatch_id: row.id,
            delivery_note_no: row.delivery_note_no,
            shrinkage_kg: kg(row.shrinkage_kg),
            shrinkage_pct: percentOf(toCentiKg(row.shrinkage_kg ?? 0), toCentiKg(row.book_kg)),
          })),
      });
    }
    return { warehouse_id: warehouseId, period: { from, to }, lines };
  }

  private async assertWarehouse(warehouseId: string): Promise<void> {
    const found = await this.pool.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId]);
    if (found.rowCount === 0) throw new NotFoundError('Warehouse not found');
  }
}
