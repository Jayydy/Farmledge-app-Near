import type pg from 'pg';

import { COMMODITIES, type Config } from '../config/index.js';
import type { FarmerConfirmation } from '../confirmation/farmerConfirmation.js';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { checkCapturedAt, isCommodity } from '../domain/deposit.js';
import { domainError, type DomainError } from '../domain/errors.js';
import {
  shrinkageReview,
  toleranceFor,
  validateDispatch,
  validateDispatchPlan,
  type DispatchDraft,
} from '../domain/ledger.js';
import { checkReason } from '../domain/storageFees.js';
import { fromCentiKg, percentOf, toCentiKg } from '../domain/quantities.js';
import { dispatchRecordedSms } from '../domain/smsTemplates.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../domain/ids.js';
import { planDraw, type DrawResult } from '../domain/lots.js';
import type { KeyService } from '../keys/keyService.js';
import type { Logger } from '../logger.js';
import {
  lockedLots,
  openBookWrite,
  postLotMovements,
  slipEntries,
  writeBookEntries,
  type SlipEntry,
} from './book.js';
import { balanceSplit, lockedBalance, type BalanceSplitView } from './ledger.js';
import type { NotificationService } from './notifications.js';
import { checkReferences, requireOwner } from './references.js';

export interface DispatchInput extends DispatchDraft {
  readonly warehouseId: string;
  readonly farmerId: string;
  readonly custodianId: string;
  readonly farmerConfirmed: boolean;
  /** Take the bags from this lot only, instead of the oldest lots first (D29). */
  readonly depositId?: string | undefined;
}

/** One lot a dispatch drew from (D29). */
export interface LotDrawnView {
  deposit_id: string;
  deposit_no: number;
  bags: number;
  kg: number;
}

export interface DispatchView {
  dispatch_id: string;
  warehouse_id: string;
  farmer_id: string;
  custodian_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bag_count: number;
  /** The farmer's recorded kg that left with these bags. */
  book_kg: number;
  /** Weighed at exit; null when not weighed. */
  exit_weight_kg: number | null;
  /** Why it was not weighed (D54); null when weighed, or recorded before reasons were kept. */
  not_weighed_reason: string | null;
  /** book − exit: positive means less left than the books said. Null when not weighed. */
  shrinkage_kg: number | null;
  shrinkage_pct: number | null;
  /** The tolerance this exit was judged against (warehouse setting or default). */
  shrinkage_tolerance_pct: number | null;
  /** Shrinkage is never a reason to refuse an exit; above tolerance it is flagged. */
  needs_review: boolean;
  /** e.g. `shrinkage_above_threshold`. */
  review_reasons: string[];
  buyer_name: string | null;
  notes: string | null;
  delivery_note_no: string;
  status: string;
  confirmation: { id: string; mode: string; status: string };
  /** Unused under data_version 3: unminted lots are dispatched off-chain. */
  chain_tx_hash: string | null;
  dispatched_at: Date;
  /** The lot named by the tablet, or null when the oldest lots were used. */
  requested_deposit_id: string | null;
  /** Which lots the bags came from, so the farmer can see why each lot's balance changed. */
  lots_drawn: LotDrawnView[];
}

export interface ShrinkageToleranceView {
  warehouse_id: string;
  commodity: string;
  tolerance_pct: number;
  /**
   * `commodity`: set by the owner for this commodity; `warehouse`: the
   * owner's warehouse default; `default`: the configured default.
   */
  source: 'commodity' | 'warehouse' | 'default';
  reason: string | null;
  set_by: string | null;
  set_at: Date | null;
}

