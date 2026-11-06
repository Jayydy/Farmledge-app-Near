import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import {
  buildAuditReport,
  validateAuditLine,
  samePersonName,
  validateAuditStart,
  MAX_COUNTED_BAGS,
} from '../../src/domain/audit.js';
import { summariseScaleSamples, validateScaleSample } from '../../src/domain/scale.js';
import { validEnv } from '../helpers/env.js';

const config = loadConfig(validEnv());
const NOW = new Date('2026-09-28T12:00:00Z');

describe('validateScaleSample', () => {
  const codes = (bagsWeighed: number, totalKg: number, recordedAt?: string) => {
    const result = validateScaleSample({ bagsWeighed, totalKg, recordedAt }, 168, NOW);
    return result.ok ? [] : result.errors.map((e) => e.code);
  };

  it('accepts a sample and stores kg as hundredths', () => {
    expect(validateScaleSample({ bagsWeighed: 3, totalKg: 285.4 }, 168, NOW)).toEqual({
      ok: true,
      value: { bagsWeighed: 3, totalCentiKg: 28_540, recordedAt: null },
    });
  });
  it.each([0, -1, 1.5])('rejects bags_weighed %s', (bags) => {
    expect(codes(bags, 100)).toEqual(['invalid_bags_weighed']);
  });
  it.each([0, -1, 100.001, 100_000_000])('rejects total_kg %s', (kg) => {
    expect(codes(1, kg)).toEqual(['invalid_kg']);
  });
  it('accepts 0.01 kg and 2 decimals', () => {
    expect(codes(1, 0.01)).toEqual([]);
    expect(codes(1, 99.99)).toEqual([]);
  });
  it('checks recorded_at like an offline capture', () => {
    expect(codes(1, 100, '2027-01-01T00:00:00Z')).toEqual(['captured_at_in_future']);
    const result = validateScaleSample({ bagsWeighed: 1, totalKg: 1, recordedAt: 'x' }, 168, NOW);
    expect(!result.ok && result.errors[0]?.field).toBe('recorded_at');
  });
});

describe('summariseScaleSamples', () => {
  it('reports average against nominal bag weight', () => {
    // 10 bags weighed 985.50 kg in total against a 100 kg bag assumption.
    expect(
      summariseScaleSamples({
        sampleCount: 3,
        bagsWeighed: 10,
        totalCentiKg: 98_550,
        nominalKg: 1000,
      }),
    ).toEqual({
      sample_count: 3,
      bags_weighed: 10,
      total_kg: 985.5,
      avg_kg_per_bag: 98.55,
      nominal_kg_per_bag: 100,
      variance_kg_per_bag: -1.45,
      variance_pct: -1.45,
    });
  });

  it('reports heavier bags as a positive variance', () => {
    const summary = summariseScaleSamples({
      sampleCount: 1,
      bagsWeighed: 3,
      totalCentiKg: 31_000,
      nominalKg: 300,
    });
    expect(summary.avg_kg_per_bag).toBe(103.33);
    expect(summary.variance_kg_per_bag).toBe(3.33);
    expect(summary.variance_pct).toBe(3.33);
  });

  it('has nulls, not zeros or NaN, with no samples', () => {
    expect(
      summariseScaleSamples({ sampleCount: 0, bagsWeighed: 0, totalCentiKg: 0, nominalKg: 0 }),
    ).toEqual({
      sample_count: 0,
      bags_weighed: 0,
      total_kg: 0,
      avg_kg_per_bag: null,
      nominal_kg_per_bag: null,
      variance_kg_per_bag: null,
      variance_pct: null,
    });
  });
});

describe('validateAuditLine', () => {
  const line = { commodity: 'MAIZE_WHITE', grade: 2, countedBags: 198 };

  it('assumes bags × bag size when kg was not weighed', () => {
    expect(validateAuditLine(line, config)).toEqual({
      ok: true,
      value: {
        commodity: 'MAIZE_WHITE',
        gradingScheme: 'provisional',
        grade: '2',
        countedBags: 198,
        countedCentiKg: 1_980_000,
        countedKgEstimated: true,
        notes: null,
      },
    });
  });

  it('uses weighed kg when given, including zero', () => {
    const weighed = validateAuditLine({ ...line, countedKg: 19_750.5 }, config);
    expect(weighed.ok && weighed.value).toMatchObject({
      countedCentiKg: 1_975_050,
      countedKgEstimated: false,
    });
    const empty = validateAuditLine({ ...line, countedBags: 0, countedKg: 0 }, config);
    expect(empty.ok && empty.value.countedCentiKg).toBe(0);
  });

  it.each([
    [{ commodity: 'RICE' }, 'unsupported_commodity'],
    [{ grade: 4 }, 'invalid_grade'],
    [{ countedBags: -1 }, 'invalid_counted_bags'],
    [{ countedBags: 1.5 }, 'invalid_counted_bags'],
    [{ countedBags: MAX_COUNTED_BAGS + 1 }, 'invalid_counted_bags'],
    [{ countedKg: -1 }, 'invalid_kg'],
    [{ countedKg: 1.234 }, 'invalid_kg'],
    [{ notes: 'n'.repeat(501) }, 'notes_too_long'],
  ])('rejects %j with %s', (overrides, code) => {
    const result = validateAuditLine({ ...line, ...overrides }, config);
    expect(!result.ok && result.errors.map((e) => e.code)).toEqual([code]);
  });

  it('accepts the counted-bags boundaries', () => {
    expect(validateAuditLine({ ...line, countedBags: 0 }, config).ok).toBe(true);
    expect(validateAuditLine({ ...line, countedBags: MAX_COUNTED_BAGS }, config).ok).toBe(true);
  });
});

