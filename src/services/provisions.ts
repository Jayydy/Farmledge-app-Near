import type pg from 'pg';

import { COMMODITIES, type Config } from '../config/index.js';
import { isPgError, PgErrorCode } from '../db/transaction.js';
import { checkDate } from '../domain/dates.js';
import { isCommodity } from '../domain/deposit.js';
import { domainError, type DomainError } from '../domain/errors.js';
import { checkGrade } from '../domain/grading.js';
import { isNgnAmount, scheduleOn } from '../domain/storageFees.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import {
  PLATFORM_FEE_MODELS,
  platformFeeModel,
  type PlatformFeeModelName,
} from '../platformFees/platformFeeModel.js';
import { checkReferences } from './references.js';

export interface PriceInput {
  readonly commodity: string;
  readonly grade?: number | string | undefined;
  readonly pricePerTonneNgn: number;
  readonly effectiveFrom: string;
  readonly enteredBy: string;
}

export interface PriceView {
  id: string;
  commodity: string;
  grading_scheme: string;
  /** Null: the price for any grade without its own. */
  grade: string | null;
  price_per_tonne_ngn: number;
  effective_from: string;
  entered_by: string;
  created_at: Date;
}

export interface PlatformFeeTermsInput {
  readonly model: string;
  readonly perBagRateNgn?: number | undefined;
  readonly effectiveFrom: string;
  readonly setBy: string;
}

export interface PlatformFeeTermsView {
  id: string;
  warehouse_id: string;
  model: PlatformFeeModelName;
  per_bag_rate_ngn: number | null;
  effective_from: string;
  set_by: string;
  created_at: Date;
}

export interface PlatformFeeReport {
  warehouse_id: string;
  period: { from: string; to: string };
  /** One line per set of terms in force during the period. */
  lines: {
    model: PlatformFeeModelName;
    effective_from: string | null;
    per_bag_rate_ngn: number | null;
    bags_in: number;
    amount_ngn: number | null;
    implemented: boolean;
  }[];
  /** Null when any line's model is not built yet. */
  total_ngn: number | null;
}

const PRICE_COLUMNS = `id, commodity, grading_scheme, grade, price_per_tonne_ngn,
  to_char(effective_from, 'YYYY-MM-DD') AS effective_from, entered_by, created_at`;
const TERMS_COLUMNS = `id, warehouse_id, model, per_bag_rate_ngn,
  to_char(effective_from, 'YYYY-MM-DD') AS effective_from, set_by, created_at`;

type PriceRow = Omit<PriceView, 'price_per_tonne_ngn'> & { price_per_tonne_ngn: string };
type TermsRow = Omit<PlatformFeeTermsView, 'per_bag_rate_ngn'> & {
  per_bag_rate_ngn: string | null;
};

