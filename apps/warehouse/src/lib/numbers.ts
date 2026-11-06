/**
 * Keypad input is text; these turn it into the numbers the API takes, or
 * null when it isn't one. They never round: a mistyped 12.55 is shown back
 * to the custodian, not silently changed (as the API's moisture rule).
 */

/** A percentage with at most one decimal, e.g. "12.5". */
export function parseMoisture(text: string): number | null {
  return /^\d{1,2}(\.\d)?$/.test(text) ? Number(text) : null;
}

/** A whole number of at least 1, e.g. a bag count. */
export function parseWholeCount(text: string): number | null {
  return /^[1-9]\d{0,5}$/.test(text) ? Number(text) : null;
}

/** Kilograms with at most two decimals, greater than 0. */
export function parseKg(text: string): number | null {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return null;
  const kg = Number(text);
  return kg > 0 ? kg : null;
}

/** ISO 8601 with the device's offset, as the API wants for `captured_at`. */
export function isoWithOffset(date: Date): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** A short, readable form of a deposit_id for the capture receipt: D-3F9A-C21B. */
export function shortReference(depositId: string): string {
  const hex = depositId.replaceAll('-', '').toUpperCase();
  return `D-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/** 1985.5 → "1,985.5 kg". */
export function formatKg(kg: number): string {
  return `${kg.toLocaleString('en-NG', { maximumFractionDigits: 2 })} kg`;
}

/** 12500 → "₦12,500.00". */
export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How old a figure is, in whole minutes or hours: { minutes } under an hour, else { hours }. */
export function ageOf(fetchedAt: number, now: number): { minutes: number } | { hours: number } {
  const minutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
  return minutes < 60 ? { minutes } : { hours: Math.floor(minutes / 60) };
}
