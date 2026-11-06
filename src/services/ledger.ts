import type pg from 'pg';

import type { Config } from '../config/index.js';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { businessDate } from '../domain/dates.js';
import {
  validateAdjustment,
  type AdjustmentDraft,
  type AdjustmentReason,
  type BalanceKey,
  type MovementKind,
} from '../domain/ledger.js';
import { fromCentiKg, roundHalfAway, toCentiKg } from '../domain/quantities.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { domainError } from '../domain/errors.js';
import { freeBalance, planDraw, planIncrease, type LotBalance } from '../domain/lots.js';
import type { KeyService } from '../keys/keyService.js';
import type { PricingProvider } from '../pricing/pricingProvider.js';
import { lockedLots, openBookWrite, postLotMovements, writeBookEntries } from './book.js';
import { checkReferences } from './references.js';

/**
 * A farmer's stock of one grade split by who governs it: free to dispatch
 * here, or held on-chain (pledged with a mint pending, or minted), which no
 * dispatch or adjustment can touch (INV-1, INV-6).
 */
export interface BalanceSplitView {
  free_bags: number;
  free_kg: number;
  held_on_chain_bags: number;
  held_on_chain_kg: number;
  held_on_chain_lots: number[];
}

export function balanceSplit(lots: readonly LotBalance[]): BalanceSplitView {
  const free = freeBalance(lots);
  const held = lots.filter((lot) => lot.governedOnChain && (lot.bags > 0 || lot.centiKg > 0));
  return {
    free_bags: free.bags,
    free_kg: fromCentiKg(free.centiKg),
    held_on_chain_bags: held.reduce((sum, lot) => sum + lot.bags, 0),
    held_on_chain_kg: fromCentiKg(held.reduce((sum, lot) => sum + lot.centiKg, 0)),
    held_on_chain_lots: held.map((lot) => lot.depositNo).sort((a, b) => a - b),
  };
}

export interface BalanceView extends BalanceSplitView {
  warehouse_id: string;
  farmer_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags: number;
  kg: number;
}

/**
 * `free`: can be dispatched here. `pledged`: a mint is pending, so the lot
 * is frozen (INV-1). `minted`: the lot is a receipt on-chain (INV-6).
 */
export type LotState = 'free' | 'pledged' | 'minted';

export interface LotView {
  deposit_id: string;
  deposit_no: number;
  commodity: string;
  grading_scheme: string;
  grade: string;
  intake_at: Date;
  bags: number;
  kg: number;
  state: LotState;
  /** The on-chain receipt, once minted. */
  receipt_id: string | null;
  /** Why the lot cannot be dispatched here, in words; null when free. */
  excluded_reason: string | null;
}

export interface FarmerLotFilter {
  warehouseId?: string | undefined;
  commodity?: string | undefined;
  grade?: string | undefined;
}

interface FarmerLot extends LotBalance {
  warehouseId: string;
  commodity: string;
  gradingScheme: string;
  grade: string;
  state: LotState;
  receiptId: string | null;
}

/** A farmer's lots holding stock, oldest first (the order dispatch draws them in). */
async function farmerLots(
  q: Queryable,
  farmerId: string,
  filter: FarmerLotFilter,
): Promise<FarmerLot[]> {
  const { rows } = await q.query<{
    warehouse_id: string;
    deposit_id: string;
    deposit_no: string;
    commodity: string;
    grading_scheme: string;
    grade: string;
    intake_at: Date;
    state: LotState;
    chain_receipt_id: string | null;
    bags: string;
    kg: string;
  }>(
    `SELECT d.warehouse_id, d.deposit_id, d.deposit_no, d.commodity, d.grading_scheme, d.grade,
            d.intake_at, d.chain_receipt_id::text,
            CASE WHEN d.status = 'minted' THEN 'minted'
                 WHEN d.frozen_for_mint IS NOT NULL THEN 'pledged'
                 ELSE 'free' END AS state,
            COALESCE(sum(m.bags_delta), 0) AS bags, COALESCE(sum(m.kg_delta), 0) AS kg
       FROM deposits d LEFT JOIN lot_movements m ON m.deposit_id = d.deposit_id
      WHERE d.farmer_id = $1 AND d.status NOT IN ('rejected', 'cancelled')
        AND ($2::uuid IS NULL OR d.warehouse_id = $2)
        AND ($3::text IS NULL OR d.commodity = $3)
        AND ($4::text IS NULL OR d.grade = $4)
      GROUP BY d.id
     HAVING COALESCE(sum(m.bags_delta), 0) <> 0 OR COALESCE(sum(m.kg_delta), 0) <> 0
      ORDER BY d.intake_at, d.deposit_no`,
    [farmerId, filter.warehouseId ?? null, filter.commodity ?? null, filter.grade ?? null],
  );
  return rows.map((row) => ({
    warehouseId: row.warehouse_id,
    depositId: row.deposit_id,
    depositNo: Number(row.deposit_no),
    commodity: row.commodity,
    gradingScheme: row.grading_scheme,
    grade: row.grade,
    intakeAt: row.intake_at,
    bags: Number(row.bags),
    centiKg: toCentiKg(row.kg),
    governedOnChain: row.state !== 'free',
    state: row.state,
    receiptId: row.chain_receipt_id,
  }));
}

