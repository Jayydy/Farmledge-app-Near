import { describe, expect, it } from 'vitest';

import { bpsToMoisturePercent, moisturePercentToBps } from '../../src/domain/units.js';

describe('moisturePercentToBps', () => {
  it.each([
    [0, 0],
    [0.1, 10],
    [12.5, 1250],
    [12.3, 1230], // 12.3 × 100 is 1230.0000000000002 in floating point
    [13.4, 1340],
    [13.5, 1350],
    [13.6, 1360], // converts fine; the configured range rejects it later
    [99.9, 9990],
    [100, 10_000],
    [-0.1, -10], // likewise left to the range rule
    [0.1 + 0.2, 30], // 0.30000000000000004 is still one decimal
  ])('converts %s%% to %s bps', (percent, bps) => {
    expect(moisturePercentToBps(percent)).toEqual({ ok: true, value: bps });
  });

  it.each([12.55, 12.05, 13.45, 0.01, 13.51, 1e-9, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s (more than one decimal, or not a number)',
    (percent) => {
      expect(moisturePercentToBps(percent)).toEqual({
        ok: false,
        errors: [
          {
            code: 'invalid_moisture',
            field: 'moisture_pct',
            message: 'Moisture must be a percentage with at most one decimal place, e.g. 12.5',
          },
        ],
      });
    },
  );

  it('reports the field it was given', () => {
    const result = moisturePercentToBps(1.23, 'moisture');
    expect(!result.ok && result.errors[0]?.field).toBe('moisture');
  });
});

describe('bpsToMoisturePercent', () => {
  it.each([
    [0, 0],
    [10, 0.1],
    [1250, 12.5],
    [1350, 13.5],
    [10_000, 100],
  ])('converts %s bps to %s%%', (bps, percent) => {
    expect(bpsToMoisturePercent(bps)).toBe(percent);
  });

  it('round-trips every one-decimal percentage from 0 to 100', () => {
    for (let tenths = 0; tenths <= 1000; tenths++) {
      const percent = tenths / 10;
      const bps = moisturePercentToBps(percent);
      expect(bps.ok && bpsToMoisturePercent(bps.value)).toBe(percent);
    }
  });
});
