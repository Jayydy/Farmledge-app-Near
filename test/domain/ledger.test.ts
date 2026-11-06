import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import type { DomainErrorCode } from '../../src/domain/errors.js';
import {
  bookCentiKgFor,
  deriveBalances,
  lowestRunningBags,
  mayCancel,
  shrinkageReview,
  toleranceFor,
  validateAdjustment,
  validateDispatch,
  type AdjustmentDraft,
  type DispatchDraft,
  type Movement,
} from '../../src/domain/ledger.js';
import { validEnv } from '../helpers/env.js';

const grading = loadConfig(validEnv()).grading;

const key = {
  warehouseId: 'w1',
  farmerId: 'f1',
  commodity: 'MAIZE_WHITE',
  gradingScheme: 'provisional',
  grade: '1',
};
const at = (iso: string) => new Date(iso);
const move = (
  bagsDelta: number,
  kgDelta: number | string,
  occurredAt: string,
  over = {},
): Movement => ({
  ...key,
  bagsDelta,
  kgDelta,
  occurredAt: at(occurredAt),
  ...over,
});

describe('deriveBalances', () => {
  const movements = [
    move(20, 2000, '2026-09-01T09:00:00Z'),
    move(-5, '-500.00', '2026-09-03T09:00:00Z'),
    // Offline capture that reached the server after the dispatch above.
    move(10, 1000, '2026-09-02T09:00:00Z'),
    // Adjustment: one bag lost to spoilage, plus a weight correction.
    move(-1, '-87.35', '2026-09-04T09:00:00Z'),
  ];

  it('sums movements into a balance per farmer, commodity and grade', () => {
    expect(deriveBalances(movements)).toEqual([{ ...key, bags: 24, centiKg: 241_265 }]);
  });

  it('gives the same balance whatever order the movements arrive in', () => {
    const reversed = [...movements].reverse();
    const shuffled = [movements[2], movements[0], movements[3], movements[1]].filter(
      (m): m is Movement => m !== undefined,
    );
    expect(deriveBalances(reversed)).toEqual(deriveBalances(movements));
    expect(deriveBalances(shuffled)).toEqual(deriveBalances(movements));
  });

  it('places a late offline capture on the day it happened, not the day it arrived', () => {
    // As of 2 Sept the offline capture counts though it arrived later.
    expect(deriveBalances(movements, at('2026-09-02T23:59:59Z'))).toEqual([
      { ...key, bags: 30, centiKg: 300_000 },
    ]);
    expect(deriveBalances(movements, at('2026-09-01T23:59:59Z'))).toEqual([
      { ...key, bags: 20, centiKg: 200_000 },
    ]);
  });

  it('keeps grades and farmers apart and drops balances that are zero', () => {
    const result = deriveBalances([
      move(5, 500, '2026-09-01T09:00:00Z'),
      move(-5, -500, '2026-09-02T09:00:00Z'),
      move(3, 300, '2026-09-01T09:00:00Z', { grade: '2' }),
      move(4, 400, '2026-09-01T09:00:00Z', { farmerId: 'f2' }),
    ]);
    expect(result).toEqual([
      { ...key, grade: '2', bags: 3, centiKg: 30_000 },
      { ...key, farmerId: 'f2', bags: 4, centiKg: 40_000 },
    ]);
  });

  it('adds kg exactly, without floating-point drift', () => {
    const many = Array.from({ length: 10 }, () => move(1, '0.10', '2026-09-01T09:00:00Z'));
    expect(deriveBalances(many)[0]?.centiKg).toBe(100);
  });
});

describe('bookCentiKgFor', () => {
  it('takes the bags share of the balance kg', () => {
    expect(bookCentiKgFor({ bags: 30, centiKg: 300_000 }, 5)).toBe(50_000);
    expect(bookCentiKgFor({ bags: 3, centiKg: 10_000 }, 1)).toBe(3_333);
  });

  it('takes the whole balance when every bag leaves, leaving no residue', () => {
    expect(bookCentiKgFor({ bags: 3, centiKg: 10_000 }, 3)).toBe(10_000);
  });
});

describe('validateDispatch', () => {
  const draft = (overrides: Partial<DispatchDraft> = {}): DispatchDraft => ({
    dispatchId: '0192F9A4-5B7C-7D1E-8F00-123456789ABC',
    commodity: 'MAIZE_WHITE',
    grade: 1,
    bagCount: 5,
    notWeighedReason: 'No scale at this warehouse',
    ...overrides,
  });
  const codes = (overrides: Partial<DispatchDraft>): DomainErrorCode[] => {
    const result = validateDispatch(draft(overrides), grading);
    return result.ok ? [] : result.errors.map((error) => error.code);
  };

  it('normalises a valid dispatch', () => {
    expect(
      validateDispatch(
        draft({
          exitWeightKg: 495.5,
          notWeighedReason: undefined,
          buyerName: '  Alh. Musa  ',
        }),
        grading,
      ),
    ).toEqual({
      ok: true,
      value: {
        dispatchId: '0192f9a4-5b7c-7d1e-8f00-123456789abc',
        commodity: 'MAIZE_WHITE',
        gradingScheme: 'provisional',
        grade: '1',
        bagCount: 5,
        exitCentiKg: 49_550,
        notWeighedReason: null,
        buyerName: 'Alh. Musa',
        notes: null,
      },
    });
  });

  it('reports every problem at once', () => {
    expect(
      codes({
        dispatchId: 'nope',
        commodity: 'SORGHUM',
        grade: 7,
        bagCount: 0,
        exitWeightKg: 1.234,
        buyerName: 'x'.repeat(201),
      }),
    ).toEqual([
      'invalid_dispatch_id',
      'unsupported_commodity',
      'invalid_grade',
      'invalid_bag_count',
      'invalid_kg',
      'not_weighed_reason_with_weight',
      'buyer_name_too_long',
    ]);
  });

  it.each([0, -10])('rejects an exit weight of %s', (exitWeightKg) => {
    expect(codes({ exitWeightKg, notWeighedReason: undefined })).toEqual(['invalid_kg']);
  });

  it('keeps the trimmed reason for an unweighed dispatch', () => {
    const result = validateDispatch(draft({ notWeighedReason: '  Scale broken  ' }), grading);
    expect(result.ok && result.value).toMatchObject({
      exitCentiKg: null,
      notWeighedReason: 'Scale broken',
    });
  });

  it.each([
    ['left out', undefined],
    ['blank', '   '],
    ['too long', 'x'.repeat(501)],
  ])('requires a reason without an exit weight (%s)', (_case, notWeighedReason) => {
    expect(codes({ notWeighedReason })).toEqual(['not_weighed_reason_required']);
  });
});