function excludedReason(lot: FarmerLot): string | null {
  if (lot.state === 'pledged') {
    return 'Pledged: a receipt is being minted, so the lot is frozen and cannot be dispatched here';
  }
  if (lot.state === 'minted') {
    return `Minted as receipt #${lot.receiptId ?? '?'}: governed on-chain and cannot be dispatched here`;
  }
  return null;
}

export interface StockLineView {
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags: number;
  kg: number;
  farmer_count: number;
  /** From the PricingProvider; null when no price is known. */
  price_per_tonne_ngn: number | null;
  value_ngn: number | null;
}

export interface StockSummaryView {
  warehouse_id: string;
  as_of: string;
  lines: StockLineView[];
  totals: { bags: number; kg: number; value_ngn: number | null; unpriced_lines: number };
}

export interface MovementView {
  id: string;
  kind: MovementKind;
  warehouse_id: string;
  farmer_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags_delta: number;
  kg_delta: number;
  occurred_at: Date;
  recorded_at: Date;
  deposit_id: string | null;
  dispatch_id: string | null;
  adjustment_id: string | null;
}

export interface AdjustmentView {
  adjustment_id: string;
  warehouse_id: string;
  farmer_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags_delta: number;
  kg_delta: number;
  reason_code: string;
  notes: string;
  recorded_by: string;
  authorised_by: string;
  deposit_id: string | null;
  created_at: Date;
}

export interface AdjustmentInput extends AdjustmentDraft {
  readonly warehouseId: string;
  readonly farmerId: string;
  readonly recordedBy: string;
  readonly authorisedBy: string;
  /** Adjust this lot only; otherwise decreases take the oldest lots first, increases go to the newest. */
  readonly depositId?: string | undefined;
}

