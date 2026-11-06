import { COMMODITIES } from '../config/index.js';
import { addDays, checkDate, daysBetween, daysInMonth, eachDay } from './dates.js';
import { domainError, fail, ok, type DomainError, type Result } from './errors.js';
import { balanceKeyString, type BalanceKey, type MovementKind } from './ledger.js';
import { roundHalfAway } from './quantities.js';

/**
 * Storage fees a warehouse charges its farmers (docs/decisions.md D14-D16).
 * Everything here is pure arithmetic on dates (`YYYY-MM-DD` in the business
 * time zone) and ledger events; the service loads and stores the rows.
 */

export type FeeBasis = 'per_bag' | 'per_tonne';
export type FeePeriod = 'day' | 'week' | 'month';
export const FEE_BASES: readonly FeeBasis[] = ['per_bag', 'per_tonne'];
export const FEE_PERIODS: readonly FeePeriod[] = ['day', 'week', 'month'];

/** Amounts are stored to 4 decimals of a naira and shown to 2 (kobo). */
const AMOUNT_DECIMALS = 4;
/** Differences smaller than this are rounding noise, not a correction. */
const AMOUNT_EPSILON = 0.00005;

export interface FeeSchedule {
  readonly id: string;
  /** Null: the warehouse default, used when no schedule for the commodity is in force. */
  readonly commodity: string | null;
  readonly basis: FeeBasis;
  readonly period: FeePeriod;
  readonly rateNgn: number;
  readonly minimumDays: number | null;
  readonly effectiveFrom: string;
}

/**
 * The schedule in force on `date` for `commodity`: the latest one for that
 * commodity starting on or before the date; failing that, the latest
 * warehouse default (no commodity).
 */
export function scheduleOn(
  schedules: readonly FeeSchedule[],
  date: string,
  commodity: string | null = null,
): FeeSchedule | null {
  const latest = (match: (schedule: FeeSchedule) => boolean) => {
    let found: FeeSchedule | null = null;
    for (const schedule of schedules) {
      if (
        match(schedule) &&
        schedule.effectiveFrom <= date &&
        (found === null || schedule.effectiveFrom > found.effectiveFrom)
      ) {
        found = schedule;
      }
    }
    return found;
  };
  return (
    (commodity === null ? null : latest((schedule) => schedule.commodity === commodity)) ??
    latest((schedule) => schedule.commodity === null)
  );
}

/**
 * The rate for one bag (or tonne) for one day. A weekly rate is a seventh
 * per day; a monthly rate is spread over the days of that calendar month,
 * so a full month adds up to the monthly rate.
 */
export function dailyRate(schedule: FeeSchedule, date: string): number {
  switch (schedule.period) {
    case 'day':
      return schedule.rateNgn;
    case 'week':
      return schedule.rateNgn / 7;
    case 'month':
      return schedule.rateNgn / daysInMonth(date);
  }
}

/** Units charged for: bags, or tonnes of kg. */
function units(schedule: FeeSchedule, bags: number, centiKg: number): number {
  return schedule.basis === 'per_bag' ? bags : centiKg / 100 / 1000;
}

/** One day's charge on a balance, to 4 decimals. */
export function dailyCharge(
  schedule: FeeSchedule,
  date: string,
  bags: number,
  centiKg: number,
): number {
  return roundHalfAway(dailyRate(schedule, date) * units(schedule, bags, centiKg), AMOUNT_DECIMALS);
}

// --- Accrual ----------------------------------------------------------------

/** A ledger movement reduced to what accrual needs. */
export interface LedgerEvent extends BalanceKey {
  readonly kind: MovementKind;
  /** Business date the movement physically happened. */
  readonly day: string;
  readonly bagsDelta: number;
  readonly centiKgDelta: number;
  /** For deposit movements: which deposit, so a void removes the right lot. */
  readonly depositId: string | null;
}

export type ChargeKind = 'storage' | 'minimum_topup';

/** What should have been charged for one balance on one day. */
export interface ExpectedCharge extends BalanceKey {
  readonly kind: ChargeKind;
  readonly date: string;
  readonly scheduleId: string;
  readonly bags: number;
  readonly centiKg: number;
  readonly amountNgn: number;
}

