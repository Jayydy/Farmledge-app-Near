import { COMMODITIES, type Commodity, type Config } from '../config/index.js';
import { domainError, fail, ok, type DomainError, type Result } from './errors.js';
import { checkGrade } from './grading.js';
import { isUuid } from './ids.js';
import { bpsToMoisturePercent } from './units.js';
import { deriveWeight } from './weight.js';

export const MAX_NOTES_LENGTH = 500;
/** Tablet clocks drift; a capture this far ahead of the server is still accepted. */
export const CAPTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const HOUR_MS = 60 * 60 * 1000;

/** Reasons a deposit is accepted but needs a supervisor's review. */
export type ReviewReason = 'late_capture';

/** Deposit fields as submitted, after the HTTP layer has checked their JSON types. */
export interface DepositDraft {
  readonly depositId: string;
  readonly commodity: string;
  /** A grade code, or a whole number for numeric codes. */
  readonly grade: number | string;
  /**
   * Basis points, already converted from the API's percentage by
   * `moisturePercentToBps` at the edge; a failed conversion carries its
   * errors so they are reported with every other problem.
   */
  readonly moistureBps: Result<number>;
  readonly bagCount: number;
  /** Explicit confirmation that a bag count above the threshold is correct. */
  readonly confirmBagCount?: boolean | undefined;
  readonly notes?: string | undefined;
  /** ISO 8601 with offset, from the tablet. Absent means "now". */
  readonly capturedAt?: string | undefined;
}

export interface DepositRules {
  readonly commodities: Config['commodities'];
  readonly grading: Config['grading'];
  readonly bagCountMax: number;
  readonly bagCountConfirmAbove: number;
  readonly offlineReviewAfterHours: number;
  readonly offlineRejectAfterHours: number;
}

export interface ValidDeposit {
  /** Lower-cased UUID. */
  readonly depositId: string;
  readonly commodity: Commodity;
  readonly gradingScheme: string;
  readonly grade: string;
  readonly moistureBps: number;
  readonly bagCount: number;
  /** True when the count was above the threshold and explicitly confirmed. */
  readonly bagCountConfirmed: boolean;
  readonly bagSizeKg: number;
  readonly weightKg: number;
  /** Trimmed; null when absent or blank. */
  readonly notes: string | null;
  readonly capturedAt: Date | null;
  readonly reviewReasons: readonly ReviewReason[];
}

export function depositRules(config: Config): DepositRules {
  return {
    commodities: config.commodities,
    grading: config.grading,
    ...config.intake,
  };
}

export function isCommodity(value: string): value is Commodity {
  return (COMMODITIES as readonly string[]).includes(value);
}

const percent = (bps: number) => `${bpsToMoisturePercent(bps)}%`;

/** Checks every intake rule and returns all failures together. */
export function validateDeposit(
  draft: DepositDraft,
  rules: DepositRules,
  now: Date,
): Result<ValidDeposit> {
  const errors: DomainError[] = [];

  if (!isUuid(draft.depositId)) {
    errors.push(
      domainError(
        'invalid_deposit_id',
        'deposit_id',
        'deposit_id must be a UUID generated on the tablet',
      ),
    );
  }

  const commodity = isCommodity(draft.commodity) ? draft.commodity : null;
  if (commodity === null) {
    errors.push(
      domainError(
        'unsupported_commodity',
        'commodity',
        `Commodity must be one of ${COMMODITIES.join(', ')}`,
      ),
    );
  }

  const grade = checkGrade(draft.grade, rules.grading, errors);

  const moisture = draft.moistureBps;
  if (!moisture.ok) {
    errors.push(...moisture.errors);
  } else if (commodity !== null) {
    const { min, max } = rules.commodities[commodity].moistureBps;
    if (moisture.value < min || moisture.value > max) {
      errors.push(
        domainError(
          'moisture_out_of_range',
          'moisture_pct',
          `Moisture must be between ${percent(min)} and ${percent(max)}`,
        ),
      );
    }
  }

  checkBagCount(draft.bagCount, draft.confirmBagCount === true, rules, errors);

  const notes = checkNotes(draft.notes, errors);

  const capturedAt = checkCapturedAt(draft.capturedAt, rules.offlineRejectAfterHours, now, errors);

  if (errors.length > 0 || commodity === null || grade === null || !moisture.ok) {
    return fail(errors);
  }
  const { bagSizeKg, weightKg } = deriveWeight(draft.bagCount, commodity, rules.commodities);
  return ok({
    depositId: draft.depositId.toLowerCase(),
    commodity,
    gradingScheme: rules.grading.scheme,
    grade,
    moistureBps: moisture.value,
    bagCount: draft.bagCount,
    bagCountConfirmed: draft.bagCount > rules.bagCountConfirmAbove,
    bagSizeKg,
    weightKg,
    notes,
    capturedAt,
    reviewReasons: reviewReasonsFor(capturedAt, rules.offlineReviewAfterHours, now),
  });
}

