import type { Commodity, Config } from '../config/index.js';
import { COMMODITIES } from '../config/index.js';
import { checkCapturedAt, checkNotes, isCommodity } from './deposit.js';
import { domainError, fail, ok, type DomainError, type Result } from './errors.js';
import { checkGrade } from './grading.js';
import { fromCentiKg, isKgAmount, percentOf, toCentiKg } from './quantities.js';

/** Sanity cap on a counted line; far above any single warehouse's stock of one grade. */
export const MAX_COUNTED_BAGS = 1_000_000;

export interface AuditLineDraft {
  readonly commodity: string;
  readonly grade: number | string;
  readonly countedBags: number;
  /** Absent when only bags were counted; then bags × bag size is assumed. */
  readonly countedKg?: number | undefined;
  readonly notes?: string | undefined;
}

export interface ValidAuditLine {
  readonly commodity: Commodity;
  readonly gradingScheme: string;
  readonly grade: string;
  readonly countedBags: number;
  readonly countedCentiKg: number;
  /** True when counted kg was derived from the bag count rather than weighed. */
  readonly countedKgEstimated: boolean;
  readonly notes: string | null;
}

export function validateAuditLine(
  draft: AuditLineDraft,
  rules: { readonly commodities: Config['commodities']; readonly grading: Config['grading'] },
): Result<ValidAuditLine> {
  const errors: DomainError[] = [];
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
  if (
    !Number.isInteger(draft.countedBags) ||
    draft.countedBags < 0 ||
    draft.countedBags > MAX_COUNTED_BAGS
  ) {
    errors.push(
      domainError(
        'invalid_counted_bags',
        'counted_bags',
        `Counted bags must be a whole number from 0 to ${MAX_COUNTED_BAGS}`,
      ),
    );
  }
  if (draft.countedKg !== undefined && !isKgAmount(draft.countedKg)) {
    errors.push(
      domainError(
        'invalid_kg',
        'counted_kg',
        'Counted kg must be 0 or more with at most two decimal places',
      ),
    );
  }
  const notes = checkNotes(draft.notes, errors);
  if (errors.length > 0 || commodity === null || grade === null) return fail(errors);

  const { countedKg } = draft;
  return ok({
    commodity,
    gradingScheme: rules.grading.scheme,
    grade,
    countedBags: draft.countedBags,
    countedCentiKg:
      countedKg === undefined
        ? draft.countedBags * rules.commodities[commodity].bagSizeKg * 100
        : toCentiKg(countedKg),
    countedKgEstimated: countedKg === undefined,
    notes,
  });
}

/** One counted line as stored: recorded figures are the system's, counted are physical. */
export interface AuditLineFigures {
  readonly commodity: string;
  readonly grade: string;
  readonly recordedBags: number;
  readonly recordedKg: number | string;
  readonly countedBags: number;
  readonly countedKg: number | string;
}

export interface VarianceFigures {
  readonly recorded_bags: number;
  readonly counted_bags: number;
  /** counted − recorded: negative means stock is missing. */
  readonly difference_bags: number;
  /** difference as a percentage of recorded; null when nothing was recorded. */
  readonly difference_bags_pct: number | null;
  readonly recorded_kg: number;
  readonly counted_kg: number;
  readonly difference_kg: number;
  readonly difference_kg_pct: number | null;
}

export interface AuditReportLine extends VarianceFigures {
  readonly commodity: string;
  readonly grade: string;
}

export interface AuditReport {
  readonly lines: readonly AuditReportLine[];
  readonly totals: VarianceFigures;
}

function variance(
  recordedBags: number,
  countedBags: number,
  recordedCentiKg: number,
  countedCentiKg: number,
): VarianceFigures {
  const differenceCentiKg = countedCentiKg - recordedCentiKg;
  return {
    recorded_bags: recordedBags,
    counted_bags: countedBags,
    difference_bags: countedBags - recordedBags,
    difference_bags_pct: percentOf(countedBags - recordedBags, recordedBags),
    recorded_kg: fromCentiKg(recordedCentiKg),
    counted_kg: fromCentiKg(countedCentiKg),
    difference_kg: fromCentiKg(differenceCentiKg),
    difference_kg_pct: percentOf(differenceCentiKg, recordedCentiKg),
  };
}

/** Recorded versus counted per line and in total, with differences and percentages. */
export function buildAuditReport(lines: readonly AuditLineFigures[]): AuditReport {
  let recordedBags = 0;
  let countedBags = 0;
  let recordedCentiKg = 0;
  let countedCentiKg = 0;

  const reportLines = lines.map((line) => {
    const recordedC = toCentiKg(line.recordedKg);
    const countedC = toCentiKg(line.countedKg);
    recordedBags += line.recordedBags;
    countedBags += line.countedBags;
    recordedCentiKg += recordedC;
    countedCentiKg += countedC;
    return {
      commodity: line.commodity,
      grade: line.grade,
      ...variance(line.recordedBags, line.countedBags, recordedC, countedC),
    };
  });

  return {
    lines: reportLines,
    totals: variance(recordedBags, countedBags, recordedCentiKg, countedCentiKg),
  };
}

export interface AuditStartDraft {
  /** Who physically counted the stock, as typed (D57). */
  readonly countedBy: string;
  /** Who watched the count; never a custodian of the warehouse (D57). */
  readonly witnessedBy: string;
  readonly startedAt?: string | undefined;
  readonly notes?: string | undefined;
}

export const MAX_PERSON_NAME_LENGTH = 120;

/**
 * A typed name compared loosely: case, and spaces at the ends or repeated,
 * don't make "Musa Bello" a different person from " musa  bello".
 */
export function samePersonName(a: string, b: string): boolean {
  const norm = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/** Start time (default now, may be backdated within the offline window), the counter and witness, and notes. */
export function validateAuditStart(
  draft: AuditStartDraft,
  rejectAfterHours: number,
  now: Date,
): Result<{
  startedAt: Date | null;
  countedBy: string;
  witnessedBy: string;
  notes: string | null;
}> {
  const errors: DomainError[] = [];
  const startedAt = checkCapturedAt(draft.startedAt, rejectAfterHours, now, errors, 'started_at');
  const countedBy = checkPersonName(draft.countedBy, 'counted_by', 'Who counted', errors);
  const witnessedBy = checkPersonName(draft.witnessedBy, 'witnessed_by', 'Who witnessed', errors);
  const notes = checkNotes(draft.notes, errors);
  return errors.length > 0 ? fail(errors) : ok({ startedAt, countedBy, witnessedBy, notes });
}

function checkPersonName(
  value: string,
  field: 'counted_by' | 'witnessed_by',
  label: string,
  errors: DomainError[],
): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > MAX_PERSON_NAME_LENGTH) {
    errors.push(
      domainError(
        `invalid_${field}`,
        field,
        `${label} must be a name of 1 to ${MAX_PERSON_NAME_LENGTH} characters`,
      ),
    );
  }
  return name;
}