export interface AccrualInput {
  /** Every movement up to `to` for the warehouses being accrued, in any order. */
  readonly events: readonly LedgerEvent[];
  /** Fee schedules per warehouse. */
  readonly schedules: ReadonlyMap<string, readonly FeeSchedule[]>;
  /** First and last day to compute, inclusive. */
  readonly from: string;
  readonly to: string;
}

/**
 * Charges for every day from `from` to `to`:
 * - `storage`: each day's charge on the end-of-day balance, under the
 *   schedule in force that day;
 * - `minimum_topup`: when a dispatch takes bags out before the schedule's
 *   minimum period, the missing days. Dispatched bags are matched to the
 *   farmer's oldest stock first, and the minimum and rate are those of the
 *   schedule in force when that stock came in.
 */
export function computeExpectedCharges(input: AccrualInput): ExpectedCharge[] {
  const byKey = new Map<string, LedgerEvent[]>();
  for (const event of input.events) {
    const id = balanceKeyString(event);
    const list = byKey.get(id) ?? [];
    list.push(event);
    byKey.set(id, list);
  }

  const charges: ExpectedCharge[] = [];
  for (const events of byKey.values()) {
    const sorted = [...events].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const first = sorted[0];
    if (first === undefined) continue;
    const schedules = input.schedules.get(first.warehouseId) ?? [];
    charges.push(...storageCharges(sorted, schedules, input.from, input.to));
    charges.push(...minimumTopups(sorted, schedules, input.from, input.to));
  }
  return charges;
}

function keyOf(event: BalanceKey): BalanceKey {
  return {
    warehouseId: event.warehouseId,
    farmerId: event.farmerId,
    commodity: event.commodity,
    gradingScheme: event.gradingScheme,
    grade: event.grade,
  };
}

function storageCharges(
  sorted: readonly LedgerEvent[],
  schedules: readonly FeeSchedule[],
  from: string,
  to: string,
): ExpectedCharge[] {
  const first = sorted[0];
  if (first === undefined) return [];
  const key = keyOf(first);
  const charges: ExpectedCharge[] = [];
  let bags = 0;
  let centiKg = 0;
  let next = 0;
  // Balance before the window.
  while (next < sorted.length && (sorted[next]?.day ?? '') < from) {
    bags += sorted[next]?.bagsDelta ?? 0;
    centiKg += sorted[next]?.centiKgDelta ?? 0;
    next += 1;
  }
  for (const date of eachDay(from, to)) {
    while (next < sorted.length && sorted[next]?.day === date) {
      bags += sorted[next]?.bagsDelta ?? 0;
      centiKg += sorted[next]?.centiKgDelta ?? 0;
      next += 1;
    }
    if (bags <= 0 && centiKg <= 0) continue;
    const schedule = scheduleOn(schedules, date, key.commodity);
    if (schedule === null) continue;
    const amountNgn = dailyCharge(schedule, date, bags, centiKg);
    if (amountNgn === 0) continue;
    charges.push({
      ...key,
      kind: 'storage',
      date,
      scheduleId: schedule.id,
      bags,
      centiKg,
      amountNgn,
    });
  }
  return charges;
}

interface Lot {
  readonly day: string;
  readonly depositId: string | null;
  bags: number;
  centiKg: number;
}

