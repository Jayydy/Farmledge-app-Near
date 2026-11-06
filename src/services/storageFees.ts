import type pg from 'pg';

import type { Config } from '../config/index.js';
import type { Queryable } from '../db/pool.js';
import { isPgError, PgErrorCode, withTransaction } from '../db/transaction.js';
import { addDays, businessDate } from '../domain/dates.js';
import { balanceKeyString, type BalanceKey, type MovementKind } from '../domain/ledger.js';
import { fromCentiKg, roundHalfAway, toCentiKg } from '../domain/quantities.js';
import { feeStatementSms } from '../domain/smsTemplates.js';
import {
  accrualRows,
  accrualWindow,
  computeExpectedCharges,
  feeStatementFigures,
  fromKobo,
  outstandingKobo,
  scheduleOn,
  toKobo,
  checkReason,
  validatePayment,
  validateSchedule,
  type AccrualRow,
  type AccruedTotal,
  type FeeSchedule,
  type FeeStatementFigures,
  type LedgerEvent,
  type PaymentDraft,
  type ScheduleDraft,
} from '../domain/storageFees.js';
import type { DomainError } from '../domain/errors.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import type { NotificationService } from './notifications.js';
import { checkReferences, requireOwner, resolveActor } from './references.js';

/** Serialises accrual runs with each other, new schedules and cancellations. */
export const ACCRUAL_LOCK = 'storage_fee_accrual';

export interface ScheduleInput extends ScheduleDraft {
  readonly setBy: string;
}

export interface ScheduleView {
  id: string;
  warehouse_id: string;
  /** Null: the warehouse default, used for commodities without their own schedule. */
  commodity: string | null;
  basis: string;
  period: string;
  rate_ngn: number;
  minimum_days: number | null;
  effective_from: string;
  reason: string | null;
  set_by: string;
  created_at: Date;
}

export interface AccrualRunView {
  run_id: string;
  from_date: string;
  through_date: string;
  rows_written: number;
  /** Net amount the run added, in naira (2 dp). */
  amount_ngn: number;
}

export interface PaymentInput extends PaymentDraft {
  readonly warehouseId: string;
  readonly farmerId: string;
  readonly recordedBy: string;
}

export interface PaymentView {
  id: string;
  warehouse_id: string;
  farmer_id: string;
  amount_ngn: number;
  reference: string;
  paid_on: string;
  method: string;
  notes: string | null;
  recorded_by: string;
  created_at: Date;
  /** Set when the payment was reversed; the payment itself stays on record. */
  reversal: PaymentReversalView | null;
}

export interface PaymentReversalView {
  id: string;
  reason: string;
  reversed_by: string;
  reversed_at: Date;
  /** Business date of the reversal; it counts against `paid` from this day. */
  date: string;
}

export interface StatementMovement {
  date: string;
  occurred_at: Date;
  kind: MovementKind;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags_delta: number;
  kg_delta: number;
  deposit_id: string | null;
  dispatch_id: string | null;
  delivery_note_no: string | null;
  adjustment_id: string | null;
}

export interface StatementBalance {
  commodity: string;
  grading_scheme: string;
  grade: string;
  bags: number;
  kg: number;
}

export interface FarmerStatement {
  farmer: { id: string; full_name: string; phone: string };
  warehouse: { id: string; code: string; name: string };
  period: { from: string; to: string };
  /** Last day storage fees have been accrued for; later days are not charged yet. */
  accrued_through: string | null;
  stock: {
    opening: StatementBalance[];
    movements: StatementMovement[];
    closing: StatementBalance[];
  };
  fees: FeeStatementFigures & {
    accrued_by_kind: {
      daily: number;
      correction: number;
      minimum_topup: number;
      /** Contra entries reversing the fees of cancelled deposits. */
      cancellation_reversal: number;
    };
    /** Payments made or reversed in the period, each with its reversal next to it. */
    payments: PaymentView[];
  };
}

export interface OutstandingFeesView {
  warehouse_id: string;
  accrued_through: string | null;
  farmers: {
    farmer_id: string;
    full_name: string;
    phone: string;
    accrued_ngn: number;
    paid_ngn: number;
    outstanding_ngn: number;
  }[];
  totals: { accrued_ngn: number; paid_ngn: number; outstanding_ngn: number };
}

interface ScheduleRow {
  id: string;
  warehouse_id: string;
  commodity: string | null;
  reason: string | null;
  basis: FeeSchedule['basis'];
  period: FeeSchedule['period'];
  rate_ngn: string;
  minimum_days: number | null;
  effective_from: string;
  set_by: string;
  created_at: Date;
}

