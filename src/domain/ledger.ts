import { COMMODITIES, type Commodity, type Config } from '../config/index.js';
import { checkNotes, isCommodity, MAX_NOTES_LENGTH } from './deposit.js';
import { domainError, fail, ok, type DomainError, type Result } from './errors.js';
import { checkGrade } from './grading.js';
import { isUuid } from './ids.js';
import { isKgAmount, MAX_KG, toCentiKg } from './quantities.js';

/**
 * The stock ledger (docs/decisions.md D12). Stock is a list of signed
 * movements; a balance is always their sum, never a stored total, so the
 * order movements arrive in cannot change it.
 */

export type MovementKind = 'deposit_in' | 'deposit_void' | 'dispatch_out' | 'adjustment';
export const MOVEMENT_KINDS: readonly MovementKind[] = [
  'deposit_in',
  'deposit_void',
  'dispatch_out',
  'adjustment',
];

/** What a balance is kept per: one farmer's stock of one grade at one warehouse. */
export interface BalanceKey {
  readonly warehouseId: string;
  readonly farmerId: string;
  readonly commodity: string;
  readonly gradingScheme: string;
  readonly grade: string;
}

export interface Movement extends BalanceKey {
  readonly bagsDelta: number;
  /** kg, or the string Postgres returns for NUMERIC. */
  readonly kgDelta: number | string;
  readonly occurredAt: Date;
}

export interface Balance extends BalanceKey {
  readonly bags: number;
  /** Integer hundredths of a kg, so sums are exact. */
  readonly centiKg: number;
}

export function balanceKeyString(key: BalanceKey): string {
  return [key.warehouseId, key.farmerId, key.commodity, key.gradingScheme, key.grade].join('|');
}

/**
 * Balances per key from movements in any order. With `asOf`, only movements
 * that had happened by then count, so a late offline capture lands on the
 * day it physically arrived. Zero balances are left out.
 */
export function deriveBalances(movements: readonly Movement[], asOf?: Date): Balance[] {
  const totals = new Map<string, { key: BalanceKey; bags: number; centiKg: number }>();
  for (const movement of movements) {
    if (asOf !== undefined && movement.occurredAt.getTime() > asOf.getTime()) continue;
    const id = balanceKeyString(movement);
    const total = totals.get(id) ?? { key: movement, bags: 0, centiKg: 0 };
    total.bags += movement.bagsDelta;
    total.centiKg += toCentiKg(movement.kgDelta);
    totals.set(id, total);
  }
  return [...totals.values()]
    .filter((total) => total.bags !== 0 || total.centiKg !== 0)
    .map(({ key, bags, centiKg }) => ({
      warehouseId: key.warehouseId,
      farmerId: key.farmerId,
      commodity: key.commodity,
      gradingScheme: key.gradingScheme,
      grade: key.grade,
      bags,
      centiKg,
    }));
}

/**
 * The share of a balance's kg that leaves with `bagsOut` bags, in
 * hundredths of a kg: kg × bagsOut ÷ bags, rounded half up. Taking every
 * bag takes exactly the whole balance, so no rounding residue is left.
 */
export function bookCentiKgFor(
  balance: { bags: number; centiKg: number },
  bagsOut: number,
): number {
  if (bagsOut >= balance.bags) return balance.centiKg;
  return Math.round((balance.centiKg * bagsOut) / balance.bags);
}

// --- Dispatch -----------------------------------------------------------------

export const MAX_BUYER_NAME_LENGTH = 200;
/** Sanity cap; the balance is the real limit. */
export const MAX_DISPATCH_BAGS = 100_000;

export interface DispatchDraft {
  readonly dispatchId: string;
  readonly commodity: string;
  readonly grade: number | string;
  readonly bagCount: number;
  readonly exitWeightKg?: number | undefined;
  /** Why no exit weight was taken: required without one, refused with one (D54). */
  readonly notWeighedReason?: string | undefined;
  readonly buyerName?: string | undefined;
  readonly notes?: string | undefined;
}

export interface ValidDispatch {
  readonly dispatchId: string;
  readonly commodity: Commodity;
  readonly gradingScheme: string;
  readonly grade: string;
  readonly bagCount: number;
  readonly exitCentiKg: number | null;
  readonly notWeighedReason: string | null;
  readonly buyerName: string | null;
  readonly notes: string | null;
}

export const MAX_NOT_WEIGHED_REASON_LENGTH = 500;

export interface DispatchPlanDraft {
  readonly commodity: string;
  readonly grade: number | string;
  readonly bagCount: number;
}

export interface ValidDispatchPlan {
  readonly commodity: Commodity;
  readonly gradingScheme: string;
  readonly grade: string;
  readonly bagCount: number;
}