function minimumTopups(
  sorted: readonly LedgerEvent[],
  schedules: readonly FeeSchedule[],
  from: string,
  to: string,
): ExpectedCharge[] {
  const first = sorted[0];
  if (first === undefined) return [];
  const key = keyOf(first);
  // Per dispatch day and schedule: bags, kg and amount topped up.
  const topups = new Map<
    string,
    { date: string; scheduleId: string; bags: number; centiKg: number; amount: number }
  >();
  const lots: Lot[] = [];

  for (const event of sorted) {
    if (event.bagsDelta > 0) {
      lots.push({
        day: event.day,
        depositId: event.depositId,
        bags: event.bagsDelta,
        centiKg: event.centiKgDelta,
      });
      continue;
    }
    let remaining = -event.bagsDelta;
    // A void removes its own deposit first; anything beyond that (bags of
    // it already dispatched) comes off the oldest stock like any outflow.
    const voided =
      event.kind === 'deposit_void' ? lots.filter((lot) => lot.depositId === event.depositId) : [];
    for (const lot of [...voided, ...lots]) {
      if (remaining === 0) break;
      if (lot.bags === 0) continue;
      const taken = Math.min(lot.bags, remaining);
      const takenCentiKg =
        taken === lot.bags ? lot.centiKg : Math.round((lot.centiKg * taken) / lot.bags);
      lot.bags -= taken;
      lot.centiKg -= takenCentiKg;
      remaining -= taken;

      // Only dispatches inside the window owe a top-up; adjustments (spoilage,
      // corrections) are not the farmer taking stock out.
      if (event.kind !== 'dispatch_out' || event.day < from || event.day > to) continue;
      const schedule = scheduleOn(schedules, lot.day, key.commodity);
      if (schedule?.minimumDays == null) continue;
      const stored = daysBetween(lot.day, event.day);
      if (stored >= schedule.minimumDays) continue;
      let amount = 0;
      for (let i = 0; i < schedule.minimumDays - stored; i += 1) {
        amount += dailyCharge(schedule, addDays(event.day, i), taken, takenCentiKg);
      }
      const id = `${event.day}|${schedule.id}`;
      const topup = topups.get(id) ?? {
        date: event.day,
        scheduleId: schedule.id,
        bags: 0,
        centiKg: 0,
        amount: 0,
      };
      topup.bags += taken;
      topup.centiKg += takenCentiKg;
      topup.amount += amount;
      topups.set(id, topup);
    }
  }

  return [...topups.values()].map((topup) => ({
    ...key,
    kind: 'minimum_topup' as const,
    date: topup.date,
    scheduleId: topup.scheduleId,
    bags: topup.bags,
    centiKg: topup.centiKg,
    amountNgn: roundHalfAway(topup.amount, AMOUNT_DECIMALS),
  }));
}

/** What has already been charged for one balance, day and charge kind. */
export interface AccruedTotal extends BalanceKey {
  readonly kind: ChargeKind;
  readonly date: string;
  readonly amountNgn: number;
}

export type AccrualRowKind = 'daily' | 'correction' | 'minimum_topup';

export interface AccrualRow extends BalanceKey {
  readonly kind: AccrualRowKind;
  readonly date: string;
  readonly scheduleId: string;
  readonly bags: number;
  readonly centiKg: number;
  readonly amountNgn: number;
}

/**
 * Rows to append so that what is charged equals what is expected. A day
 * charged for the first time gets a `daily` row; a day already charged gets
 * a `correction` for the difference (stock captured offline that arrived
 * late, or a deposit voided). Existing rows are never changed. Running it
 * again with nothing new returns nothing, so accrual is idempotent.
 */
export function accrualRows(
  expected: readonly ExpectedCharge[],
  accrued: readonly AccruedTotal[],
  scheduleFor: (warehouseId: string, commodity: string, date: string) => string | null,
): AccrualRow[] {
  const id = (row: BalanceKey & { kind: ChargeKind; date: string }) =>
    `${balanceKeyString(row)}|${row.kind}|${row.date}`;
  const already = new Map(accrued.map((row) => [id(row), row]));
  const rows: AccrualRow[] = [];

  for (const charge of expected) {
    const previous = already.get(id(charge));
    already.delete(id(charge));
    const difference = roundHalfAway(
      charge.amountNgn - (previous?.amountNgn ?? 0),
      AMOUNT_DECIMALS,
    );
    if (Math.abs(difference) < AMOUNT_EPSILON) continue;
    rows.push({
      ...keyOf(charge),
      kind:
        charge.kind === 'minimum_topup'
          ? 'minimum_topup'
          : previous === undefined
            ? 'daily'
            : 'correction',
      date: charge.date,
      scheduleId: charge.scheduleId,
      bags: charge.bags,
      centiKg: charge.centiKg,
      amountNgn: difference,
    });
  }

  // Charged before, but nothing is owed for that day now: reverse it.
  for (const previous of already.values()) {
    if (Math.abs(previous.amountNgn) < AMOUNT_EPSILON) continue;
    const scheduleId = scheduleFor(previous.warehouseId, previous.commodity, previous.date);
    if (scheduleId === null) continue;
    rows.push({
      ...keyOf(previous),
      kind: previous.kind === 'minimum_topup' ? 'minimum_topup' : 'correction',
      date: previous.date,
      scheduleId,
      bags: 0,
      centiKg: 0,
      amountNgn: roundHalfAway(-previous.amountNgn, AMOUNT_DECIMALS),
    });
  }
  return rows;
}