export interface LedgerFilter {
  warehouseId?: string | undefined;
  farmerId?: string | undefined;
  commodity?: string | undefined;
  kind?: MovementKind | undefined;
  /** Business dates, inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

interface MovementRow {
  id: string;
  kind: MovementKind;
  warehouse_id: string;
  farmer_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags_delta: number;
  kg_delta: string;
  occurred_at: Date;
  created_at: Date;
  deposit_id: string | null;
  dispatch_id: string | null;
  adjustment_id: string | null;
  cursor_occurred_at: string;
}

interface AdjustmentRow {
  id: string;
  warehouse_id: string;
  farmer_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags_delta: number;
  kg_delta: string;
  reason_code: string;
  notes: string;
  recorded_by: string;
  authorised_by: string;
  deposit_id: string | null;
  created_at: Date;
}

const ADJUSTMENT_COLUMNS = `id, warehouse_id, farmer_id, commodity, grading_scheme, grade,
  bags_delta, kg_delta, reason_code, notes, recorded_by, authorised_by, deposit_id, created_at`;

const kg = (value: string | number) => fromCentiKg(toCentiKg(value));

/** One balance after locking it, so the caller can check and post atomically. */
export async function lockedBalance(
  client: pg.ClientBase,
  key: BalanceKey,
): Promise<{ bags: number; centiKg: number }> {
  const params = [key.warehouseId, key.farmerId, key.commodity, key.gradingScheme, key.grade];
  await client.query('SELECT lock_stock_balance($1, $2, $3, $4, $5)', params);
  const { rows } = await client.query<{ bags: string; kg: string }>(
    `SELECT COALESCE(sum(bags_delta), 0) AS bags, COALESCE(sum(kg_delta), 0) AS kg
     FROM stock_movements
     WHERE warehouse_id = $1 AND farmer_id = $2 AND commodity = $3
       AND grading_scheme = $4 AND grade = $5`,
    params,
  );
  return { bags: Number(rows[0]?.bags ?? 0), centiKg: toCentiKg(rows[0]?.kg ?? 0) };
}

export function insufficientBalance(
  available: { bags: number; centiKg: number },
  message: string,
): ConflictError {
  return new ConflictError(message, {
    code: 'insufficient_balance',
    details: { available_bags: available.bags, available_kg: fromCentiKg(available.centiKg) },
  });
}

export interface AdjustmentRecord extends BalanceKey {
  readonly id: string;
  readonly bagsDelta: number;
  readonly centiKgDelta: number;
  readonly reasonCode: AdjustmentReason;
  readonly notes: string;
  readonly recordedBy: string;
  readonly authorisedBy: string;
  readonly depositId: string | null;
  /** The lot a person asked to adjust (D29); null to let the rule choose. */
  readonly requestedDepositId?: string | null;
  /** When it takes effect: adjustments are never backdated. */
  readonly occurredAt: Date;
}

/**
 * Writes an adjustment, its ledger movement, its split across lots and its
 * book record. The caller has opened the book (`openBookWrite`) and holds
 * the balance lock. D33: a lot that is minted or being minted is never
 * adjusted off-chain; loss on pledged collateral is a lender matter, not a
 * bookkeeping entry.
 */
export async function postAdjustment(
  db: pg.ClientBase,
  record: AdjustmentRecord,
  keys: KeyService,
): Promise<void> {
  const kgDelta = (record.centiKgDelta / 100).toFixed(2);
  const lots = await lockedLots(db, record);
  const target = record.depositId ?? record.requestedDepositId ?? null;
  const decrease = record.bagsDelta <= 0 && record.centiKgDelta <= 0;
  const increase = record.bagsDelta >= 0 && record.centiKgDelta >= 0;
  if (!decrease && !increase && target === null) {
    throw new ValidationError('Adjustment is invalid', {
      details: [
        domainError(
          'mixed_adjustment_needs_lot',
          'deposit_id',
          'An adjustment that adds bags and removes kg (or the reverse) must name its lot',
        ),
      ],
    });
  }
  const planned =
    target !== null && !decrease && !increase
      ? planIncrease(lots, {
          bags: record.bagsDelta,
          centiKg: record.centiKgDelta,
          depositId: target,
        })
      : decrease
        ? planDraw(lots, {
            bags: -record.bagsDelta,
            centiKg: -record.centiKgDelta,
            depositId: target,
          })
        : planIncrease(lots, {
            bags: record.bagsDelta,
            centiKg: record.centiKgDelta,
            depositId: target,
          });
  if (!planned.ok) {
    if (planned.reason === 'lot_governed_on_chain') {
      throw new ConflictError(
        'That lot is pledged or has a mint pending; it cannot be adjusted off-chain',
        { code: 'lot_governed_on_chain' },
      );
    }
    if (planned.reason === 'lot_not_found') {
      throw new ValidationError('Adjustment is invalid', {
        details: [
          domainError(
            'unknown_lot',
            'deposit_id',
            'deposit_id must name one of the farmer’s lots of this commodity and grade',
          ),
        ],
      });
    }
    throw insufficientBalance(
      { bags: planned.freeBags, centiKg: planned.freeCentiKg },
      'The adjustment would take the free balance below zero',
    );
  }
  await db.query(
    `INSERT INTO stock_adjustments (id, warehouse_id, farmer_id, commodity, grading_scheme, grade,
                                    bags_delta, kg_delta, reason_code, notes, recorded_by,
                                    authorised_by, deposit_id, requested_deposit_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      record.id,
      record.warehouseId,
      record.farmerId,
      record.commodity,
      record.gradingScheme,
      record.grade,
      record.bagsDelta,
      kgDelta,
      record.reasonCode,
      record.notes,
      record.recordedBy,
      record.authorisedBy,
      record.depositId,
      record.requestedDepositId ?? null,
    ],
  );
  const movement = await db.query<{ id: string }>(
    `INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme, grade,
                                  bags_delta, kg_delta, occurred_at, adjustment_id)
     VALUES ('adjustment', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      record.warehouseId,
      record.farmerId,
      record.commodity,
      record.gradingScheme,
      record.grade,
      record.bagsDelta,
      kgDelta,
      record.occurredAt,
      record.id,
    ],
  );
  const movementId = movement.rows[0]?.id;
  if (movementId === undefined) throw new Error('adjustment movement insert returned no id');
  const lotMovementIds = await postLotMovements(
    db,
    movementId,
    planned.draws,
    lots,
    record.occurredAt,
  );
  // D32: adjustments are book records, hashed into the day's tree.
  await writeBookEntries(db, keys, lotMovementIds);
}