export interface DispatchListFilter {
  warehouseId?: string | undefined;
  farmerId?: string | undefined;
  needsReview?: boolean | undefined;
  /** Business dates (BUSINESS_TIMEZONE), inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
}

/** What a dispatch would take, without recording anything. */
export interface DispatchPlanInput {
  readonly warehouseId: string;
  readonly farmerId: string;
  readonly commodity: string;
  readonly grade: number | string;
  readonly bagCount: number;
  readonly depositId?: string | undefined;
}

export interface DispatchPlanView {
  /** The lots the bags would come from: oldest first, or the one named. */
  lots_drawn: LotDrawnView[];
  book_kg: number;
  /** The farmer's stock of this grade if the dispatch went ahead now. */
  balance_after: BalanceSplitView;
}

export interface DispatchBlockedInput {
  readonly id: string;
  readonly warehouseId: string;
  readonly custodianId: string;
  /** ISO 8601 with offset, from the tablet. */
  readonly blockedAt: string;
  /** When the tablet last had a connection; left out if it never had one. */
  readonly offlineSince?: string | undefined;
}

/** A tablet's outbox can hold a blocked-dispatch record this long. */
export const BLOCKED_DISPATCH_MAX_AGE_HOURS = 30 * 24;

export interface DispatchBlockedView {
  id: string;
  warehouse_id: string;
  custodian_id: string;
  blocked_at: Date;
  offline_since: Date | null;
  /** How long the tablet had been offline; null if it never had a connection. */
  offline_seconds: number | null;
}

export interface DeliveryNote {
  delivery_note_no: string;
  /** `test` notes are not real documents. */
  environment: string;
  issued_at: Date;
  warehouse: { code: string; name: string; state: string; lga: string; address: string | null };
  farmer: { id: string; full_name: string; phone: string };
  custodian: { id: string; full_name: string };
  buyer_name: string | null;
  goods: {
    commodity: string;
    grading_scheme: string;
    grade: string;
    bags: number;
    book_kg: number;
    exit_weight_kg: number | null;
    not_weighed_reason: string | null;
  };
  farmer_confirmation: { mode: string; status: string; decided_at: Date | null };
  dispatch_id: string;
  /** Which lots the bags came from. */
  lots_drawn: LotDrawnView[];
  /**
   * The farmer's stock of this grade now: free to dispatch, and held
   * on-chain (pledged, or with a mint pending), which no dispatch can touch.
   */
  balance_after: BalanceSplitView;
  /** For the slip's QR codes: each dispatch leaf with its salt (INV-7). */
  proofs: SlipEntry[];
}

interface DispatchRow {
  shrinkage_tolerance_bps: number | null;
  review_reasons: string[];
  id: string;
  warehouse_id: string;
  farmer_id: string;
  custodian_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bag_count: number;
  book_kg: string;
  exit_weight_kg: string | null;
  not_weighed_reason: string | null;
  shrinkage_kg: string | null;
  buyer_name: string | null;
  notes: string | null;
  delivery_note_no: string;
  status: string;
  confirmation_id: string;
  confirmation_mode: string;
  confirmation_status: string;
  chain_tx_hash: string | null;
  dispatched_at: Date;
  requested_deposit_id: string | null;
  lots_drawn: { deposit_id: string; deposit_no: string; bags: number; kg: string }[];
}

const DISPATCH_SELECT = `
  SELECT d.id, d.warehouse_id, d.farmer_id, d.custodian_id, d.commodity, d.grading_scheme,
         d.grade, d.bag_count, d.book_kg, d.exit_weight_kg, d.not_weighed_reason,
         d.shrinkage_kg, d.buyer_name,
         d.notes, d.delivery_note_no, d.status, d.confirmation_id, c.mode AS confirmation_mode,
         c.status AS confirmation_status, d.chain_tx_hash, d.dispatched_at,
         d.shrinkage_tolerance_bps, d.review_reasons, d.requested_deposit_id,
         COALESCE((
           SELECT json_agg(json_build_object('deposit_id', lm.deposit_id,
                                             'deposit_no', dep.deposit_no,
                                             'bags', -lm.bags_delta, 'kg', -lm.kg_delta)
                           ORDER BY dep.deposit_no)
             FROM stock_movements sm
             JOIN lot_movements lm ON lm.stock_movement_id = sm.id
             JOIN deposits dep ON dep.deposit_id = lm.deposit_id
            WHERE sm.dispatch_id = d.id), '[]') AS lots_drawn
  FROM dispatches d
  JOIN farmer_confirmations c ON c.id = d.confirmation_id`;

function lotsDrawnView(row: { lots_drawn: DispatchRow['lots_drawn'] }): LotDrawnView[] {
  return row.lots_drawn.map((lot) => ({
    deposit_id: lot.deposit_id,
    deposit_no: Number(lot.deposit_no),
    bags: lot.bags,
    kg: fromCentiKg(toCentiKg(lot.kg)),
  }));
}

function refusedDraw(result: Exclude<DrawResult, { ok: true }>, message: string): Error {
  // `available_*` is the free balance: lots pledged or with a mint pending
  // are not available to dispatch.
  const details = {
    available_bags: result.freeBags,
    available_kg: fromCentiKg(result.freeCentiKg),
  };
  if (result.reason === 'lot_governed_on_chain') {
    // INV-1 / INV-6: a frozen or minted lot never leaves off-chain.
    return new ConflictError(
      'That lot is pledged or has a mint pending; it is governed on-chain and cannot be dispatched here',
      { code: 'lot_governed_on_chain', details },
    );
  }
  if (result.reason === 'lot_not_found') {
    return new ValidationError('Dispatch is invalid', {
      details: [
        domainError(
          'unknown_lot',
          'deposit_id',
          'deposit_id must name one of the farmer’s lots of this commodity and grade',
        ),
      ],
    });
  }
  return new ConflictError(message, { code: 'insufficient_balance', details });
}

const kgOrNull = (value: string | null) => (value === null ? null : fromCentiKg(toCentiKg(value)));

function toView(row: DispatchRow): DispatchView {
  const bookCentiKg = toCentiKg(row.book_kg);
  return {
    dispatch_id: row.id,
    warehouse_id: row.warehouse_id,
    farmer_id: row.farmer_id,
    custodian_id: row.custodian_id,
    commodity: row.commodity,
    grading_scheme: row.grading_scheme,
    grade: row.grade,
    bag_count: row.bag_count,
    book_kg: fromCentiKg(bookCentiKg),
    exit_weight_kg: kgOrNull(row.exit_weight_kg),
    not_weighed_reason: row.not_weighed_reason,
    shrinkage_kg: kgOrNull(row.shrinkage_kg),
    shrinkage_pct:
      row.shrinkage_kg === null ? null : percentOf(toCentiKg(row.shrinkage_kg), bookCentiKg),
    buyer_name: row.buyer_name,
    notes: row.notes,
    delivery_note_no: row.delivery_note_no,
    status: row.status,
    confirmation: {
      id: row.confirmation_id,
      mode: row.confirmation_mode,
      status: row.confirmation_status,
    },
    shrinkage_tolerance_pct:
      row.shrinkage_tolerance_bps === null ? null : row.shrinkage_tolerance_bps / 100,
    needs_review: row.review_reasons.length > 0,
    review_reasons: row.review_reasons,
    chain_tx_hash: row.chain_tx_hash,
    dispatched_at: row.dispatched_at,
    requested_deposit_id: row.requested_deposit_id,
    lots_drawn: lotsDrawnView(row),
  };
}

export class DispatchService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly confirmation: FarmerConfirmation,
    private readonly keys: KeyService,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Records stock leaving the warehouse, idempotently on `dispatch_id`.
   * Rejected with 409 `insufficient_balance` when the farmer's balance of
   * that commodity and grade has fewer bags than requested.
   */
  async dispatch(
    input: DispatchInput,
  ): Promise<{ kind: 'created' | 'duplicate'; dispatch: DispatchView }> {
    const validated = validateDispatch(input, this.config.grading);
    if (!validated.ok) {
      throw new ValidationError('Dispatch is invalid', { details: validated.errors });
    }
    const dispatch = validated.value;
    const warehouseId = input.warehouseId.toLowerCase();
    const farmerId = input.farmerId.toLowerCase();
    const custodianId = input.custodianId.toLowerCase();
    const requestedDepositId = input.depositId?.toLowerCase() ?? null;
    const submitted = { ...dispatch, warehouseId, farmerId, custodianId, requestedDepositId };

    const existing = await this.find(this.pool, dispatch.dispatchId);
    if (existing !== null) return { kind: 'duplicate', dispatch: repeatOf(existing, submitted) };

    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: warehouseId, field: 'warehouse_id', mustBeActive: true },
      custodian: { id: custodianId, field: 'custodian_id' },
      farmer: { id: farmerId, field: 'farmer_id' },
    });
    if (referenceErrors.length > 0) {
      throw new ValidationError('Dispatch is invalid', { details: referenceErrors });
    }

    const key = {
      warehouseId,
      farmerId,
      commodity: dispatch.commodity,
      gradingScheme: dispatch.gradingScheme,
      grade: dispatch.grade,
    };

    const outcome = await withTransaction(this.pool, async (client) => {
      const now = await openBookWrite(client, warehouseId, this.clock());
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `dispatch|${dispatch.dispatchId}`,
      ]);
      const raced = await this.find(client, dispatch.dispatchId);
      if (raced !== null) {
        return { kind: 'duplicate' as const, row: raced, notificationId: null };
      }

      const confirmation = await this.confirmation.request(client, {
        farmerId,
        action: 'dispatch',
        subjectId: dispatch.dispatchId,
        farmerConfirmed: input.farmerConfirmed,
      });

      // INV-1: the freeze is read in the same transaction that records the
      // dispatch, with the lot rows locked. A frozen or minted lot is never
      // a candidate; naming one is refused. Any error here refuses the
      // dispatch: fail closed.
      await lockedBalance(client, key);
      const lots = await lockedLots(client, key);
      const drawn = planDraw(lots, {
        bags: dispatch.bagCount,
        centiKg: null,
        depositId: requestedDepositId,
      });
      if (!drawn.ok) {
        const held = balanceSplit(lots);
        throw refusedDraw(
          drawn,
          `The farmer has ${drawn.freeBags} bags of ${dispatch.commodity} grade ${dispatch.grade} free to dispatch here` +
            (held.held_on_chain_bags > 0
              ? ` (${held.held_on_chain_bags} more are pledged or being pledged)`
              : '') +
            `; cannot dispatch ${dispatch.bagCount}`,
        );
      }
      const bookCentiKg = -drawn.draws.reduce((sum, draw) => sum + draw.centiKgDelta, 0);
      const tolerance = await shrinkageTolerance(
        client,
        this.config,
        warehouseId,
        dispatch.commodity,
      );
      const reviewReasons = shrinkageReview(bookCentiKg, dispatch.exitCentiKg, tolerance.bps);

      const sequence = await client.query<{ code: string; name: string; last_value: number }>(
        `INSERT INTO document_sequences (warehouse_id, document_type, last_value)
         VALUES ($1, 'delivery_note', 1)
         ON CONFLICT (warehouse_id, document_type)
           DO UPDATE SET last_value = document_sequences.last_value + 1
         RETURNING last_value, (SELECT code FROM warehouses WHERE id = $1) AS code,
                   (SELECT name FROM warehouses WHERE id = $1) AS name`,
        [warehouseId],
      );
      const seq = sequence.rows[0];
      if (seq === undefined) throw new Error('document sequence returned no row');
      const deliveryNoteNo = `${seq.code}-DN-${String(seq.last_value).padStart(6, '0')}`;

      await client.query(
        `INSERT INTO dispatches (id, warehouse_id, farmer_id, custodian_id, commodity,
                                 grading_scheme, grade, bag_count, book_kg, exit_weight_kg,
                                 buyer_name, notes, delivery_note_no, status, confirmation_id,
                                 dispatched_at, shrinkage_tolerance_bps, review_reasons,
                                 requested_deposit_id, not_weighed_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 CASE WHEN $14 = 'approved' THEN 'completed' ELSE 'pending_confirmation' END,
                 $15, $16, $17, $18, $19, $20)`,
        [
          dispatch.dispatchId,
          warehouseId,
          farmerId,
          custodianId,
          dispatch.commodity,
          dispatch.gradingScheme,
          dispatch.grade,
          dispatch.bagCount,
          (bookCentiKg / 100).toFixed(2),
          dispatch.exitCentiKg === null ? null : (dispatch.exitCentiKg / 100).toFixed(2),
          dispatch.buyerName,
          dispatch.notes,
          deliveryNoteNo,
          confirmation.status,
          confirmation.id,
          now,
          tolerance.bps,
          reviewReasons,
          requestedDepositId,
          dispatch.notWeighedReason,
        ],
      );
      // Every exit's variance is logged, weighed or not; flagged ones at warn.
      const variance = {
        dispatchId: dispatch.dispatchId,
        warehouseId,
        deliveryNoteNo,
        bookKg: fromCentiKg(bookCentiKg),
        exitKg: dispatch.exitCentiKg === null ? null : fromCentiKg(dispatch.exitCentiKg),
        shrinkageKg:
          dispatch.exitCentiKg === null ? null : fromCentiKg(bookCentiKg - dispatch.exitCentiKg),
        tolerancePct: tolerance.bps / 100,
        reviewReasons,
      };
      if (reviewReasons.length > 0)
        this.logger.warn(variance, 'dispatch shrinkage above threshold');
      else this.logger.info(variance, 'dispatch shrinkage');
      const movement = await client.query<{ id: string }>(
        `INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme,
                                      grade, bags_delta, kg_delta, occurred_at, dispatch_id)
         SELECT 'dispatch_out', warehouse_id, farmer_id, commodity, grading_scheme, grade,
                -bag_count, -book_kg, dispatched_at, id
         FROM dispatches WHERE id = $1
         RETURNING id`,
        [dispatch.dispatchId],
      );
      const movementId = movement.rows[0]?.id;
      if (movementId === undefined) throw new Error('dispatch movement insert returned no id');
      const lotMovementIds = await postLotMovements(client, movementId, drawn.draws, lots, now);
      // INV-4 / INV-7: a dispatch leaf per lot drawn, salted now, so the
      // slip can carry it.
      await writeBookEntries(client, this.keys, lotMovementIds);
      const remaining = lots.map((lot) => {
        const draw = drawn.draws.find((d) => d.depositId === lot.depositId);
        return draw === undefined
          ? lot
          : { ...lot, bags: lot.bags + draw.bagsDelta, centiKg: lot.centiKg + draw.centiKgDelta };
      });
      const after = balanceSplit(remaining);

      const notificationId = await this.notifications.queue(client, {
        farmerId,
        template: 'dispatch_recorded',
        body: dispatchRecordedSms({
          warehouseName: seq.name,
          bags: dispatch.bagCount,
          commodity: dispatch.commodity,
          grade: dispatch.grade,
          deliveryNoteNo,
          bagsRemaining: after.free_bags,
          lotsDrawn: drawn.draws.map((draw) => draw.depositNo),
          bagsHeldOnChain: after.held_on_chain_bags,
        }),
      });

      const row = await this.find(client, dispatch.dispatchId);
      if (row === null) throw new Error('dispatch missing after insert');
      return { kind: 'created' as const, row, notificationId };
    });

    await this.notifications.deliver([outcome.notificationId]);
    if (outcome.kind === 'duplicate') {
      return { kind: 'duplicate', dispatch: repeatOf(outcome.row, submitted) };
    }
    return { kind: 'created', dispatch: toView(outcome.row) };
  }

  /** Dispatches newest first; `needsReview` lists exits flagged for shrinkage. */
  async list(filter: DispatchListFilter): Promise<DispatchView[]> {
    const { rows } = await this.pool.query<DispatchRow>(
      `${DISPATCH_SELECT}
       WHERE ($1::uuid IS NULL OR d.warehouse_id = $1)
         AND ($2::uuid IS NULL OR d.farmer_id = $2)
         AND ($3::boolean IS NULL OR (d.review_reasons <> '{}') = $3)
         AND ($5::date IS NULL OR (d.dispatched_at AT TIME ZONE $7)::date >= $5::date)
         AND ($6::date IS NULL OR (d.dispatched_at AT TIME ZONE $7)::date <= $6::date)
       ORDER BY d.dispatched_at DESC, d.id DESC
       LIMIT $4`,
      [
        filter.warehouseId ?? null,
        filter.farmerId ?? null,
        filter.needsReview ?? null,
        filter.limit,
        filter.from ?? null,
        filter.to ?? null,
        this.config.businessTimeZone,
      ],
    );
    return rows.map(toView);
  }

  /**
   * Dispatches refused offline at a warehouse, from every tablet, on these
   * business dates. A tablet sends them when it reconnects, so a day's
   * count can still rise afterwards.
   */
  async countBlocked(filter: {
    warehouseId: string;
    from?: string | undefined;
    to?: string | undefined;
  }): Promise<number> {
    await this.assertWarehouse(filter.warehouseId);
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dispatch_blocked_events
        WHERE warehouse_id = $1
          AND ($2::date IS NULL OR (blocked_at AT TIME ZONE $4)::date >= $2::date)
          AND ($3::date IS NULL OR (blocked_at AT TIME ZONE $4)::date <= $3::date)`,
      [filter.warehouseId, filter.from ?? null, filter.to ?? null, this.config.businessTimeZone],
    );
    return rows[0]?.n ?? 0;
  }

  /** The tolerance in force for each commodity at a warehouse. */
  async tolerances(warehouseId: string): Promise<ShrinkageToleranceView[]> {
    await this.assertWarehouse(warehouseId);
    const views: ShrinkageToleranceView[] = [];
    for (const commodity of COMMODITIES) {
      const tolerance = await shrinkageTolerance(this.pool, this.config, warehouseId, commodity);
      views.push({ warehouse_id: warehouseId, commodity, ...toleranceView(tolerance) });
    }
    return views;
  }

  /**
   * Sets the warehouse's shrinkage tolerance for one commodity, or its
   * default when `commodity` is left out (owner only, with a reason). A
   * reporting threshold: exits above it are flagged, never refused.
   */
  async setTolerance(
    warehouseId: string,
    input: {
      readonly tolerancePct: number;
      readonly commodity?: string | undefined;
      readonly reason: string;
      readonly setBy: string;
    },
  ): Promise<ShrinkageToleranceView[]> {
    await this.assertWarehouse(warehouseId);
    const errors: DomainError[] = [];
    const commodity = input.commodity ?? null;
    if (commodity !== null && !isCommodity(commodity)) {
      errors.push(
        domainError(
          'unsupported_commodity',
          'commodity',
          `commodity must be one of ${COMMODITIES.join(', ')}, or left out for the default`,
        ),
      );
    }
    const bps = Math.round(input.tolerancePct * 100);
    if (
      !Number.isFinite(input.tolerancePct) ||
      Math.abs(input.tolerancePct * 100 - bps) > 1e-6 ||
      bps < 0 ||
      bps > 10_000
    ) {
      errors.push(
        domainError(
          'invalid_tolerance',
          'tolerance_pct',
          'tolerance_pct must be a percentage from 0 to 100 with at most 2 decimals',
        ),
      );
    }
    const reason = checkReason(input.reason, errors);
    if (errors.length > 0 || reason === null) {
      throw new ValidationError('Tolerance is invalid', { details: errors });
    }
    await requireOwner(
      this.pool,
      input.setBy,
      warehouseId,
      'set_by',
      'change the shrinkage tolerance',
    );
    await this.pool.query(
      `INSERT INTO warehouse_shrinkage_tolerances (warehouse_id, commodity, tolerance_bps, reason,
                                                   set_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [warehouseId, commodity, bps, reason, input.setBy.toLowerCase()],
    );
    return this.tolerances(warehouseId);
  }

  private async assertWarehouse(warehouseId: string): Promise<void> {
    const found = await this.pool.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId]);
    if (found.rowCount === 0) throw new NotFoundError('Warehouse not found');
  }

  /**
   * The lots a dispatch would draw now, by the same rule and refusals as
   * `dispatch`, recording nothing. The dispatch itself still decides: a
   * pledge or another dispatch can land in between.
   */
  async plan(input: DispatchPlanInput): Promise<DispatchPlanView> {
    const validated = validateDispatchPlan(input, this.config.grading);
    if (!validated.ok) {
      throw new ValidationError('Dispatch plan is invalid', { details: validated.errors });
    }
    const goods = validated.value;
    const warehouseId = input.warehouseId.toLowerCase();
    const farmerId = input.farmerId.toLowerCase();
    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: warehouseId, field: 'warehouse_id', mustBeActive: true },
      farmer: { id: farmerId, field: 'farmer_id' },
    });
    if (referenceErrors.length > 0) {
      throw new ValidationError('Dispatch plan is invalid', { details: referenceErrors });
    }
    const lots = await lockedLots(
      this.pool,
      {
        warehouseId,
        farmerId,
        commodity: goods.commodity,
        gradingScheme: goods.gradingScheme,
        grade: goods.grade,
      },
      false,
    );
    const drawn = planDraw(lots, {
      bags: goods.bagCount,
      centiKg: null,
      depositId: input.depositId?.toLowerCase() ?? null,
    });
    if (!drawn.ok) {
      throw refusedDraw(
        drawn,
        `The farmer has ${drawn.freeBags} bags of ${goods.commodity} grade ${goods.grade} free to dispatch here; cannot dispatch ${goods.bagCount}`,
      );
    }
    const remaining = lots.map((lot) => {
      const draw = drawn.draws.find((d) => d.depositId === lot.depositId);
      return draw === undefined
        ? lot
        : { ...lot, bags: lot.bags + draw.bagsDelta, centiKg: lot.centiKg + draw.centiKgDelta };
    });
    return {
      lots_drawn: drawn.draws.map((draw) => ({
        deposit_id: draw.depositId,
        deposit_no: draw.depositNo,
        bags: -draw.bagsDelta,
        kg: fromCentiKg(-draw.centiKgDelta),
      })),
      book_kg: fromCentiKg(-drawn.draws.reduce((sum, draw) => sum + draw.centiKgDelta, 0)),
      balance_after: balanceSplit(remaining),
    };
  }

  /**
   * Records that the tablet refused to start a dispatch because it was
   * offline (D54): when, who, and how long offline, nothing about the
   * farmer or the goods. Idempotent on the tablet's id.
   */
  async recordBlocked(
    input: DispatchBlockedInput,
  ): Promise<{ kind: 'created' | 'duplicate'; event: DispatchBlockedView }> {
    const errors: DomainError[] = [];
    if (!isUuid(input.id)) {
      errors.push(domainError('invalid_id', 'id', 'id must be a UUID generated on the tablet'));
    }
    const now = this.clock();
    const blockedAt = checkCapturedAt(
      input.blockedAt,
      BLOCKED_DISPATCH_MAX_AGE_HOURS,
      now,
      errors,
      'blocked_at',
    );
    // Offline for any length of time before that is fine; only the order is checked.
    const offlineSince =
      input.offlineSince === undefined
        ? null
        : checkCapturedAt(input.offlineSince, Infinity, now, errors, 'offline_since');
    if (blockedAt !== null && offlineSince !== null && offlineSince > blockedAt) {
      errors.push(
        domainError(
          'invalid_captured_at',
          'offline_since',
          'offline_since must not be after blocked_at',
        ),
      );
    }
    if (errors.length > 0 || blockedAt === null) {
      throw new ValidationError('Blocked dispatch is invalid', { details: errors });
    }
    const warehouseId = input.warehouseId.toLowerCase();
    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: warehouseId, field: 'warehouse_id', mustBeActive: true },
      custodian: { id: input.custodianId.toLowerCase(), field: 'custodian_id' },
    });
    if (referenceErrors.length > 0) {
      throw new ValidationError('Blocked dispatch is invalid', { details: referenceErrors });
    }
    const id = input.id.toLowerCase();
    const inserted = await this.pool.query(
      `INSERT INTO dispatch_blocked_events (id, warehouse_id, custodian_id, blocked_at,
                                            offline_since)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id, warehouseId, input.custodianId.toLowerCase(), blockedAt, offlineSince],
    );
    const { rows } = await this.pool.query<Omit<DispatchBlockedView, 'offline_seconds'>>(
      `SELECT id, warehouse_id, custodian_id, blocked_at, offline_since
         FROM dispatch_blocked_events WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('blocked dispatch missing after insert');
    if (
      row.warehouse_id !== warehouseId ||
      row.custodian_id !== input.custodianId.toLowerCase() ||
      row.blocked_at.getTime() !== blockedAt.getTime() ||
      (row.offline_since?.getTime() ?? null) !== (offlineSince?.getTime() ?? null)
    ) {
      throw new ConflictError('This id was already used for a different blocked dispatch', {
        code: 'id_conflict',
        details: { id },
      });
    }
    return {
      kind: inserted.rowCount === 1 ? 'created' : 'duplicate',
      event: {
        ...row,
        offline_seconds:
          row.offline_since === null
            ? null
            : Math.round((row.blocked_at.getTime() - row.offline_since.getTime()) / 1000),
      },
    };
  }

  async get(dispatchId: string): Promise<DispatchView | null> {
    const row = await this.find(this.pool, dispatchId.toLowerCase());
    return row === null ? null : toView(row);
  }

  /** Everything a printed delivery note needs, as JSON. */
  async deliveryNote(dispatchId: string): Promise<DeliveryNote | null> {
    const { rows } = await this.pool.query<{
      id: string;
      delivery_note_no: string;
      environment: string;
      dispatched_at: Date;
      code: string;
      warehouse_name: string;
      state: string;
      lga: string;
      address: string | null;
      farmer_id: string;
      farmer_name: string;
      farmer_phone: string;
      custodian_id: string;
      custodian_name: string;
      buyer_name: string | null;
      commodity: string;
      grading_scheme: string;
      grade: string;
      bag_count: number;
      book_kg: string;
      exit_weight_kg: string | null;
      not_weighed_reason: string | null;
      mode: string;
      confirmation_status: string;
      decided_at: Date | null;
      warehouse_id: string;
      lots_drawn: DispatchRow['lots_drawn'];
      book_entry_ids: string[] | null;
    }>(
      `SELECT d.id, d.delivery_note_no, d.environment, d.dispatched_at, d.warehouse_id,
              COALESCE((
                SELECT json_agg(json_build_object('deposit_id', lm.deposit_id,
                                                  'deposit_no', dep.deposit_no,
                                                  'bags', -lm.bags_delta, 'kg', -lm.kg_delta)
                                ORDER BY dep.deposit_no)
                  FROM stock_movements sm
                  JOIN lot_movements lm ON lm.stock_movement_id = sm.id
                  JOIN deposits dep ON dep.deposit_id = lm.deposit_id
                 WHERE sm.dispatch_id = d.id), '[]') AS lots_drawn,
              (SELECT array_agg(b.id ORDER BY b.deposit_no)
                 FROM stock_movements sm
                 JOIN lot_movements lm ON lm.stock_movement_id = sm.id
                 JOIN book_entries b ON b.lot_movement_id = lm.id
                WHERE sm.dispatch_id = d.id) AS book_entry_ids,
              w.code, w.name AS warehouse_name, w.state, w.lga, w.address,
              f.id AS farmer_id, f.full_name AS farmer_name, f.phone AS farmer_phone,
              cu.id AS custodian_id, cu.full_name AS custodian_name,
              d.buyer_name, d.commodity, d.grading_scheme, d.grade, d.bag_count, d.book_kg,
              d.exit_weight_kg, d.not_weighed_reason, c.mode, c.status AS confirmation_status,
              c.decided_at
       FROM dispatches d
       JOIN warehouses w ON w.id = d.warehouse_id
       JOIN farmers f ON f.id = d.farmer_id
       JOIN custodians cu ON cu.id = d.custodian_id
       JOIN farmer_confirmations c ON c.id = d.confirmation_id
       WHERE d.id = $1`,
      [dispatchId.toLowerCase()],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      delivery_note_no: row.delivery_note_no,
      environment: row.environment,
      issued_at: row.dispatched_at,
      warehouse: {
        code: row.code,
        name: row.warehouse_name,
        state: row.state,
        lga: row.lga,
        address: row.address,
      },
      farmer: { id: row.farmer_id, full_name: row.farmer_name, phone: row.farmer_phone },
      custodian: { id: row.custodian_id, full_name: row.custodian_name },
      buyer_name: row.buyer_name,
      goods: {
        commodity: row.commodity,
        grading_scheme: row.grading_scheme,
        grade: row.grade,
        bags: row.bag_count,
        book_kg: fromCentiKg(toCentiKg(row.book_kg)),
        exit_weight_kg: kgOrNull(row.exit_weight_kg),
        not_weighed_reason: row.not_weighed_reason,
      },
      farmer_confirmation: {
        mode: row.mode,
        status: row.confirmation_status,
        decided_at: row.decided_at,
      },
      dispatch_id: row.id,
      lots_drawn: lotsDrawnView(row),
      balance_after: await this.balanceAfter(row),
      proofs: await slipEntries(this.pool, row.book_entry_ids ?? []),
    };
  }

  /** The farmer's free and on-chain stock of the dispatched grade, now. */
  private async balanceAfter(row: {
    warehouse_id: string;
    farmer_id: string;
    commodity: string;
    grading_scheme: string;
    grade: string;
  }): Promise<BalanceSplitView> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const lots = await lockedLots(
        client,
        {
          warehouseId: row.warehouse_id,
          farmerId: row.farmer_id,
          commodity: row.commodity,
          gradingScheme: row.grading_scheme,
          grade: row.grade,
        },
        false,
      );
      return balanceSplit(lots);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  private async find(db: Queryable, dispatchId: string): Promise<DispatchRow | null> {
    const { rows } = await db.query<DispatchRow>(`${DISPATCH_SELECT} WHERE d.id = $1`, [
      dispatchId,
    ]);
    return rows[0] ?? null;
  }
}

