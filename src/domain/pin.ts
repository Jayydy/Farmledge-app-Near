import { domainError, fail, ok, type Result } from './errors.js';

/** Staff PINs are exactly this many digits (docs/decisions.md D41). */
export const PIN_LENGTH = 6;
/** Wrong PINs in a row before the custodian is locked out. */
export const PIN_MAX_FAILED_ATTEMPTS = 5;
export const PIN_LOCKOUT_MINUTES = 15;

/**
 * A PIN guessable from the keypad alone (one digit repeated, or a straight
 * run such as 123456 or 987654) is refused when it is set.
 */
export function validatePin(pin: string, field = 'pin'): Result<string> {
  const invalid = fail<string>([
    domainError(
      'invalid_pin',
      field,
      `PIN must be ${PIN_LENGTH} digits, not one digit repeated or a straight run like 123456`,
    ),
  ]);
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return invalid;
  const digits = Array.from(pin, Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - (digits[i] ?? 0)));
  if (steps.size === 1 && [0, 1, -1].includes([...steps][0] ?? NaN)) return invalid;
  return ok(pin);
}