/**
 * Two limits: above the hard maximum a count is always rejected; above the
 * confirmation threshold it needs an explicit confirm flag, so a typo (2000
 * for 200) is caught while a real truckload still goes through.
 */
function checkBagCount(
  bagCount: number,
  confirmed: boolean,
  rules: DepositRules,
  errors: DomainError[],
): void {
  if (!Number.isInteger(bagCount) || bagCount < 1) {
    errors.push(
      domainError(
        'invalid_bag_count',
        'bag_count',
        'Bag count must be a whole number of at least 1',
      ),
    );
  } else if (bagCount > rules.bagCountMax) {
    errors.push(
      domainError(
        'bag_count_too_large',
        'bag_count',
        `Bag count must be at most ${rules.bagCountMax}; check the figure or split the deposit`,
      ),
    );
  } else if (bagCount > rules.bagCountConfirmAbove && !confirmed) {
    errors.push(
      domainError(
        'bag_count_needs_confirmation',
        'bag_count',
        `${bagCount} bags is more than ${rules.bagCountConfirmAbove}; check the figure and resend with confirm_bag_count: true`,
      ),
    );
  }
}

/** A capture older than the review age is accepted but flagged. */
export function reviewReasonsFor(
  capturedAt: Date | null,
  reviewAfterHours: number,
  now: Date,
): ReviewReason[] {
  return capturedAt !== null && now.getTime() - capturedAt.getTime() > reviewAfterHours * HOUR_MS
    ? ['late_capture']
    : [];
}

/** Trims free-text notes; blank becomes null. */
export function checkNotes(value: string | undefined, errors: DomainError[]): string | null {
  const notes = value?.trim() ?? '';
  if (notes.length > MAX_NOTES_LENGTH) {
    errors.push(
      domainError(
        'notes_too_long',
        'notes',
        `Notes must be at most ${MAX_NOTES_LENGTH} characters`,
      ),
    );
  }
  return notes === '' ? null : notes;
}

const describeHours = (hours: number) =>
  hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;

/**
 * Parses an ISO 8601 timestamp (with offset) and checks it is neither in
 * the future beyond clock skew nor older than `rejectAfterHours`.
 */
export function checkCapturedAt(
  value: string | undefined,
  rejectAfterHours: number,
  now: Date,
  errors: DomainError[],
  field = 'captured_at',
): Date | null {
  if (value === undefined) return null;
  const parsed = ISO_TIMESTAMP.test(value) ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) {
    errors.push(
      domainError(
        'invalid_captured_at',
        field,
        `${field} must be an ISO 8601 timestamp with a time zone, e.g. 2026-09-28T10:15:00+01:00`,
      ),
    );
    return null;
  }
  if (parsed.getTime() > now.getTime() + CAPTURE_CLOCK_SKEW_MS) {
    errors.push(
      domainError(
        'captured_at_in_future',
        field,
        `${field} is in the future; check the tablet clock`,
      ),
    );
    return null;
  }
  if (parsed.getTime() < now.getTime() - rejectAfterHours * HOUR_MS) {
    errors.push(
      domainError(
        'captured_at_too_old',
        field,
        `${field} is more than ${describeHours(rejectAfterHours)} ago; record it manually with a supervisor`,
      ),
    );
    return null;
  }
  return parsed;
}

/** The fields that identify a deposit's content, for idempotency checks. */
export interface DepositContent {
  readonly farmerId: string;
  readonly warehouseId: string;
  readonly custodianId: string;
  readonly verifierId: string;
  readonly commodity: string;
  readonly grade: string;
  readonly moistureBps: number;
  readonly bagCount: number;
  readonly notes: string | null;
}

/**
 * Lists the fields where a resubmission differs from the stored deposit.
 * Empty means it is a true repeat. `captured_at` is deliberately not
 * compared: a retry without it defaults to "now" and would never match.
 * IDs are compared case-insensitively, since UUIDs may arrive in upper case.
 */
export function depositDifferences(stored: DepositContent, submitted: DepositContent): string[] {
  const idFields = new Set<keyof DepositContent>([
    'farmerId',
    'warehouseId',
    'custodianId',
    'verifierId',
  ]);
  const fields: [keyof DepositContent, string][] = [
    ['farmerId', 'farmer_id'],
    ['warehouseId', 'warehouse_id'],
    ['custodianId', 'custodian_id'],
    ['verifierId', 'verifier_id'],
    ['commodity', 'commodity'],
    ['grade', 'grade'],
    ['moistureBps', 'moisture_pct'],
    ['bagCount', 'bag_count'],
    ['notes', 'notes'],
  ];
  return fields
    .filter(([key]) => {
      const a = stored[key];
      const b = submitted[key];
      return idFields.has(key) && typeof a === 'string' && typeof b === 'string'
        ? a.toLowerCase() !== b.toLowerCase()
        : a !== b;
    })
    .map(([, field]) => field);
}