/**
 * Days the accrual job recomputes: from the day after the last run (or the
 * first movement) to `through`, and always the last `correctionDays`, which
 * cover the oldest offline capture the API accepts.
 */
export function accrualWindow(
  through: string,
  lastThrough: string | null,
  firstMovementDay: string | null,
  correctionDays: number,
): { from: string; to: string } {
  const correctionFrom = addDays(through, -(correctionDays - 1));
  let from = lastThrough === null ? (firstMovementDay ?? through) : addDays(lastThrough, 1);
  if (correctionFrom < from) from = correctionFrom;
  if (from > through) from = through;
  return { from, to: through };
}

// --- Statement arithmetic -----------------------------------------------------

/** Naira to whole kobo, rounding half away from zero. */
export function toKobo(ngn: number): number {
  return Math.round(roundHalfAway(ngn, 2) * 100);
}

export function fromKobo(kobo: number): number {
  return kobo / 100;
}

export interface FeeTotals {
  /** Everything accrued up to the end of the period (4-decimal sum). */
  readonly accruedThroughEnd: number;
  /** Everything accrued before the period started. */
  readonly accruedBeforeStart: number;
  readonly paidThroughEnd: number;
  readonly paidBeforeStart: number;
}

export interface FeeStatementFigures {
  readonly opening_outstanding_ngn: number;
  readonly accrued_ngn: number;
  readonly paid_ngn: number;
  readonly closing_outstanding_ngn: number;
}

/**
 * Opening + accrued − paid = closing, exactly, in kobo. Accruals are kept to
 * 4 decimals, so totals are rounded to kobo before differencing; the
 * period's accrued figure is the difference of two rounded totals, which
 * keeps the identity exact.
 */
export function feeStatementFigures(totals: FeeTotals): FeeStatementFigures {
  const accruedEnd = toKobo(totals.accruedThroughEnd);
  const accruedStart = toKobo(totals.accruedBeforeStart);
  const paidEnd = toKobo(totals.paidThroughEnd);
  const paidStart = toKobo(totals.paidBeforeStart);
  return {
    opening_outstanding_ngn: fromKobo(accruedStart - paidStart),
    accrued_ngn: fromKobo(accruedEnd - accruedStart),
    paid_ngn: fromKobo(paidEnd - paidStart),
    closing_outstanding_ngn: fromKobo(accruedEnd - paidEnd),
  };
}

/** Amount owed now: everything accrued, rounded to kobo, less everything paid. */
export function outstandingKobo(accrued: number, paid: number): number {
  return toKobo(accrued) - toKobo(paid);
}

// --- Input rules ----------------------------------------------------------------

/** True for a positive (or, with allowZero, non-negative) naira amount with at most 2 decimals. */
export function isNgnAmount(value: number, allowZero = false): boolean {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) return false;
  if (value === 0 && !allowZero) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

export interface ScheduleDraft {
  /** Absent: the warehouse default schedule. */
  readonly commodity?: string | undefined;
  readonly basis: string;
  readonly period: string;
  readonly rateNgn: number;
  readonly minimumDays?: number | undefined;
  readonly effectiveFrom: string;
  /** Why the fee is changing; required. */
  readonly reason: string;
}

export type ValidSchedule = Omit<FeeSchedule, 'id'> & { readonly reason: string };

