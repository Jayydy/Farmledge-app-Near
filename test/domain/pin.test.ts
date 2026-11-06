import { describe, expect, it } from 'vitest';

import { validatePin } from '../../src/domain/pin.js';
import { hashPin, verifyPin } from '../../src/services/auth.js';

describe('validatePin', () => {
  it.each(['482915', '019283', '112358'])('accepts %s', (pin) => {
    expect(validatePin(pin)).toEqual({ ok: true, value: pin });
  });

  it.each([
    ['12345', 'too short'],
    ['1234567', 'too long'],
    ['12a456', 'not all digits'],
    ['000000', 'one digit repeated'],
    ['123456', 'a rising run'],
    ['987654', 'a falling run'],
    ['', 'empty'],
  ])('rejects %s (%s)', (pin) => {
    const result = validatePin(pin);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]?.code).toBe('invalid_pin');
  });
});

describe('PIN hashing', () => {
  it('verifies the right PIN and refuses a wrong one, never storing the PIN', async () => {
    const stored = await hashPin('482915');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(stored).not.toContain('482915');
    expect(await verifyPin('482915', stored)).toBe(true);
    expect(await verifyPin('482916', stored)).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPin('482915')).not.toBe(await hashPin('482915'));
  });
});