/** What a dispatch would take, checked the way `validateDispatch` checks it. */
export function validateDispatchPlan(
  draft: DispatchPlanDraft,
  grading: Config['grading'],
): Result<ValidDispatchPlan> {
  const errors: DomainError[] = [];
  const { commodity, grade } = checkDispatchGoods(draft, grading, errors);
  if (errors.length > 0 || commodity === null || grade === null) return fail(errors);
  return ok({ commodity, gradingScheme: grading.scheme, grade, bagCount: draft.bagCount });
}

function checkDispatchGoods(
  draft: DispatchPlanDraft,
  grading: Config['grading'],
  errors: DomainError[],
): { commodity: Commodity | null; grade: string | null } {
  const commodity = checkCommodity(draft.commodity, errors);
  const grade = checkGrade(draft.grade, grading, errors);
  if (
    !Number.isInteger(draft.bagCount) ||
    draft.bagCount < 1 ||
    draft.bagCount > MAX_DISPATCH_BAGS
  ) {
    errors.push(
      domainError(
        'invalid_bag_count',
        'bag_count',
        'Bag count must be a whole number of at least 1',
      ),
    );
  }
  return { commodity, grade };
}

export function validateDispatch(
  draft: DispatchDraft,
  grading: Config['grading'],
): Result<ValidDispatch> {
  const errors: DomainError[] = [];
  if (!isUuid(draft.dispatchId)) {
    errors.push(
      domainError(
        'invalid_dispatch_id',
        'dispatch_id',
        'dispatch_id must be a UUID generated on the tablet',
      ),
    );
  }
  const { commodity, grade } = checkDispatchGoods(draft, grading, errors);
  if (
    draft.exitWeightKg !== undefined &&
    (!isKgAmount(draft.exitWeightKg) || draft.exitWeightKg === 0)
  ) {
    errors.push(
      domainError(
        'invalid_kg',
        'exit_weight_kg',
        'Exit weight must be greater than 0 with at most two decimal places',
      ),
    );
  }
  const notWeighedReason = draft.notWeighedReason?.trim() ?? '';
  if (draft.exitWeightKg === undefined) {
    if (notWeighedReason === '' || notWeighedReason.length > MAX_NOT_WEIGHED_REASON_LENGTH) {
      errors.push(
        domainError(
          'not_weighed_reason_required',
          'not_weighed_reason',
          `Without an exit weight, say why it was not weighed, in at most ${MAX_NOT_WEIGHED_REASON_LENGTH} characters`,
        ),
      );
    }
  } else if (draft.notWeighedReason !== undefined) {
    errors.push(
      domainError(
        'not_weighed_reason_with_weight',
        'not_weighed_reason',
        'not_weighed_reason must be left out when an exit weight is given',
      ),
    );
  }
  const buyerName = draft.buyerName?.trim() ?? '';
  if (buyerName.length > MAX_BUYER_NAME_LENGTH) {
    errors.push(
      domainError(
        'buyer_name_too_long',
        'buyer_name',
        `Buyer name must be at most ${MAX_BUYER_NAME_LENGTH} characters`,
      ),
    );
  }
  const notes = checkNotes(draft.notes, errors);
  if (errors.length > 0 || commodity === null || grade === null) return fail(errors);
  return ok({
    dispatchId: draft.dispatchId.toLowerCase(),
    commodity,
    gradingScheme: grading.scheme,
    grade,
    bagCount: draft.bagCount,
    exitCentiKg: draft.exitWeightKg === undefined ? null : toCentiKg(draft.exitWeightKg),
    notWeighedReason: draft.exitWeightKg === undefined ? notWeighedReason : null,
    buyerName: buyerName === '' ? null : buyerName,
    notes,
  });
}

// --- Adjustments --------------------------------------------------------------

/** Reasons a person may give. `scale_reweigh` is posted only by the system. */
export const ADJUSTMENT_REASONS = [
  'audit_correction',
  'data_entry_error',
  'spoilage',
  'other',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number] | 'scale_reweigh';

export interface AdjustmentDraft {
  readonly adjustmentId: string;
  readonly commodity: string;
  readonly grade: number | string;
  readonly bagsDelta: number;
  readonly kgDelta: number;
  readonly reasonCode: string;
  readonly notes: string;
}

export interface ValidAdjustment {
  readonly adjustmentId: string;
  readonly commodity: Commodity;
  readonly gradingScheme: string;
  readonly grade: string;
  readonly bagsDelta: number;
  readonly centiKgDelta: number;
  readonly reasonCode: AdjustmentReason;
  readonly notes: string;
}