describe('validateAdjustment', () => {
  const draft = (overrides: Partial<AdjustmentDraft> = {}): AdjustmentDraft => ({
    adjustmentId: '0192f9a4-5b7c-7d1e-8f00-123456789abc',
    commodity: 'MAIZE_WHITE',
    grade: '1',
    bagsDelta: -1,
    kgDelta: -87.35,
    reasonCode: 'spoilage',
    notes: ' Rats ',
    ...overrides,
  });
  const codes = (overrides: Partial<AdjustmentDraft>): DomainErrorCode[] => {
    const result = validateAdjustment(draft(overrides), grading);
    return result.ok ? [] : result.errors.map((error) => error.code);
  };

  it('accepts negative and positive deltas and keeps kg exact', () => {
    const result = validateAdjustment(draft(), grading);
    expect(result.ok && result.value).toMatchObject({
      bagsDelta: -1,
      centiKgDelta: -8_735,
      notes: 'Rats',
      reasonCode: 'spoilage',
    });
    expect(codes({ bagsDelta: 2, kgDelta: 0 })).toEqual([]);
    expect(codes({ bagsDelta: 0, kgDelta: 12.5 })).toEqual([]);
  });

  it('refuses an adjustment that changes nothing', () => {
    expect(codes({ bagsDelta: 0, kgDelta: 0 })).toEqual(['empty_adjustment']);
  });

  it('requires a reason a person may give, and notes', () => {
    expect(codes({ reasonCode: 'scale_reweigh', notes: '  ' })).toEqual([
      'invalid_reason',
      'notes_required',
    ]);
  });

  it('rejects fractional bags and kg beyond two decimals', () => {
    expect(codes({ bagsDelta: 1.5, kgDelta: 1.234 })).toEqual([
      'invalid_bags_delta',
      'invalid_kg_delta',
    ]);
  });
});

describe('shrinkageReview', () => {
  it('flags an exit losing more than the tolerance, and nothing else', () => {
    // 1 000 kg booked, 2% tolerance.
    expect(shrinkageReview(100_000, 97_900, 200)).toEqual(['shrinkage_above_threshold']);
    expect(shrinkageReview(100_000, 98_000, 200)).toEqual([]);
    expect(shrinkageReview(100_000, 101_000, 200)).toEqual([]);
    expect(shrinkageReview(100_000, null, 200)).toEqual([]);
  });
});

describe('cancellation rules', () => {
  it('lets custodians cancel within the window and only owners after it', () => {
    expect(mayCancel('custodian', true)).toBe(true);
    expect(mayCancel('custodian', false)).toBe(false);
    expect(mayCancel('warehouse_owner', false)).toBe(true);
  });

  it('finds the lowest balance at any point, in the order things happened', () => {
    const m = (bagsDelta: number, iso: string) => ({ bagsDelta, occurredAt: at(iso) });
    // Without the cancelled deposit: 10 in, 15 out, 20 in. Now 15, but -5 on the 3rd.
    expect(
      lowestRunningBags([
        m(20, '2026-09-04T09:00:00Z'),
        m(-15, '2026-09-03T09:00:00Z'),
        m(10, '2026-09-01T09:00:00Z'),
      ]),
    ).toBe(-5);
    expect(lowestRunningBags([m(10, '2026-09-01T09:00:00Z'), m(-10, '2026-09-02T09:00:00Z')])).toBe(
      0,
    );
  });
});

describe('toleranceFor', () => {
  const white = { commodity: 'MAIZE_WHITE', bps: 150 };
  const warehouseDefault = { commodity: null, bps: 300 };

  it("uses the commodity's own tolerance when there is one", () => {
    expect(toleranceFor([warehouseDefault, white], 'MAIZE_WHITE')).toEqual({
      setting: white,
      source: 'commodity',
    });
  });

  it('falls back to the warehouse default when the commodity has none', () => {
    expect(toleranceFor([white, warehouseDefault], 'MAIZE_YELLOW')).toEqual({
      setting: warehouseDefault,
      source: 'warehouse',
    });
  });

  it('returns null when neither exists, so the configured default applies', () => {
    expect(toleranceFor([white], 'MAIZE_YELLOW')).toBeNull();
    expect(toleranceFor([], 'MAIZE_WHITE')).toBeNull();
  });
});
