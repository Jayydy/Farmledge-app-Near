/**
 * Kilogram amounts with up to two decimals (the `NUMERIC(…, 2)` columns)
 * are handled as integer hundredths of a kg so arithmetic is exact.
 */

/** Largest value a NUMERIC(10, 2) column holds; also a sanity cap on inputs. */
export const MAX_KG = 99_999_999.99;

/** True for a finite, non-negative number with at most two decimal places. */
export function isKgAmount(value: number): boolean {
  if (!Number.isFinite(value) || value < 0 || value > MAX_KG) return false;
  const hundredths = value * 100;
  return Math.abs(hundredths - Math.round(hundredths)) < 1e-6;
}

/** Converts kg (number or the string Postgres returns for NUMERIC) to integer hundredths. */
export function toCentiKg(kg: number | string): number {
  return Math.round(Number(kg) * 100);
}

export function fromCentiKg(centiKg: number): number {
  return centiKg / 100;
}

/** Rounds to `decimals` places, halves away from zero (so -1.245 → -1.25). */
export function roundHalfAway(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  // toPrecision trims binary noise such as 124.74999999999999 before rounding.
  const scaled = Number((Math.abs(value) * factor).toPrecision(12));
  return (Math.sign(value) * Math.floor(scaled + 0.5)) / factor || 0;
}

/** `part / whole` as a percentage to 2 dp, or null when `whole` is zero. */
export function percentOf(part: number, whole: number): number | null {
  return whole === 0 ? null : roundHalfAway((part / whole) * 100);
}
