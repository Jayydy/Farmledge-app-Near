import { describe, expect, it } from 'vitest';

import { validateFarmerRegistration } from '../../src/domain/farmer.js';

const valid = { fullName: 'Aisha Bello', phone: '0803 123 4567', consent: true };

describe('validateFarmerRegistration', () => {
  it('normalises name and phone; lookup consent defaults to false', () => {
    expect(validateFarmerRegistration({ ...valid, fullName: '  Aisha   Bello ' })).toEqual({
      ok: true,
      value: { fullName: 'Aisha Bello', phone: '+2348031234567', lookupConsent: false },
    });
  });

  it('keeps lookup consent when given', () => {
    const result = validateFarmerRegistration({ ...valid, lookupConsent: true });
    expect(result.ok && result.value.lookupConsent).toBe(true);
  });

  it('rejects registration without data consent', () => {
    const result = validateFarmerRegistration({ ...valid, consent: false });
    expect(result).toEqual({
      ok: false,
      errors: [expect.objectContaining({ code: 'consent_required', field: 'consent' })],
    });
  });

  it.each([
    ['A', false],
    ['Al', true],
    ['a'.repeat(100), true],
    ['a'.repeat(101), false],
    ['   ', false],
  ])('name %j valid: %s', (fullName, ok) => {
    expect(validateFarmerRegistration({ ...valid, fullName }).ok).toBe(ok);
  });

  it('reports every failure at once', () => {
    const result = validateFarmerRegistration({ fullName: '', phone: '123', consent: false });
    expect(!result.ok && result.errors.map((e) => e.code)).toEqual([
      'invalid_name',
      'invalid_phone',
      'consent_required',
    ]);
  });
});
