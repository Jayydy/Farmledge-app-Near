import { checkCapturedAt } from './deposit.js';
import { domainError, fail, ok, type DomainError, type Result } from './errors.js';
import { fromCentiKg, isKgAmount, percentOf, roundHalfAway, toCentiKg } from './quantities.js';

export interface ScaleSampleDraft {
  readonly bagsWeighed: number;
  readonly totalKg: number;
  readonly recordedAt?: string | undefined;
}

export interface ValidScaleSample {
  readonly bagsWeighed: number;
  readonly totalCentiKg: number;
  readonly recordedAt: Date | null;
}

/** Rules on the sample itself. "No more bags than the deposit has" needs the deposit, so it lives in the service. */
export function validateScaleSample(
  draft: ScaleSampleDraft,
  rejectAfterHours: number,
  now: Date,
): Result<ValidScaleSample> {
  const errors: DomainError[] = [];
  if (!Number.isInteger(draft.bagsWeighed) || draft.bagsWeighed < 1) {
    errors.push(
      domainError(
        'invalid_bags_weighed',
        'bags_weighed',
        'Bags weighed must be a whole number of at least 1',
      ),
    );
  }
  if (!isKgAmount(draft.totalKg) || draft.totalKg === 0) {
    errors.push(
      domainError(
        'invalid_kg',
        'total_kg',
        'Total kg must be greater than 0 with at most two decimal places',
      ),
    );
  }
  const recordedAt = checkCapturedAt(
    draft.recordedAt,
    rejectAfterHours,
    now,
    errors,
    'recorded_at',
  );
  if (errors.length > 0) return fail(errors);
  return ok({ bagsWeighed: draft.bagsWeighed, totalCentiKg: toCentiKg(draft.totalKg), recordedAt });
}

/** Aggregates of a set of samples, as summed by the database. */
export interface ScaleTotals {
  readonly sampleCount: number;
  readonly bagsWeighed: number;
  readonly totalCentiKg: number;
  /** Σ bags_weighed × the bag size recorded on each sample's deposit. */
  readonly nominalKg: number;
}

export interface ScaleSummary {
  readonly sample_count: number;
  readonly bags_weighed: number;
  readonly total_kg: number;
  readonly avg_kg_per_bag: number | null;
  readonly nominal_kg_per_bag: number | null;
  /** avg − nominal: negative means bags are lighter than the estimate assumes. */
  readonly variance_kg_per_bag: number | null;
  readonly variance_pct: number | null;
}

export function summariseScaleSamples(totals: ScaleTotals): ScaleSummary {
  if (totals.bagsWeighed === 0) {
    return {
      sample_count: totals.sampleCount,
      bags_weighed: 0,
      total_kg: 0,
      avg_kg_per_bag: null,
      nominal_kg_per_bag: null,
      variance_kg_per_bag: null,
      variance_pct: null,
    };
  }
  const totalKg = fromCentiKg(totals.totalCentiKg);
  const differenceKg = fromCentiKg(totals.totalCentiKg - totals.nominalKg * 100);
  return {
    sample_count: totals.sampleCount,
    bags_weighed: totals.bagsWeighed,
    total_kg: totalKg,
    avg_kg_per_bag: roundHalfAway(totalKg / totals.bagsWeighed),
    nominal_kg_per_bag: roundHalfAway(totals.nominalKg / totals.bagsWeighed),
    variance_kg_per_bag: roundHalfAway(differenceKg / totals.bagsWeighed),
    variance_pct: percentOf(differenceKg, totals.nominalKg),
  };
}