/** A repeat must match what was stored, as for deposits (D6). */
function repeatOf(
  row: DispatchRow,
  submitted: {
    warehouseId: string;
    farmerId: string;
    custodianId: string;
    commodity: string;
    grade: string;
    bagCount: number;
    exitCentiKg: number | null;
    notWeighedReason: string | null;
    buyerName: string | null;
    notes: string | null;
    requestedDepositId: string | null;
  },
): DispatchView {
  const compared: [string, unknown, unknown][] = [
    ['warehouse_id', row.warehouse_id, submitted.warehouseId],
    ['farmer_id', row.farmer_id, submitted.farmerId],
    ['custodian_id', row.custodian_id, submitted.custodianId],
    ['commodity', row.commodity, submitted.commodity],
    ['grade', row.grade, submitted.grade],
    ['bag_count', row.bag_count, submitted.bagCount],
    [
      'exit_weight_kg',
      row.exit_weight_kg === null ? null : toCentiKg(row.exit_weight_kg),
      submitted.exitCentiKg,
    ],
    ['not_weighed_reason', row.not_weighed_reason, submitted.notWeighedReason],
    ['buyer_name', row.buyer_name, submitted.buyerName],
    ['notes', row.notes, submitted.notes],
    ['deposit_id', row.requested_deposit_id, submitted.requestedDepositId],
  ];
  const differing = compared.filter(([, a, b]) => a !== b).map(([field]) => field);
  if (differing.length > 0) {
    throw new ConflictError('This dispatch_id was already used for a different dispatch', {
      code: 'dispatch_id_conflict',
      details: { dispatch_id: row.id, differing_fields: differing },
    });
  }
  return toView(row);
}

