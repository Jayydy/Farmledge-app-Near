import { domainError, fail, ok, type Result } from './errors.js';

/**
 * Nigerian mobile numbers after the +234 country code: 10 digits starting
 * 70, 71, 80, 81, 90 or 91 (the NCC mobile ranges). Landlines are rejected
 * because intake notifications go by SMS.
 */
const NATIONAL_MOBILE = /^[789][01]\d{8}$/;
const SEPARATORS = /[\s().-]/g;

/**
 * Normalises the ways a Nigerian mobile number is commonly written
 * (`0803 123 4567`, `803-123-4567`, `2348031234567`, `+234 803 123 4567`)
 * to E.164: `+2348031234567`.
 */
export function normaliseNigerianMobile(input: string, field = 'phone'): Result<string> {
  const compact = input.replace(SEPARATORS, '');
  let national: string | null = null;
  if (/^\+234\d+$/.test(compact)) national = compact.slice(4);
  else if (/^234\d{10}$/.test(compact)) national = compact.slice(3);
  else if (/^0\d{10}$/.test(compact)) national = compact.slice(1);
  else if (/^\d{10}$/.test(compact)) national = compact;

  if (national === null || !NATIONAL_MOBILE.test(national)) {
    return fail([
      domainError(
        'invalid_phone',
        field,
        'Enter a Nigerian mobile number, e.g. 0803 123 4567 or +234 803 123 4567',
      ),
    ]);
  }
  return ok(`+234${national}`);
}