export function validateAdjustment(
  draft: AdjustmentDraft,
  grading: Config['grading'],
): Result<ValidAdjustment> {
  const errors: DomainError[] = [];
  if (!isUuid(draft.adjustmentId)) {
    errors.push(
      domainError('invalid_adjustment_id', 'adjustment_id', 'adjustment_id must be a UUID'),
    );
  }
  const commodity = checkCommodity(draft.commodity, errors);
  const grade = checkGrade(draft.grade, grading, errors);
  const bagsOk =
    Number.isInteger(draft.bagsDelta) && Math.abs(draft.bagsDelta) <= MAX_DISPATCH_BAGS;
  if (!bagsOk) {
    errors.push(
      domainError('invalid_bags_delta', 'bags_delta', 'bags_delta must be a whole number'),
    );
  }
  const kgOk = Number.isFinite(draft.kgDelta) && isKgAmount(Math.abs(draft.kgDelta));
  if (!kgOk) {
    errors.push(
      domainError(
        'invalid_kg_delta',
        'kg_delta',
        `kg_delta must be a number of kg with at most two decimal places, up to ${MAX_KG}`,
      ),
    );
  }
  if (bagsOk && kgOk && draft.bagsDelta === 0 && draft.kgDelta === 0) {
    errors.push(
      domainError('empty_adjustment', 'bags_delta', 'An adjustment must change bags, kg or both'),
    );
  }
  const reasonCode = (ADJUSTMENT_REASONS as readonly string[]).includes(draft.reasonCode)
    ? (draft.reasonCode as AdjustmentReason)
    : null;
  if (reasonCode === null) {
    errors.push(
      domainError(
        'invalid_reason',
        'reason_code',
        `reason_code must be one of ${ADJUSTMENT_REASONS.join(', ')}`,
      ),
    );
  }
  const notes = draft.notes.trim();
  if (notes === '') {
    errors.push(domainError('notes_required', 'notes', 'Say why the stock is being adjusted'));
  } else if (notes.length > MAX_NOTES_LENGTH) {
    errors.push(
      domainError(
        'notes_too_long',
        'notes',
        `Notes must be at most ${MAX_NOTES_LENGTH} characters`,
      ),
    );
  }
  if (errors.length > 0 || commodity === null || grade === null || reasonCode === null) {
    return fail(errors);
  }
  return ok({
    adjustmentId: draft.adjustmentId.toLowerCase(),
    commodity,
    gradingScheme: grading.scheme,
    grade,
    bagsDelta: draft.bagsDelta,
    centiKgDelta: toCentiKg(draft.kgDelta),
    reasonCode,
    notes,
  });
}

function checkCommodity(value: string, errors: DomainError[]): Commodity | null {
  if (isCommodity(value)) return value;
  errors.push(
    domainError(
      'unsupported_commodity',
      'commodity',
      `Commodity must be one of ${COMMODITIES.join(', ')}`,
    ),
  );
  return null;
}

// --- Shrinkage ----------------------------------------------------------------

export type DispatchReviewReason = 'shrinkage_above_threshold';

/**
 * Shrinkage is a reporting threshold, never a rule (docs/decisions.md D24):
 * an exit losing more than `toleranceBps` of its book kg is flagged for
 * review and still goes through. Unweighed exits can't be judged.
 */
export function shrinkageReview(
  bookCentiKg: number,
  exitCentiKg: number | null,
  toleranceBps: number,
): DispatchReviewReason[] {
  if (exitCentiKg === null || bookCentiKg === 0) return [];
  return (bookCentiKg - exitCentiKg) * 10_000 > toleranceBps * bookCentiKg
    ? ['shrinkage_above_threshold']
    : [];
}

/**
 * The shrinkage tolerance for `commodity` (D24, D28): the latest one set for
 * that commodity; failing that, the latest warehouse default (no commodity).
 * Null when neither exists, and the configured default applies. `settings`
 * are newest first.
 */
export function toleranceFor<T extends { readonly commodity: string | null }>(
  settings: readonly T[],
  commodity: string,
): { readonly setting: T; readonly source: 'commodity' | 'warehouse' } | null {
  const own = settings.find((setting) => setting.commodity === commodity);
  if (own !== undefined) return { setting: own, source: 'commodity' };
  const fallback = settings.find((setting) => setting.commodity === null);
  return fallback === undefined ? null : { setting: fallback, source: 'warehouse' };
}

// --- Cancellation -------------------------------------------------------------

export type ActorRole = 'custodian' | 'warehouse_owner';

/**
 * Cancellation is for mistakes (D22): a custodian or owner may cancel within
 * the window after the deposit was recorded; after it, only the owner.
 */
export function mayCancel(role: ActorRole, withinWindow: boolean): boolean {
  return withinWindow || role === 'warehouse_owner';
}

/**
 * The lowest bag balance at any point in time, taking movements in the
 * order they happened. Cancelling a deposit removes it from its intake
 * onwards; if that would take the balance below zero at any point, some of
 * its grain has already left, which is a dispatch, not a mistake.
 */
export function lowestRunningBags(
  movements: readonly { readonly bagsDelta: number; readonly occurredAt: Date }[],
): number {
  const sorted = [...movements].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || b.bagsDelta - a.bagsDelta,
  );
  let running = 0;
  let lowest = 0;
  for (const movement of sorted) {
    running += movement.bagsDelta;
    lowest = Math.min(lowest, running);
  }
  return lowest;
}