interface Tolerance {
  readonly bps: number;
  readonly source: ShrinkageToleranceView['source'];
  readonly reason: string | null;
  readonly setBy: string | null;
  readonly setAt: Date | null;
}

/**
 * The tolerance for `commodity` at the warehouse: its own, else the
 * warehouse default, else the configured default for the commodity.
 */
export async function shrinkageTolerance(
  db: Queryable,
  config: Config,
  warehouseId: string,
  commodity: string,
): Promise<Tolerance> {
  // The latest setting for the commodity and the latest default, newest first.
  const { rows } = await db.query<{
    commodity: string | null;
    tolerance_bps: number;
    reason: string;
    set_by: string;
    created_at: Date;
  }>(
    `SELECT DISTINCT ON (commodity) commodity, tolerance_bps, reason, set_by, created_at
       FROM warehouse_shrinkage_tolerances
      WHERE warehouse_id = $1 AND (commodity = $2 OR commodity IS NULL)
      ORDER BY commodity, created_at DESC, id DESC`,
    [warehouseId, commodity],
  );
  const found = toleranceFor(rows, commodity);
  if (found !== null) {
    const row = found.setting;
    return {
      bps: row.tolerance_bps,
      source: found.source,
      reason: row.reason,
      setBy: row.set_by,
      setAt: row.created_at,
    };
  }
  const defaults = isCommodity(commodity) ? config.commodities[commodity] : null;
  return {
    bps: defaults?.shrinkageToleranceBps ?? 0,
    source: 'default',
    reason: null,
    setBy: null,
    setAt: null,
  };
}

function toleranceView(
  tolerance: Tolerance,
): Omit<ShrinkageToleranceView, 'warehouse_id' | 'commodity'> {
  return {
    tolerance_pct: tolerance.bps / 100,
    source: tolerance.source,
    reason: tolerance.reason,
    set_by: tolerance.setBy,
    set_at: tolerance.setAt,
  };
}
