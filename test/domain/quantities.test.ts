import { describe, expect, it } from 'vitest';

import { sniffPhotoType } from '../../src/domain/photo.js';
import { isKgAmount, percentOf, roundHalfAway, toCentiKg } from '../../src/domain/quantities.js';

describe('kg amounts', () => {
  it.each([0, 0.01, 1, 19750.5, 99_999_999.99, 0.1 + 0.2])('%s is a kg amount', (value) => {
    expect(isKgAmount(value)).toBe(true);
  });
  it.each([-0.01, 0.001, 1.005, 100_000_000, Number.NaN, Number.POSITIVE_INFINITY])(
    '%s is not a kg amount',
    (value) => {
      expect(isKgAmount(value)).toBe(false);
    },
  );
  it('converts numbers and Postgres NUMERIC strings to exact hundredths', () => {
    expect(toCentiKg('19750.50')).toBe(1_975_050);
    expect(toCentiKg(0.1 + 0.2)).toBe(30);
  });
});

describe('rounding', () => {
  it.each([
    [1.245, 1.25],
    [-1.245, -1.25],
    [124.745, 124.75],
    [1.2449, 1.24],
    [0, 0],
    [-0.001, 0],
  ])('roundHalfAway(%s) = %s', (value, expected) => {
    expect(roundHalfAway(value)).toBe(expected);
  });

  it('percentOf is null for a zero whole', () => {
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(-2, 200)).toBe(-1);
    expect(percentOf(1, 3)).toBe(33.33);
  });
});

describe('sniffPhotoType', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);

  it('recognises JPEG, PNG and WebP by their first bytes', () => {
    expect(sniffPhotoType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffPhotoType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(
      sniffPhotoType(
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
      ),
    ).toBe('image/webp');
  });

  it('rejects anything else', () => {
    expect(sniffPhotoType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffPhotoType(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeNull();
    expect(sniffPhotoType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffPhotoType(bytes())).toBeNull();
  });
});