interface PaymentRow {
  id: string;
  warehouse_id: string;
  farmer_id: string;
  amount_ngn: string;
  reference: string;
  paid_on: string;
  method: string;
  notes: string | null;
  recorded_by: string;
  created_at: Date;
  reversal: PaymentReversalView | null;
}

const SCHEDULE_COLUMNS = `id, warehouse_id, commodity, reason, basis, period, rate_ngn, minimum_days,
  to_char(effective_from, 'YYYY-MM-DD') AS effective_from, set_by, created_at`;
/** Payment columns with any reversal; `$tz` is the business time zone parameter. */
const paymentSelect = (tz: string) => `
  SELECT p.id, p.warehouse_id, p.farmer_id, p.amount_ngn, p.reference,
         to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.method, p.notes, p.recorded_by,
         p.created_at,
         CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
           'id', r.id, 'reason', r.reason, 'reversed_by', r.reversed_by,
           'reversed_at', r.reversed_at,
           'date', to_char((r.reversed_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD')) END AS reversal
  FROM fee_payments p
  LEFT JOIN fee_payment_reversals r ON r.payment_id = p.id`;

/** Net paid by a farmer at a warehouse ($1 farmer, $2 warehouse): payments less reversals. */
const NET_PAID = `
  SELECT COALESCE(sum(p.amount_ngn), 0)
         - COALESCE(sum(p.amount_ngn) FILTER (WHERE r.id IS NOT NULL), 0)
  FROM fee_payments p LEFT JOIN fee_payment_reversals r ON r.payment_id = p.id
  WHERE p.farmer_id = $1 AND p.warehouse_id = $2`;

const kg = (value: string | number) => fromCentiKg(toCentiKg(value));
const ngn = (value: string | number) => fromKobo(toKobo(Number(value)));

function toScheduleView(row: ScheduleRow): ScheduleView {
  return { ...row, rate_ngn: Number(row.rate_ngn) };
}

export function toSchedule(row: ScheduleRow): FeeSchedule {
  return {
    id: row.id,
    commodity: row.commodity,
    basis: row.basis,
    period: row.period,
    rateNgn: Number(row.rate_ngn),
    minimumDays: row.minimum_days,
    effectiveFrom: row.effective_from,
  };
}

function toPaymentView(row: PaymentRow): PaymentView {
  return {
    ...row,
    amount_ngn: Number(row.amount_ngn),
    reversal:
      row.reversal === null
        ? null
        : { ...row.reversal, reversed_at: new Date(row.reversal.reversed_at) },
  };
}