describe('validateAuditStart', () => {
  const people = { countedBy: 'Musa Bello', witnessedBy: 'Hauwa Sani' };

  it('defaults start to now and checks backdating', () => {
    expect(validateAuditStart(people, 168, NOW)).toEqual({
      ok: true,
      value: { startedAt: null, ...people, notes: null },
    });
    const old = validateAuditStart({ ...people, startedAt: '2026-01-01T00:00:00Z' }, 168, NOW);
    expect(!old.ok && old.errors[0]).toMatchObject({
      code: 'captured_at_too_old',
      field: 'started_at',
    });
  });

  it('needs who counted and who witnessed, tidying their spaces', () => {
    const tidy = validateAuditStart(
      { countedBy: '  Musa   Bello ', witnessedBy: 'Hauwa Sani' },
      168,
      NOW,
    );
    expect(tidy.ok && tidy.value.countedBy).toBe('Musa Bello');
    const missing = validateAuditStart({ countedBy: ' ', witnessedBy: 'x'.repeat(121) }, 168, NOW);
    expect(!missing.ok && missing.errors.map((e) => e.code)).toEqual([
      'invalid_counted_by',
      'invalid_witnessed_by',
    ]);
  });
});

describe('samePersonName', () => {
  it('ignores case and spacing, nothing else', () => {
    expect(samePersonName(' musa  BELLO', 'Musa Bello')).toBe(true);
    expect(samePersonName('Musa Bello', 'Musa Bell')).toBe(false);
  });
});

describe('buildAuditReport', () => {
  it('computes differences and percentages per line and in total', () => {
    const report = buildAuditReport([
      {
        commodity: 'MAIZE_WHITE',
        grade: '1',
        recordedBags: 200,
        recordedKg: '20000',
        countedBags: 198,
        countedKg: '19750.50',
      },
      {
        commodity: 'MAIZE_YELLOW',
        grade: '2',
        recordedBags: 50,
        recordedKg: 5000,
        countedBags: 51,
        countedKg: 5100,
      },
    ]);
    expect(report.lines).toEqual([
      {
        commodity: 'MAIZE_WHITE',
        grade: '1',
        recorded_bags: 200,
        counted_bags: 198,
        difference_bags: -2,
        difference_bags_pct: -1,
        recorded_kg: 20000,
        counted_kg: 19750.5,
        difference_kg: -249.5,
        difference_kg_pct: -1.25, // -1.2475 rounded half away from zero
      },
      {
        commodity: 'MAIZE_YELLOW',
        grade: '2',
        recorded_bags: 50,
        counted_bags: 51,
        difference_bags: 1,
        difference_bags_pct: 2,
        recorded_kg: 5000,
        counted_kg: 5100,
        difference_kg: 100,
        difference_kg_pct: 2,
      },
    ]);
    expect(report.totals).toEqual({
      recorded_bags: 250,
      counted_bags: 249,
      difference_bags: -1,
      difference_bags_pct: -0.4,
      recorded_kg: 25000,
      counted_kg: 24850.5,
      difference_kg: -149.5,
      difference_kg_pct: -0.6,
    });
  });

  it('gives a null percentage where nothing was recorded', () => {
    const report = buildAuditReport([
      {
        commodity: 'MAIZE_WHITE',
        grade: '3',
        recordedBags: 0,
        recordedKg: 0,
        countedBags: 4,
        countedKg: 400,
      },
    ]);
    expect(report.lines[0]).toMatchObject({
      difference_bags: 4,
      difference_bags_pct: null,
      difference_kg_pct: null,
    });
  });

  it('is exact where floating point is not (0.1 + 0.2)', () => {
    const report = buildAuditReport([
      {
        commodity: 'MAIZE_WHITE',
        grade: '1',
        recordedBags: 1,
        recordedKg: '0.10',
        countedBags: 1,
        countedKg: '0.30',
      },
      {
        commodity: 'MAIZE_WHITE',
        grade: '2',
        recordedBags: 1,
        recordedKg: '0.20',
        countedBags: 1,
        countedKg: '0.00',
      },
    ]);
    expect(report.totals.recorded_kg).toBe(0.3);
    expect(report.totals.difference_kg).toBe(0);
  });

  it('totals zero for an audit with no lines', () => {
    expect(buildAuditReport([]).totals).toMatchObject({
      recorded_bags: 0,
      difference_kg: 0,
      difference_kg_pct: null,
    });
  });
});