export function validateSchedule(draft: ScheduleDraft): Result<ValidSchedule> {
  const errors: DomainError[] = [];
  const commodity = draft.commodity ?? null;
  if (commodity !== null && !(COMMODITIES as readonly string[]).includes(commodity)) {
    errors.push(
      domainError(
        'unsupported_commodity',
        'commodity',
        `commodity must be one of ${COMMODITIES.join(', ')}, or left out for the default`,
      ),
    );
  }
  const basis = (FEE_BASES as readonly string[]).includes(draft.basis)
    ? (draft.basis as FeeBasis)
    : null;
  if (basis === null) {
    errors.push(
      domainError('invalid_basis', 'basis', `basis must be one of ${FEE_BASES.join(', ')}`),
    );
  }
  const period = (FEE_PERIODS as readonly string[]).includes(draft.period)
    ? (draft.period as FeePeriod)
    : null;
  if (period === null) {
    errors.push(
      domainError('invalid_period', 'period', `period must be one of ${FEE_PERIODS.join(', ')}`),
    );
  }
  if (!isNgnAmount(draft.rateNgn, true)) {
    errors.push(
      domainError('invalid_rate', 'rate_ngn', 'rate_ngn must be 0 or more with at most 2 decimals'),
    );
  }
  const { minimumDays } = draft;
  if (
    minimumDays !== undefined &&
    (!Number.isInteger(minimumDays) || minimumDays < 1 || minimumDays > 3650)
  ) {
    errors.push(
      domainError(
        'invalid_minimum_days',
        'minimum_days',
        'minimum_days must be a whole number of days from 1 to 3650',
      ),
    );
  }
  const effectiveFrom = checkDate(draft.effectiveFrom, 'effective_from', errors);
  const reason = checkReason(draft.reason, errors);
  if (
    errors.length > 0 ||
    basis === null ||
    period === null ||
    effectiveFrom === null ||
    reason === null
  ) {
    return fail(errors);
  }
  return ok({
    commodity,
    reason,
    basis,
    period,
    rateNgn: draft.rateNgn,
    minimumDays: minimumDays ?? null,
    effectiveFrom,
  });
}

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'pos', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const MAX_REFERENCE_LENGTH = 100;

export interface PaymentDraft {
  readonly amountNgn: number;
  readonly reference: string;
  readonly paidOn: string;
  readonly method: string;
  readonly notes?: string | undefined;
}

export interface ValidPayment {
  readonly amountNgn: number;
  readonly reference: string;
  readonly paidOn: string;
  readonly method: PaymentMethod;
  readonly notes: string | null;
}

/** `today` is the business date; a payment cannot be dated after it. */
export function validatePayment(draft: PaymentDraft, today: string): Result<ValidPayment> {
  const errors: DomainError[] = [];
  if (!isNgnAmount(draft.amountNgn)) {
    errors.push(
      domainError(
        'invalid_amount',
        'amount_ngn',
        'amount_ngn must be greater than 0 with at most 2 decimals',
      ),
    );
  }
  const reference = draft.reference.trim();
  if (reference === '' || reference.length > MAX_REFERENCE_LENGTH) {
    errors.push(
      domainError(
        'invalid_reference',
        'reference',
        `reference must be 1 to ${MAX_REFERENCE_LENGTH} characters (receipt or transfer number)`,
      ),
    );
  }
  const paidOn = checkDate(draft.paidOn, 'paid_on', errors);
  if (paidOn !== null && paidOn > today) {
    errors.push(domainError('date_in_future', 'paid_on', 'paid_on cannot be in the future'));
  }
  const method = (PAYMENT_METHODS as readonly string[]).includes(draft.method)
    ? (draft.method as PaymentMethod)
    : null;
  if (method === null) {
    errors.push(
      domainError(
        'invalid_method',
        'method',
        `method must be one of ${PAYMENT_METHODS.join(', ')}`,
      ),
    );
  }
  const notes = draft.notes?.trim() ?? '';
  if (notes.length > 500) {
    errors.push(domainError('notes_too_long', 'notes', 'Notes must be at most 500 characters'));
  }
  if (errors.length > 0 || paidOn === null || method === null) return fail(errors);
  return ok({
    amountNgn: draft.amountNgn,
    reference,
    paidOn,
    method,
    notes: notes === '' ? null : notes,
  });
}

export const MAX_REASON_LENGTH = 500;

/** A required free-text reason (fee changes, cancellations, reversals). */
export function checkReason(value: string, errors: DomainError[], field = 'reason'): string | null {
  const reason = value.trim();
  if (reason === '' || reason.length > MAX_REASON_LENGTH) {
    errors.push(
      domainError(
        'reason_required',
        field,
        `${field} is required: say why, in at most ${MAX_REASON_LENGTH} characters`,
      ),
    );
    return null;
  }
  return reason;
}
