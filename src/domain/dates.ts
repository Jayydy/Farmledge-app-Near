import { domainError, type DomainError } from './errors.js';

/**
 * Calendar dates as `YYYY-MM-DD` strings. Reports and fee accrual work in
 * whole days of the configured business time zone (BUSINESS_TIMEZONE);
 * this module turns instants into those days and does day arithmetic.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** The calendar day `instant` falls on in `timeZone`. */
export function businessDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function daysInMonth(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Parses an optional `YYYY-MM-DD` field, recording an error when malformed. */
export function checkDate(
  value: string | undefined,
  field: string,
  errors: DomainError[],
): string | null {
  if (value === undefined) return null;
  if (!isIsoDate(value)) {
    errors.push(domainError('invalid_date', field, `${field} must be a date written YYYY-MM-DD`));
    return null;
  }
  return value;
}
