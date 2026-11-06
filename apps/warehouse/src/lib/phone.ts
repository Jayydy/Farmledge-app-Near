/**
 * TEMPORARY: a copy of the API's `src/domain/phone.ts` normalisation, so a
 * farmer is found in the offline cache however the phone was typed. Moves to
 * `packages/shared` in the monorepo PR.
 */
const NATIONAL_MOBILE = /^[789][01]\d{8}$/;
const SEPARATORS = /[\s().-]/g;

/** `0803 123 4567`, `803…`, `234803…`, `+234 803…` → `+2348031234567`, or null. */
export function normaliseNigerianMobile(input: string): string | null {
  const compact = input.replace(SEPARATORS, '');
  let national: string | null = null;
  if (/^\+234\d+$/.test(compact)) national = compact.slice(4);
  else if (/^234\d{10}$/.test(compact)) national = compact.slice(3);
  else if (/^0\d{10}$/.test(compact)) national = compact.slice(1);
  else if (/^\d{10}$/.test(compact)) national = compact;
  return national !== null && NATIONAL_MOBILE.test(national) ? `+234${national}` : null;
}

/** +2348031234567 → 0803 123 4567, as staff read numbers aloud. */
export function formatLocalPhone(e164: string): string {
  const national = e164.startsWith('+234') ? `0${e164.slice(4)}` : e164;
  return national.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
}