export class LedgerService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly pricing: PricingProvider,
    private readonly keys: KeyService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Current stock at a warehouse by commodity and grade, valued at the current price. */
  async warehouseStock(warehouseId: string): Promise<StockSummaryView> {
    await this.assertWarehouse(warehouseId);
    const { rows } = await this.pool.query<{
      commodity: string;
      grading_scheme: string;
      grade: string;
      bags: string;
      kg: string;
      farmer_count: number;
    }>(
      `SELECT commodity, grading_scheme, grade, sum(bags) AS bags, sum(kg) AS kg,
              count(*) FILTER (WHERE bags > 0 OR kg > 0)::int AS farmer_count
       FROM stock_balances
       WHERE warehouse_id = $1
       GROUP BY commodity, grading_scheme, grade
       HAVING sum(bags) <> 0 OR sum(kg) <> 0
       ORDER BY commodity, grading_scheme, grade`,
      [warehouseId],
    );
    const asOf = businessDate(this.clock(), this.config.businessTimeZone);
    const lines: StockLineView[] = [];
    for (const row of rows) {
      const price = await this.pricing.priceFor({
        commodity: row.commodity,
        gradingScheme: row.grading_scheme,
        grade: row.grade,
        asOf,
      });
      const lineKg = kg(row.kg);
      lines.push({
        commodity: row.commodity,
        grading_scheme: row.grading_scheme,
        grade: row.grade,
        bags: Number(row.bags),
        kg: lineKg,
        farmer_count: row.farmer_count,
        price_per_tonne_ngn: price?.pricePerTonneNgn ?? null,
        value_ngn: price === null ? null : roundHalfAway((lineKg / 1000) * price.pricePerTonneNgn),
      });
    }
    const priced = lines.filter((line) => line.value_ngn !== null);
    return {
      warehouse_id: warehouseId,
      as_of: asOf,
      lines,
      totals: {
        bags: lines.reduce((sum, line) => sum + line.bags, 0),
        kg: fromCentiKg(lines.reduce((sum, line) => sum + toCentiKg(line.kg), 0)),
        value_ngn:
          priced.length === 0
            ? null
            : roundHalfAway(priced.reduce((sum, line) => sum + (line.value_ngn ?? 0), 0)),
        unpriced_lines: lines.length - priced.length,
      },
    };
  }

  /**
   * A farmer's non-zero balances, optionally at one warehouse, each split
   * into free and held on-chain.
   */
  async farmerBalances(farmerId: string, warehouseId?: string): Promise<BalanceView[]> {
    await this.assertFarmer(farmerId);
    const { rows } = await this.pool.query<{
      warehouse_id: string;
      farmer_id: string;
      commodity: string;
      grading_scheme: string;
      grade: string;
      bags: string;
      kg: string;
    }>(
      `SELECT warehouse_id, farmer_id, commodity, grading_scheme, grade, bags, kg
       FROM stock_balances
       WHERE farmer_id = $1 AND ($2::uuid IS NULL OR warehouse_id = $2)
         AND (bags <> 0 OR kg <> 0)
       ORDER BY warehouse_id, commodity, grading_scheme, grade`,
      [farmerId, warehouseId ?? null],
    );
    const lots = await farmerLots(this.pool, farmerId, { warehouseId });
    return rows.map((row) => ({
      ...row,
      bags: Number(row.bags),
      kg: kg(row.kg),
      ...balanceSplit(
        lots.filter(
          (lot) =>
            lot.warehouseId === row.warehouse_id &&
            lot.commodity === row.commodity &&
            lot.gradingScheme === row.grading_scheme &&
            lot.grade === row.grade,
        ),
      ),
    }));
  }

  /**
   * A farmer's lots holding stock, oldest first, each with its state. Lots
   * that cannot be dispatched say why, so a screen never just leaves them out.
   */
  async farmerLotList(farmerId: string, filter: FarmerLotFilter): Promise<LotView[]> {
    await this.assertFarmer(farmerId);
    const lots = await farmerLots(this.pool, farmerId, filter);
    return lots.map((lot) => ({
      deposit_id: lot.depositId,
      deposit_no: lot.depositNo,
      commodity: lot.commodity,
      grading_scheme: lot.gradingScheme,
      grade: lot.grade,
      intake_at: lot.intakeAt,
      bags: lot.bags,
      kg: fromCentiKg(lot.centiKg),
      state: lot.state,
      receipt_id: lot.receiptId,
      excluded_reason: excludedReason(lot),
    }));
  }

  private async assertFarmer(farmerId: string): Promise<void> {
    const farmer = await this.pool.query('SELECT 1 FROM farmers WHERE id = $1', [farmerId]);
    if (farmer.rowCount === 0) throw new NotFoundError('Farmer not found');
  }

  /** Movements, newest first by when they happened, keyset-paginated. */
  async history(
    filter: LedgerFilter,
  ): Promise<{ items: MovementView[]; next_cursor: string | null }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (filter.warehouseId !== undefined) add('m.warehouse_id = ?', filter.warehouseId);
    if (filter.farmerId !== undefined) add('m.farmer_id = ?', filter.farmerId);
    if (filter.commodity !== undefined) add('m.commodity = ?', filter.commodity);
    if (filter.kind !== undefined) add('m.kind = ?', filter.kind);
    if (filter.from !== undefined || filter.to !== undefined) {
      params.push(this.config.businessTimeZone);
      const day = `(m.occurred_at AT TIME ZONE $${params.length})::date`;
      if (filter.from !== undefined) add(`${day} >= ?::date`, filter.from);
      if (filter.to !== undefined) add(`${day} <= ?::date`, filter.to);
    }
    if (filter.cursor !== undefined) {
      const cursor = decodeCursor(filter.cursor);
      params.push(cursor.at, cursor.id);
      conditions.push(
        `(m.occurred_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(filter.limit + 1);
    const { rows } = await this.pool.query<MovementRow>(
      `SELECT m.id, m.kind, m.warehouse_id, m.farmer_id, m.commodity, m.grading_scheme, m.grade,
              m.bags_delta, m.kg_delta, m.occurred_at, m.created_at, m.deposit_id,
              m.dispatch_id, m.adjustment_id,
              to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                AS cursor_occurred_at
       FROM stock_movements m
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        warehouse_id: row.warehouse_id,
        farmer_id: row.farmer_id,
        commodity: row.commodity,
        grading_scheme: row.grading_scheme,
        grade: row.grade,
        bags_delta: row.bags_delta,
        kg_delta: kg(row.kg_delta),
        occurred_at: row.occurred_at,
        recorded_at: row.created_at,
        deposit_id: row.deposit_id,
        dispatch_id: row.dispatch_id,
        adjustment_id: row.adjustment_id,
      })),
      next_cursor:
        rows.length > filter.limit && last !== undefined
          ? Buffer.from(JSON.stringify([last.cursor_occurred_at, last.id])).toString('base64url')
          : null,
    };
  }

  /**
   * Records a manual adjustment, idempotently on `adjustment_id`. Rejected
   * with 409 `insufficient_balance` if it would take the balance below zero.
   */
  async adjust(
    input: AdjustmentInput,
  ): Promise<{ kind: 'created' | 'duplicate'; adjustment: AdjustmentView }> {
    const validated = validateAdjustment(input, this.config.grading);
    if (!validated.ok) {
      throw new ValidationError('Adjustment is invalid', { details: validated.errors });
    }
    const adjustment = validated.value;
    const record: AdjustmentRecord = {
      id: adjustment.adjustmentId,
      warehouseId: input.warehouseId.toLowerCase(),
      farmerId: input.farmerId.toLowerCase(),
      commodity: adjustment.commodity,
      gradingScheme: adjustment.gradingScheme,
      grade: adjustment.grade,
      bagsDelta: adjustment.bagsDelta,
      centiKgDelta: adjustment.centiKgDelta,
      reasonCode: adjustment.reasonCode,
      notes: adjustment.notes,
      recordedBy: input.recordedBy.toLowerCase(),
      authorisedBy: input.authorisedBy.toLowerCase(),
      depositId: null,
      requestedDepositId: input.depositId?.toLowerCase() ?? null,
      occurredAt: this.clock(),
    };

    const existing = await this.findAdjustment(this.pool, record.id);
    if (existing !== null) return { kind: 'duplicate', adjustment: repeatOf(existing, record) };

    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: record.warehouseId, field: 'warehouse_id', mustBeActive: false },
      custodian: { id: record.recordedBy, field: 'recorded_by' },
      verifier: { id: record.authorisedBy, field: 'authorised_by' },
      farmer: { id: record.farmerId, field: 'farmer_id' },
    });
    if (referenceErrors.length > 0) {
      throw new ValidationError('Adjustment is invalid', { details: referenceErrors });
    }

    return withTransaction(this.pool, async (client) => {
      await openBookWrite(client, record.warehouseId, record.occurredAt);
      // A concurrent request with the same id waits here, then sees the first one's row.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `adjustment|${record.id}`,
      ]);
      const raced = await this.findAdjustment(client, record.id);
      if (raced !== null)
        return { kind: 'duplicate' as const, adjustment: repeatOf(raced, record) };

      const balance = await lockedBalance(client, record);
      if (balance.bags + record.bagsDelta < 0 || balance.centiKg + record.centiKgDelta < 0) {
        throw insufficientBalance(balance, 'The adjustment would take the balance below zero');
      }
      await postAdjustment(client, record, this.keys);
      const row = await this.findAdjustment(client, record.id);
      if (row === null) throw new Error('adjustment missing after insert');
      return { kind: 'created' as const, adjustment: toAdjustmentView(row) };
    });
  }

  private async findAdjustment(db: Queryable, id: string): Promise<AdjustmentRow | null> {
    const { rows } = await db.query<AdjustmentRow>(
      `SELECT ${ADJUSTMENT_COLUMNS} FROM stock_adjustments WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  private async assertWarehouse(warehouseId: string): Promise<void> {
    const found = await this.pool.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId]);
    if (found.rowCount === 0) throw new NotFoundError('Warehouse not found');
  }
}

function toAdjustmentView(row: AdjustmentRow): AdjustmentView {
  return {
    adjustment_id: row.id,
    warehouse_id: row.warehouse_id,
    farmer_id: row.farmer_id,
    commodity: row.commodity,
    grading_scheme: row.grading_scheme,
    grade: row.grade,
    bags_delta: row.bags_delta,
    kg_delta: kg(row.kg_delta),
    reason_code: row.reason_code,
    notes: row.notes,
    recorded_by: row.recorded_by,
    authorised_by: row.authorised_by,
    deposit_id: row.deposit_id,
    created_at: row.created_at,
  };
}

/** A repeat must match what was stored, as for deposits (D6). */
function repeatOf(row: AdjustmentRow, submitted: AdjustmentRecord): AdjustmentView {
  const compared: [string, unknown, unknown][] = [
    ['warehouse_id', row.warehouse_id, submitted.warehouseId],
    ['farmer_id', row.farmer_id, submitted.farmerId],
    ['commodity', row.commodity, submitted.commodity],
    ['grade', row.grade, submitted.grade],
    ['bags_delta', row.bags_delta, submitted.bagsDelta],
    ['kg_delta', toCentiKg(row.kg_delta), submitted.centiKgDelta],
    ['reason_code', row.reason_code, submitted.reasonCode],
    ['notes', row.notes, submitted.notes],
    ['recorded_by', row.recorded_by, submitted.recordedBy],
    ['authorised_by', row.authorised_by, submitted.authorisedBy],
  ];
  const differing = compared.filter(([, a, b]) => a !== b).map(([field]) => field);
  if (differing.length > 0) {
    throw new ConflictError('This adjustment_id was already used for a different adjustment', {
      code: 'adjustment_id_conflict',
      details: { adjustment_id: row.id, differing_fields: differing },
    });
  }
  return toAdjustmentView(row);
}

function decodeCursor(cursor: string): { at: string; id: string } {
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
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new ValidationError('Request is invalid', {
    details: [{ code: 'invalid_query', field: 'cursor', message: 'cursor is not valid' }],
  });
}
