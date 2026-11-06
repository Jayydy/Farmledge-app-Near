import { describe, expect, it } from 'vitest';

import { normaliseNigerianMobile } from '../../src/domain/phone.js';

describe('normaliseNigerianMobile', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['0803 123 4567', '+2348031234567'],
    ['0803-123-4567', '+2348031234567'],
    ['(0803) 123 4567', '+2348031234567'],
    ['8031234567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+2348031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['07011112222', '+2347011112222'],
    ['07123456789', '+2347123456789'],
    ['08123456789', '+2348123456789'],
    ['09012345678', '+2349012345678'],
    ['09112345678', '+2349112345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normaliseNigerianMobile(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'empty'],
    ['0803123456', 'one digit short'],
    ['080312345678', 'one digit long'],
    ['+23480312345678', 'too long after +234'],
    ['+44 7700 900123', 'a UK number'],
    ['2348031234', 'country code with too few digits'],
    ['01234567890', 'a Lagos landline (01…)'],
    ['06012345678', '060 is not a mobile range'],
    ['08231234567', '082 is not a mobile range'],
    ['0803123456a', 'a letter'],
    ['+0803 123 4567', 'a plus with a local number'],
  ])('rejects %s (%s)', (input) => {
    const result = normaliseNigerianMobile(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'invalid_phone', field: 'phone' }),
      ]);
    }
  });

  it('reports the field it was given', () => {
    const result = normaliseNigerianMobile('nope', 'farmer_phone');
    expect(!result.ok && result.errors[0]?.field).toBe('farmer_phone');
  });
});