export class StorageFeeService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly notifications: NotificationService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Today's date in the business time zone. */
  today(): string {
    return businessDate(this.clock(), this.config.businessTimeZone);
  }

  /** Days the accrual job always rechecks: the oldest offline capture the API accepts. */
  private get correctionDays(): number {
    return Math.ceil(this.config.intake.offlineRejectAfterHours / 24) + 1;
  }

  // --- Schedules -----------------------------------------------------------

  /**
   * Adds a fee schedule from `effective_from`, for one commodity or as the
   * warehouse default. Only the warehouse owner may change fees (403
   * `owner_required`), with a reason. It must start after the last accrued
   * day, so charges already made are never repriced (409
   * `schedule_would_reprice`).
   */
  async createSchedule(warehouseId: string, input: ScheduleInput): Promise<ScheduleView> {
    await this.assertWarehouse(warehouseId);
    const validated = validateSchedule(input);
    if (!validated.ok) {
      throw new ValidationError('Fee schedule is invalid', { details: validated.errors });
    }
    await requireOwner(this.pool, input.setBy, warehouseId, 'set_by', 'change storage fees');
    const schedule = validated.value;

    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ACCRUAL_LOCK]);
      const lastAccrued = await lastAccruedDate(client);
      if (lastAccrued !== null && schedule.effectiveFrom <= lastAccrued) {
        throw new ConflictError(
          `Fees are already accrued through ${lastAccrued}; a new schedule must start on ${addDays(lastAccrued, 1)} or later`,
          { code: 'schedule_would_reprice', details: { accrued_through: lastAccrued } },
        );
      }
      try {
        const { rows } = await client.query<ScheduleRow>(
          `INSERT INTO storage_fee_schedules (warehouse_id, basis, period, rate_ngn, minimum_days,
                                              effective_from, set_by, commodity, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${SCHEDULE_COLUMNS}`,
          [
            warehouseId,
            schedule.basis,
            schedule.period,
            schedule.rateNgn.toFixed(2),
            schedule.minimumDays,
            schedule.effectiveFrom,
            input.setBy.toLowerCase(),
            schedule.commodity,
            schedule.reason,
          ],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('schedule insert returned no row');
        return toScheduleView(row);
      } catch (err) {
        if (isPgError(err, PgErrorCode.uniqueViolation)) {
          throw new ConflictError(
            `This warehouse already has a ${schedule.commodity ?? 'default'} schedule starting ${schedule.effectiveFrom}`,
            { code: 'schedule_exists' },
          );
        }
        throw err;
      }
    });
  }

  async listSchedules(warehouseId: string): Promise<ScheduleView[]> {
    await this.assertWarehouse(warehouseId);
    const { rows } = await this.pool.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS} FROM storage_fee_schedules
       WHERE warehouse_id = $1 ORDER BY commodity NULLS FIRST, effective_from`,
      [warehouseId],
    );
    return rows.map(toScheduleView);
  }

  // --- Accrual ---------------------------------------------------------------

  /**
   * The daily accrual job. Charges every balance for each day through
   * `through` (default: yesterday), rechecking the correction window so
   * late offline captures are charged by `correction` rows. Appends only,
   * and running it twice adds nothing the second time.
   */
  async runAccrual(through?: string): Promise<AccrualRunView> {
    const today = this.today();
    const throughDate = through ?? addDays(today, -1);
    if (throughDate > today) {
      throw new ValidationError('Accrual is invalid', {
        details: [
          {
            code: 'date_in_future',
            field: 'through',
            message: `Fees cannot be accrued beyond today (${today})`,
          },
        ],
      });
    }
    const tz = this.config.businessTimeZone;

    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ACCRUAL_LOCK]);
      const startedAt = new Date();
      const lastThrough = await lastAccruedDate(client);
      const first = await client.query<{ day: string | null }>(
        `SELECT to_char(min((occurred_at AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS day
         FROM stock_movements`,
        [tz],
      );
      const window = accrualWindow(
        throughDate,
        lastThrough,
        first.rows[0]?.day ?? null,
        this.correctionDays,
      );

      const schedules = await loadSchedules(client);
      // Full history up to the window's end: minimum-period top-ups need to
      // know which stock is oldest.
      const events = await loadLedgerEvents(client, tz, window.to);
      const accrued = await loadAccruedTotals(client, window.from, window.to);
      const expected = computeExpectedCharges({
        events,
        schedules,
        from: window.from,
        to: window.to,
      });
      const rows = accrualRows(expected, accrued, scheduleLookup(schedules));

      const run = await client.query<{ id: string }>(
        `INSERT INTO fee_accrual_runs (from_date, through_date, rows_written, started_at, finished_at)
         VALUES ($1, $2, $3, $4, clock_timestamp()) RETURNING id`,
        [window.from, window.to, rows.length, startedAt],
      );
      const runId = run.rows[0]?.id;
      if (runId === undefined) throw new Error('accrual run insert returned no row');

      await insertAccrualRows(client, rows, { runId });

      return {
        run_id: runId,
        from_date: window.from,
        through_date: window.to,
        rows_written: rows.length,
        amount_ngn: roundHalfAway(rows.reduce((sum, row) => sum + row.amountNgn, 0)),
      };
    });
  }

  // --- Statement ---------------------------------------------------------------

  /**
   * A farmer's statement at one warehouse for `from`-`to` (business dates,
   * inclusive): stock in and out, fees accrued, payments, and what is owed.
   */
  async statement(
    farmerId: string,
    warehouseId: string,
    period: { from?: string | undefined; to?: string | undefined },
  ): Promise<FarmerStatement> {
    const header = await this.statementHeader(farmerId, warehouseId);
    const tz = this.config.businessTimeZone;
    const to = period.to ?? this.today();
    let from = period.from;
    if (from === undefined) {
      const first = await this.pool.query<{ day: string | null }>(
        `SELECT to_char(min((occurred_at AT TIME ZONE $3)::date), 'YYYY-MM-DD') AS day
         FROM stock_movements WHERE farmer_id = $1 AND warehouse_id = $2`,
        [farmerId, warehouseId, tz],
      );
      const day = first.rows[0]?.day ?? null;
      from = day !== null && day < to ? day : to;
    }
    if (from > to) {
      throw new ValidationError('Request is invalid', {
        details: [{ code: 'invalid_query', field: 'from', message: 'from must not be after to' }],
      });
    }

    const params = [farmerId, warehouseId, from, to, tz];
    const [opening, movements, closing, fees, byKind, payments, accruedThrough] = await Promise.all(
      [
        this.balancesAt(farmerId, warehouseId, '<', from),
        this.pool.query<{
          date: string;
          occurred_at: Date;
          kind: MovementKind;
          commodity: string;
          grading_scheme: string;
          grade: string;
          bags_delta: number;
          kg_delta: string;
          deposit_id: string | null;
          dispatch_id: string | null;
          delivery_note_no: string | null;
          adjustment_id: string | null;
        }>(
          `SELECT to_char((m.occurred_at AT TIME ZONE $5)::date, 'YYYY-MM-DD') AS date,
                  m.occurred_at, m.kind, m.commodity, m.grading_scheme, m.grade, m.bags_delta,
                  m.kg_delta, m.deposit_id, m.dispatch_id, d.delivery_note_no, m.adjustment_id
           FROM stock_movements m
           LEFT JOIN dispatches d ON d.id = m.dispatch_id
           WHERE m.farmer_id = $1 AND m.warehouse_id = $2
             AND (m.occurred_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
           ORDER BY m.occurred_at, m.id`,
          params,
        ),
        this.balancesAt(farmerId, warehouseId, '<=', to),
        this.pool.query<{
          accrued_before: string;
          accrued_through: string;
          paid_before: string;
          paid_through: string;
        }>(
          `SELECT
             (SELECT COALESCE(sum(amount_ngn), 0) FROM storage_fee_accruals
               WHERE farmer_id = $1 AND warehouse_id = $2 AND accrual_date < $3::date)
               AS accrued_before,
             (SELECT COALESCE(sum(amount_ngn), 0) FROM storage_fee_accruals
               WHERE farmer_id = $1 AND warehouse_id = $2 AND accrual_date <= $4::date)
               AS accrued_through,
             (SELECT COALESCE(sum(amount_ngn), 0) FROM fee_payments
               WHERE farmer_id = $1 AND warehouse_id = $2 AND paid_on < $3::date)
             - (SELECT COALESCE(sum(p.amount_ngn), 0) FROM fee_payment_reversals r
                JOIN fee_payments p ON p.id = r.payment_id
                WHERE p.farmer_id = $1 AND p.warehouse_id = $2
                  AND (r.reversed_at AT TIME ZONE $5)::date < $3::date) AS paid_before,
             (SELECT COALESCE(sum(amount_ngn), 0) FROM fee_payments
               WHERE farmer_id = $1 AND warehouse_id = $2 AND paid_on <= $4::date)
             - (SELECT COALESCE(sum(p.amount_ngn), 0) FROM fee_payment_reversals r
                JOIN fee_payments p ON p.id = r.payment_id
                WHERE p.farmer_id = $1 AND p.warehouse_id = $2
                  AND (r.reversed_at AT TIME ZONE $5)::date <= $4::date) AS paid_through`,
          params,
        ),
        this.pool.query<{ kind: string; amount_ngn: string }>(
          `SELECT CASE WHEN cancellation_id IS NULL THEN kind ELSE 'cancellation_reversal' END
                    AS kind,
                  sum(amount_ngn) AS amount_ngn
           FROM storage_fee_accruals
           WHERE farmer_id = $1 AND warehouse_id = $2
             AND accrual_date BETWEEN $3::date AND $4::date
           GROUP BY 1`,
          [farmerId, warehouseId, from, to],
        ),
        this.pool.query<PaymentRow>(
          `${paymentSelect('$5')}
           WHERE p.farmer_id = $1 AND p.warehouse_id = $2
             AND (p.paid_on BETWEEN $3::date AND $4::date
                  OR (r.reversed_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date)
           ORDER BY p.paid_on, p.created_at`,
          params,
        ),
        lastAccruedDate(this.pool),
      ],
    );

    const totals = fees.rows[0];
    const kindTotal = (kind: string) =>
      ngn(byKind.rows.find((row) => row.kind === kind)?.amount_ngn ?? 0);

    return {
      ...header,
      period: { from, to },
      accrued_through: accruedThrough,
      stock: {
        opening,
        movements: movements.rows.map((row) => ({ ...row, kg_delta: kg(row.kg_delta) })),
        closing,
      },
      fees: {
        ...feeStatementFigures({
          accruedBeforeStart: Number(totals?.accrued_before ?? 0),
          accruedThroughEnd: Number(totals?.accrued_through ?? 0),
          paidBeforeStart: Number(totals?.paid_before ?? 0),
          paidThroughEnd: Number(totals?.paid_through ?? 0),
        }),
        accrued_by_kind: {
          daily: kindTotal('daily'),
          correction: kindTotal('correction'),
          minimum_topup: kindTotal('minimum_topup'),
          cancellation_reversal: kindTotal('cancellation_reversal'),
        },
        payments: payments.rows.map(toPaymentView),
      },
    };
  }

  /**
   * The "fee statement" event: texts the farmer what they owe at this
   * warehouse. A POST, so a GET of the statement never sends anything.
   */
  async notifyStatement(
    farmerId: string,
    warehouseId: string,
    requestedBy: string,
  ): Promise<{ notification_id: string; status: string; outstanding_ngn: number; body: string }> {
    const header = await this.statementHeader(farmerId, warehouseId);
    await resolveActor(this.pool, requestedBy, warehouseId, 'requested_by');
    const outstanding = fromKobo(await this.outstanding(this.pool, farmerId, warehouseId));
    const body = feeStatementSms({
      warehouseName: header.warehouse.name,
      outstandingNgn: outstanding,
      accruedThrough: await lastAccruedDate(this.pool),
    });
    const id = await this.notifications.queue(this.pool, {
      farmerId,
      template: 'fee_statement',
      body,
    });
    if (id === null) throw new NotFoundError('Farmer not found');
    await this.notifications.deliver([id]);
    const { rows } = await this.pool.query<{ status: string }>(
      'SELECT status FROM notifications WHERE id = $1',
      [id],
    );
    return {
      notification_id: id,
      status: rows[0]?.status ?? 'queued',
      outstanding_ngn: outstanding,
      body,
    };
  }

  // --- Payments -------------------------------------------------------------------

  /**
   * Records a payment the warehouse received (no money moves through
   * Farmledge). Idempotent on the warehouse's `reference`; rejected with
   * 409 `payment_exceeds_outstanding` if it is more than is owed.
   */
  async recordPayment(
    input: PaymentInput,
  ): Promise<{ kind: 'created' | 'duplicate'; payment: PaymentView; outstanding_ngn: number }> {
    const validated = validatePayment(input, this.today());
    if (!validated.ok) {
      throw new ValidationError('Payment is invalid', { details: validated.errors });
    }
    const payment = validated.value;
    const warehouseId = input.warehouseId.toLowerCase();
    const farmerId = input.farmerId.toLowerCase();
    const recordedBy = input.recordedBy.toLowerCase();

    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: warehouseId, field: 'warehouse_id', mustBeActive: false },
      custodian: { id: recordedBy, field: 'recorded_by' },
      farmer: { id: farmerId, field: 'farmer_id' },
    });
    if (referenceErrors.length > 0) {
      throw new ValidationError('Payment is invalid', { details: referenceErrors });
    }

    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `fee_payment|${warehouseId}`,
      ]);
      const existing = await client.query<PaymentRow>(
        `${paymentSelect('$3')} WHERE p.warehouse_id = $1 AND p.reference = $2`,
        [warehouseId, payment.reference, this.config.businessTimeZone],
      );
      const found = existing.rows[0];
      if (found !== undefined) {
        const compared: [string, unknown, unknown][] = [
          ['farmer_id', found.farmer_id, farmerId],
          ['amount_ngn', toKobo(Number(found.amount_ngn)), toKobo(payment.amountNgn)],
          ['paid_on', found.paid_on, payment.paidOn],
          ['method', found.method, payment.method],
        ];
        const differing = compared.filter(([, a, b]) => a !== b).map(([field]) => field);
        if (differing.length > 0) {
          throw new ConflictError('This reference is already recorded for a different payment', {
            code: 'payment_reference_conflict',
            details: { reference: payment.reference, differing_fields: differing },
          });
        }
        return {
          kind: 'duplicate' as const,
          payment: toPaymentView(found),
          outstanding_ngn: fromKobo(await this.outstanding(client, farmerId, warehouseId)),
        };
      }

      const outstanding = await this.outstanding(client, farmerId, warehouseId);
      if (toKobo(payment.amountNgn) > outstanding) {
        throw new ConflictError(
          `The farmer owes ${fromKobo(outstanding).toFixed(2)} NGN; the payment is more than that`,
          {
            code: 'payment_exceeds_outstanding',
            details: { outstanding_ngn: fromKobo(outstanding) },
          },
        );
      }
      const { rows } = await client.query<PaymentRow>(
        `INSERT INTO fee_payments (warehouse_id, farmer_id, amount_ngn, reference, paid_on,
                                   method, notes, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, warehouse_id, farmer_id, amount_ngn, reference,
                   to_char(paid_on, 'YYYY-MM-DD') AS paid_on, method, notes, recorded_by,
                   created_at, NULL::json AS reversal`,
        [
          warehouseId,
          farmerId,
          payment.amountNgn.toFixed(2),
          payment.reference,
          payment.paidOn,
          payment.method,
          payment.notes,
          recordedBy,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('payment insert returned no row');
      return {
        kind: 'created' as const,
        payment: toPaymentView(row),
        outstanding_ngn: fromKobo(outstanding - toKobo(payment.amountNgn)),
      };
    });
  }

  /**
   * Reverses a payment recorded in error. Owner only (403 `owner_required`),
   * with a reason; the payment stays on record with its reversal beside it.
   */
  async reversePayment(
    paymentId: string,
    input: { readonly reversedBy: string; readonly reason: string },
  ): Promise<{ payment: PaymentView; outstanding_ngn: number }> {
    const tz = this.config.businessTimeZone;
    const found = await this.pool.query<PaymentRow>(`${paymentSelect('$2')} WHERE p.id = $1`, [
      paymentId,
      tz,
    ]);
    const payment = found.rows[0];
    if (payment === undefined) throw new NotFoundError('Payment not found');
    const errors: DomainError[] = [];
    const reason = checkReason(input.reason, errors);
    if (reason === null) throw new ValidationError('Reversal is invalid', { details: errors });
    await requireOwner(
      this.pool,
      input.reversedBy,
      payment.warehouse_id,
      'reversed_by',
      'reverse a payment',
    );

    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `fee_payment|${payment.warehouse_id}`,
      ]);
      try {
        await client.query(
          `INSERT INTO fee_payment_reversals (payment_id, warehouse_id, reason, reversed_by, reversed_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [paymentId, payment.warehouse_id, reason, input.reversedBy.toLowerCase(), this.clock()],
        );
      } catch (err) {
        if (isPgError(err, PgErrorCode.uniqueViolation)) {
          throw new ConflictError('This payment is already reversed', {
            code: 'payment_already_reversed',
          });
        }
        throw err;
      }
      const reversed = await client.query<PaymentRow>(`${paymentSelect('$2')} WHERE p.id = $1`, [
        paymentId,
        tz,
      ]);
      const row = reversed.rows[0];
      if (row === undefined) throw new Error('payment vanished while reversing');
      return {
        payment: toPaymentView(row),
        outstanding_ngn: fromKobo(
          await this.outstanding(client, payment.farmer_id, payment.warehouse_id),
        ),
      };
    });
  }

  /** Farmers who owe storage fees at a warehouse, largest first. */
  async outstandingByFarmer(warehouseId: string): Promise<OutstandingFeesView> {
    await this.assertWarehouse(warehouseId);
    const { rows } = await this.pool.query<{
      farmer_id: string;
      full_name: string;
      phone: string;
      accrued: string;
      paid: string;
    }>(
      `SELECT f.id AS farmer_id, f.full_name, f.phone,
              COALESCE((SELECT sum(amount_ngn) FROM storage_fee_accruals a
                        WHERE a.farmer_id = f.id AND a.warehouse_id = $1), 0) AS accrued,
              COALESCE((SELECT sum(p.amount_ngn) FROM fee_payments p
                        WHERE p.farmer_id = f.id AND p.warehouse_id = $1
                          AND NOT EXISTS (SELECT 1 FROM fee_payment_reversals r
                                          WHERE r.payment_id = p.id)), 0) AS paid
       FROM farmers f
       JOIN farmer_warehouses fw ON fw.farmer_id = f.id AND fw.warehouse_id = $1`,
      [warehouseId],
    );
    const farmers = rows
      .map((row) => {
        const accrued = toKobo(Number(row.accrued));
        const paid = toKobo(Number(row.paid));
        return {
          farmer_id: row.farmer_id,
          full_name: row.full_name,
          phone: row.phone,
          accrued_ngn: fromKobo(accrued),
          paid_ngn: fromKobo(paid),
          outstanding_ngn: fromKobo(accrued - paid),
        };
      })
      .filter((farmer) => farmer.outstanding_ngn > 0)
      .sort((a, b) => b.outstanding_ngn - a.outstanding_ngn);
    const sum = (pick: (farmer: (typeof farmers)[number]) => number) =>
      fromKobo(farmers.reduce((total, farmer) => total + toKobo(pick(farmer)), 0));
    return {
      warehouse_id: warehouseId,
      accrued_through: await lastAccruedDate(this.pool),
      farmers,
      totals: {
        accrued_ngn: sum((farmer) => farmer.accrued_ngn),
        paid_ngn: sum((farmer) => farmer.paid_ngn),
        outstanding_ngn: sum((farmer) => farmer.outstanding_ngn),
      },
    };
  }

  // --- Helpers ---------------------------------------------------------------------

  /** What the farmer owes at the warehouse now, in kobo. */
  private async outstanding(db: Queryable, farmerId: string, warehouseId: string): Promise<number> {
    const { rows } = await db.query<{ accrued: string; paid: string }>(
      `SELECT
         (SELECT COALESCE(sum(amount_ngn), 0) FROM storage_fee_accruals
           WHERE farmer_id = $1 AND warehouse_id = $2) AS accrued,
         (${NET_PAID}) AS paid`,
      [farmerId, warehouseId],
    );
    return outstandingKobo(Number(rows[0]?.accrued ?? 0), Number(rows[0]?.paid ?? 0));
  }

  /** Balances from movements before (`<`) or up to (`<=`) a business date. */
  private async balancesAt(
    farmerId: string,
    warehouseId: string,
    comparison: '<' | '<=',
    date: string,
  ): Promise<StatementBalance[]> {
    const { rows } = await this.pool.query<{
      commodity: string;
      grading_scheme: string;
      grade: string;
      bags: string;
      kg: string;
    }>(
      `SELECT commodity, grading_scheme, grade, sum(bags_delta) AS bags, sum(kg_delta) AS kg
       FROM stock_movements
       WHERE farmer_id = $1 AND warehouse_id = $2
         AND (occurred_at AT TIME ZONE $4)::date ${comparison} $3::date
       GROUP BY commodity, grading_scheme, grade
       HAVING sum(bags_delta) <> 0 OR sum(kg_delta) <> 0
       ORDER BY commodity, grading_scheme, grade`,
      [farmerId, warehouseId, date, this.config.businessTimeZone],
    );
    return rows.map((row) => ({ ...row, bags: Number(row.bags), kg: kg(row.kg) }));
  }

  private async statementHeader(
    farmerId: string,
    warehouseId: string,
  ): Promise<Pick<FarmerStatement, 'farmer' | 'warehouse'>> {
    const { rows } = await this.pool.query<{
      farmer_id: string;
      full_name: string;
      phone: string;
      warehouse_id: string | null;
      code: string | null;
      name: string | null;
      registered: boolean;
    }>(
      `SELECT f.id AS farmer_id, f.full_name, f.phone, w.id AS warehouse_id, w.code, w.name,
              EXISTS (SELECT 1 FROM farmer_warehouses fw
                      WHERE fw.farmer_id = f.id AND fw.warehouse_id = $2) AS registered
       FROM farmers f LEFT JOIN warehouses w ON w.id = $2
       WHERE f.id = $1`,
      [farmerId, warehouseId],
    );
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('Farmer not found');
    if (row.warehouse_id === null || row.code === null || row.name === null) {
      throw new NotFoundError('Warehouse not found');
    }
    if (!row.registered) {
      throw new ValidationError('Request is invalid', {
        details: [
          {
            code: 'farmer_not_at_warehouse',
            field: 'warehouse',
            message: 'Farmer is not registered at this warehouse',
          },
        ],
      });
    }
    return {
      farmer: { id: row.farmer_id, full_name: row.full_name, phone: row.phone },
      warehouse: { id: row.warehouse_id, code: row.code, name: row.name },
    };
  }

  private async assertWarehouse(warehouseId: string): Promise<void> {
    const found = await this.pool.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId]);
    if (found.rowCount === 0) throw new NotFoundError('Warehouse not found');
  }
}