/** Manually entered prices (provision i) and platform fee terms (provision g). */
export class ProvisionService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {}

  async addPrice(input: PriceInput): Promise<PriceView> {
    const errors: DomainError[] = [];
    if (!isCommodity(input.commodity)) {
      errors.push(
        domainError(
          'unsupported_commodity',
          'commodity',
          `Commodity must be one of ${COMMODITIES.join(', ')}`,
        ),
      );
    }
    const grade =
      input.grade === undefined ? null : checkGrade(input.grade, this.config.grading, errors);
    if (!isNgnAmount(input.pricePerTonneNgn)) {
      errors.push(
        domainError(
          'invalid_price',
          'price_per_tonne_ngn',
          'price_per_tonne_ngn must be greater than 0 with at most 2 decimals',
        ),
      );
    }
    checkDate(input.effectiveFrom, 'effective_from', errors);
    errors.push(
      ...(await checkReferences(this.pool, {
        verifier: { id: input.enteredBy, field: 'entered_by' },
      })),
    );
    if (errors.length > 0) throw new ValidationError('Price is invalid', { details: errors });

    try {
      const { rows } = await this.pool.query<PriceRow>(
        `INSERT INTO manual_prices (commodity, grading_scheme, grade, price_per_tonne_ngn,
                                    effective_from, entered_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PRICE_COLUMNS}`,
        [
          input.commodity,
          this.config.grading.scheme,
          grade,
          input.pricePerTonneNgn.toFixed(2),
          input.effectiveFrom,
          input.enteredBy,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('price insert returned no row');
      return { ...row, price_per_tonne_ngn: Number(row.price_per_tonne_ngn) };
    } catch (err) {
      if (isPgError(err, PgErrorCode.uniqueViolation)) {
        throw new ConflictError('A price for this commodity and grade already starts that day', {
          code: 'price_exists',
        });
      }
      throw err;
    }
  }

  async listPrices(commodity?: string): Promise<PriceView[]> {
    const { rows } = await this.pool.query<PriceRow>(
      `SELECT ${PRICE_COLUMNS} FROM manual_prices
       WHERE ($1::text IS NULL OR commodity = $1)
       ORDER BY commodity, grading_scheme, grade NULLS FIRST, effective_from`,
      [commodity ?? null],
    );
    return rows.map((row) => ({ ...row, price_per_tonne_ngn: Number(row.price_per_tonne_ngn) }));
  }

  async setPlatformFeeTerms(
    warehouseId: string,
    input: PlatformFeeTermsInput,
  ): Promise<PlatformFeeTermsView> {
    await this.assertWarehouse(warehouseId);
    const errors: DomainError[] = [];
    const model = (PLATFORM_FEE_MODELS as readonly string[]).includes(input.model)
      ? (input.model as PlatformFeeModelName)
      : null;
    if (model === null) {
      errors.push(
        domainError(
          'invalid_model',
          'model',
          `model must be one of ${PLATFORM_FEE_MODELS.join(', ')}`,
        ),
      );
    }
    if (model === 'per_bag') {
      if (input.perBagRateNgn === undefined || !isNgnAmount(input.perBagRateNgn, true)) {
        errors.push(
          domainError(
            'invalid_rate',
            'per_bag_rate_ngn',
            'per_bag_rate_ngn is required for per_bag: 0 or more with at most 2 decimals',
          ),
        );
      }
    } else if (input.perBagRateNgn !== undefined) {
      errors.push(
        domainError('invalid_rate', 'per_bag_rate_ngn', 'per_bag_rate_ngn applies only to per_bag'),
      );
    }
    checkDate(input.effectiveFrom, 'effective_from', errors);
    errors.push(
      ...(await checkReferences(this.pool, { verifier: { id: input.setBy, field: 'set_by' } })),
    );
    if (errors.length > 0 || model === null) {
      throw new ValidationError('Platform fee terms are invalid', { details: errors });
    }
    try {
      const { rows } = await this.pool.query<TermsRow>(
        `INSERT INTO warehouse_platform_fee_terms (warehouse_id, model, per_bag_rate_ngn,
                                                   effective_from, set_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${TERMS_COLUMNS}`,
        [
          warehouseId,
          model,
          model === 'per_bag' ? (input.perBagRateNgn ?? 0).toFixed(2) : null,
          input.effectiveFrom,
          input.setBy,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('terms insert returned no row');
      return toTermsView(row);
    } catch (err) {
      if (isPgError(err, PgErrorCode.uniqueViolation)) {
        throw new ConflictError('This warehouse already has terms starting that day', {
          code: 'terms_exist',
        });
      }
      throw err;
    }
  }

  async listPlatformFeeTerms(warehouseId: string): Promise<PlatformFeeTermsView[]> {
    await this.assertWarehouse(warehouseId);
    const { rows } = await this.pool.query<TermsRow>(
      `SELECT ${TERMS_COLUMNS} FROM warehouse_platform_fee_terms
       WHERE warehouse_id = $1 ORDER BY effective_from`,
      [warehouseId],
    );
    return rows.map(toTermsView);
  }

  /**
   * What the warehouse owes Farmledge for deposits taken in the period.
   * Each day's intake is charged under the terms in force that day; a
   * warehouse with no terms is on `none`.
   */
  async platformFeeReport(
    warehouseId: string,
    from: string,
    to: string,
  ): Promise<PlatformFeeReport> {
    const terms = await this.listPlatformFeeTerms(warehouseId);
    const { rows } = await this.pool.query<{ day: string; bags: string }>(
      `SELECT to_char((occurred_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
              sum(bags_delta) AS bags
       FROM stock_movements
       WHERE warehouse_id = $1 AND kind IN ('deposit_in', 'deposit_void')
         AND (occurred_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
       GROUP BY 1`,
      [warehouseId, from, to, this.config.businessTimeZone],
    );
    const asSchedules = terms.map((term) => ({
      id: term.id,
      commodity: null,
      effectiveFrom: term.effective_from,
      basis: 'per_bag' as const,
      period: 'day' as const,
      rateNgn: 0,
      minimumDays: null,
    }));
    const bagsByTerms = new Map<string | null, number>();
    for (const row of rows) {
      const id = scheduleOn(asSchedules, row.day)?.id ?? null;
      bagsByTerms.set(id, (bagsByTerms.get(id) ?? 0) + Number(row.bags));
    }
    const lines = [...bagsByTerms.entries()].map(([id, bagsIn]) => {
      const term = terms.find((candidate) => candidate.id === id) ?? null;
      const model = term?.model ?? 'none';
      const amount = platformFeeModel(model).compute(
        { model, perBagRateNgn: term?.per_bag_rate_ngn ?? null },
        { bagsIn },
      );
      return {
        model,
        effective_from: term?.effective_from ?? null,
        per_bag_rate_ngn: term?.per_bag_rate_ngn ?? null,
        bags_in: bagsIn,
        amount_ngn: amount.amountNgn,
        implemented: amount.implemented,
      };
    });
    lines.sort((a, b) => (a.effective_from ?? '').localeCompare(b.effective_from ?? ''));
    return {
      warehouse_id: warehouseId,
      period: { from, to },
      lines,
      total_ngn: lines.some((line) => line.amount_ngn === null)
        ? null
        : Math.round(lines.reduce((sum, line) => sum + (line.amount_ngn ?? 0) * 100, 0)) / 100,
    };
  }

  private async assertWarehouse(warehouseId: string): Promise<void> {
    const found = await this.pool.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId]);
    if (found.rowCount === 0) throw new NotFoundError('Warehouse not found');
  }
}

function toTermsView(row: TermsRow): PlatformFeeTermsView {
  return {
    ...row,
    per_bag_rate_ngn: row.per_bag_rate_ngn === null ? null : Number(row.per_bag_rate_ngn),
  };
}
