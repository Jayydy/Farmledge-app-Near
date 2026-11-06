import { domainError, fail, ok, type Result } from './errors.js';

/**
 * Moisture units (docs/decisions.md): external interfaces (API requests and
 * responses, the tablet) use a percentage with at most one decimal, e.g.
 * 12.5. Internal storage, config and the receipt contract use basis points
 * of a percent, e.g. 1250. These two functions are the only place the
 * conversion happens.
 */

/**
 * Converts an incoming moisture percentage to basis points. Rejects values
 * with more than one decimal place rather than rounding them, so a
 * mistyped 12.55 is corrected by the custodian, not silently changed.
 * Range limits are a business rule, checked in `validateDeposit`.
 */
export function moisturePercentToBps(percent: number, field = 'moisture_pct'): Result<number> {
  const tenths = percent * 10;
  if (!Number.isFinite(percent) || Math.abs(tenths - Math.round(tenths)) > 1e-9) {
    return fail([
      domainError(
        'invalid_moisture',
        field,
        'Moisture must be a percentage with at most one decimal place, e.g. 12.5',
      ),
    ]);
  }
  // Via whole tenths, so float noise (12.3 × 100 = 1230.0000000000002) never leaks in.
  return ok(Math.round(tenths) * 10);
}

/** Basis points back to the external percentage, e.g. 1250 → 12.5. */
export function bpsToMoisturePercent(bps: number): number {
  return bps / 100;
}