/** The last business date storage fees have been accrued through. */
export async function lastAccruedDate(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ day: string | null }>(
    `SELECT to_char(max(through_date), 'YYYY-MM-DD') AS day FROM fee_accrual_runs`,
  );
  return rows[0]?.day ?? null;
}

// --- Accrual building blocks (also used to reverse a cancelled deposit) ---------

/** Every fee schedule, per warehouse. */
export async function loadSchedules(db: Queryable): Promise<Map<string, FeeSchedule[]>> {
  const { rows } = await db.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM storage_fee_schedules`,
  );
  const schedules = new Map<string, FeeSchedule[]>();
  for (const row of rows) {
    const list = schedules.get(row.warehouse_id) ?? [];
    list.push(toSchedule(row));
    schedules.set(row.warehouse_id, list);
  }
  return schedules;
}

export function scheduleLookup(
  schedules: ReadonlyMap<string, readonly FeeSchedule[]>,
): (warehouseId: string, commodity: string, date: string) => string | null {
  return (warehouseId, commodity, date) =>
    scheduleOn(schedules.get(warehouseId) ?? [], date, commodity)?.id ?? null;
}

/**
 * Ledger movements up to `to` (business date), at warehouses with a fee
 * schedule, optionally for one balance only.
 */
export async function loadLedgerEvents(
  db: Queryable,
  timeZone: string,
  to: string,
  key?: BalanceKey,
): Promise<LedgerEvent[]> {
  const { rows } = await db.query<{
    kind: MovementKind;
    warehouse_id: string;
    farmer_id: string;
    commodity: string;
    grading_scheme: string;
    grade: string;
    day: string;
    bags_delta: number;
    kg_delta: string;
    deposit_id: string | null;
  }>(
    `SELECT kind, warehouse_id, farmer_id, commodity, grading_scheme, grade,
            to_char((occurred_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
            bags_delta, kg_delta, deposit_id
     FROM stock_movements
     WHERE (occurred_at AT TIME ZONE $1)::date <= $2::date
       AND warehouse_id IN (SELECT warehouse_id FROM storage_fee_schedules)
       AND ($3::text IS NULL OR concat_ws('|', warehouse_id, farmer_id, commodity,
                                          grading_scheme, grade) = $3)`,
    [timeZone, to, key === undefined ? null : balanceKeyString(key)],
  );
  return rows.map((row) => ({
    kind: row.kind,
    warehouseId: row.warehouse_id,
    farmerId: row.farmer_id,
    commodity: row.commodity,
    gradingScheme: row.grading_scheme,
    grade: row.grade,
    day: row.day,
    bagsDelta: row.bags_delta,
    centiKgDelta: toCentiKg(row.kg_delta),
    depositId: row.deposit_id,
  }));
}

/** What has been charged per balance, day and charge kind, optionally for one balance. */
export async function loadAccruedTotals(
  db: Queryable,
  from: string,
  to: string,
  key?: BalanceKey,
): Promise<AccruedTotal[]> {
  const { rows } = await db.query<{
    warehouse_id: string;
    farmer_id: string;
    commodity: string;
    grading_scheme: string;
    grade: string;
    kind: 'storage' | 'minimum_topup';
    date: string;
    amount_ngn: string;
  }>(
    `SELECT warehouse_id, farmer_id, commodity, grading_scheme, grade,
            CASE WHEN kind = 'minimum_topup' THEN 'minimum_topup' ELSE 'storage' END AS kind,
            to_char(accrual_date, 'YYYY-MM-DD') AS date, sum(amount_ngn) AS amount_ngn
     FROM storage_fee_accruals
     WHERE accrual_date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR concat_ws('|', warehouse_id, farmer_id, commodity,
                                          grading_scheme, grade) = $3)
     GROUP BY 1, 2, 3, 4, 5, 6, 7`,
    [from, to, key === undefined ? null : balanceKeyString(key)],
  );
  return rows.map((row) => ({
    warehouseId: row.warehouse_id,
    farmerId: row.farmer_id,
    commodity: row.commodity,
    gradingScheme: row.grading_scheme,
    grade: row.grade,
    kind: row.kind,
    date: row.date,
    amountNgn: Number(row.amount_ngn),
  }));
}

/** Appends accrual rows from a run, or as contra entries of a cancellation. */
export async function insertAccrualRows(
  db: Queryable,
  rows: readonly AccrualRow[],
  source: { readonly runId: string } | { readonly cancellationId: string },
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO storage_fee_accruals (warehouse_id, farmer_id, commodity, grading_scheme,
                                       grade, accrual_date, schedule_id, kind, bags, kg,
                                       amount_ngn, run_id, cancellation_id)
     SELECT r.warehouse_id, r.farmer_id, r.commodity, r.grading_scheme, r.grade,
            r.accrual_date, r.schedule_id, r.kind, r.bags, r.kg, r.amount_ngn, $2, $3
     FROM json_to_recordset($1::json) AS r(
       warehouse_id UUID, farmer_id UUID, commodity TEXT, grading_scheme TEXT, grade TEXT,
       accrual_date DATE, schedule_id UUID, kind TEXT, bags INTEGER, kg NUMERIC,
       amount_ngn NUMERIC)`,
    [
      JSON.stringify(
        rows.map((row) => ({
          warehouse_id: row.warehouseId,
          farmer_id: row.farmerId,
          commodity: row.commodity,
          grading_scheme: row.gradingScheme,
          grade: row.grade,
          accrual_date: row.date,
          schedule_id: row.scheduleId,
          kind: row.kind,
          bags: row.bags,
          kg: (row.centiKg / 100).toFixed(2),
          amount_ngn: row.amountNgn.toFixed(4),
        })),
      ),
      'runId' in source ? source.runId : null,
      'cancellationId' in source ? source.cancellationId : null,
    ],
  );
}
