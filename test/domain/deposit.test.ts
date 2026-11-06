import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import {
  depositDifferences,
  depositRules,
  validateDeposit,
  type DepositContent,
  type DepositDraft,
} from '../../src/domain/deposit.js';
import { ok, type DomainErrorCode } from '../../src/domain/errors.js';
import { moisturePercentToBps } from '../../src/domain/units.js';
import { deriveWeight } from '../../src/domain/weight.js';
import { validEnv } from '../helpers/env.js';

const config = loadConfig({ ...validEnv(), MAIZE_MOISTURE_MIN_BPS: '800' });
const rules = depositRules(config);
const NOW = new Date('2026-09-28T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const draft = (overrides: Partial<DepositDraft> = {}): DepositDraft => ({
  depositId: '0192f9a4-5b7c-7d1e-8f00-123456789abc',
  commodity: 'MAIZE_WHITE',
  grade: 1,
  moistureBps: ok(1250),
  bagCount: 20,
  ...overrides,
});

function codesFor(overrides: Partial<DepositDraft>): DomainErrorCode[] {
  const result = validateDeposit(draft(overrides), rules, NOW);
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe('deriveWeight', () => {
  it('multiplies bag count by the configured bag size', () => {
    expect(deriveWeight(20, 'MAIZE_WHITE', config.commodities)).toEqual({
      bagSizeKg: 100,
      weightKg: 2000,
    });
  });

  it('follows the configured bag size', () => {
    const fifties = loadConfig({ ...validEnv(), MAIZE_BAG_SIZE_KG: '50' });
    expect(deriveWeight(3, 'MAIZE_YELLOW', fifties.commodities)).toEqual({
      bagSizeKg: 50,
      weightKg: 150,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses bagCount %s', (bags) => {
    expect(() => deriveWeight(bags, 'MAIZE_WHITE', config.commodities)).toThrow(RangeError);
  });
});

describe('validateDeposit', () => {
  it('accepts a valid deposit and derives its weight', () => {
    const result = validateDeposit(
      draft({ depositId: '0192F9A4-5B7C-7D1E-8F00-123456789ABC', notes: '  wet sacks  ' }),
      rules,
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        depositId: '0192f9a4-5b7c-7d1e-8f00-123456789abc',
        commodity: 'MAIZE_WHITE',
        gradingScheme: 'provisional',
        grade: '1',
        moistureBps: 1250,
        bagCount: 20,
        bagCountConfirmed: false,
        bagSizeKg: 100,
        weightKg: 2000,
        notes: 'wet sacks',
        capturedAt: null,
        reviewReasons: [],
      },
    });
  });

  it('reports every failure at once', () => {
    expect(
      codesFor({
        depositId: 'x',
        commodity: 'SORGHUM',
        grade: 9,
        bagCount: 0,
        notes: 'n'.repeat(501),
      }),
    ).toEqual([
      'invalid_deposit_id',
      'unsupported_commodity',
      'invalid_grade',
      'invalid_bag_count',
      'notes_too_long',
    ]);
  });

  describe('deposit_id', () => {
    it.each([
      'dep-0001',
      '',
      '0192f9a4-5b7c-7d1e-8f00-123456789ab',
      'not-a-uuid-at-all-0000000000000000',
    ])('rejects %j', (depositId) => {
      expect(codesFor({ depositId })).toEqual(['invalid_deposit_id']);
    });
  });

  describe('commodity', () => {
    it.each(['MAIZE_WHITE', 'MAIZE_YELLOW'])('accepts %s', (commodity) => {
      expect(codesFor({ commodity })).toEqual([]);
    });
    it.each(['maize_white', 'SORGHUM', ''])('rejects %j', (commodity) => {
      expect(codesFor({ commodity })).toEqual(['unsupported_commodity']);
    });
  });

  describe('grade', () => {
    it.each([1, 2, 3, '1', ' 2 '])('accepts %j', (grade) => {
      expect(codesFor({ grade })).toEqual([]);
    });
    it.each([0, 4, -1, 1.5, Number.NaN, '', 'G1', '1.0'])('rejects %j', (grade) => {
      expect(codesFor({ grade })).toEqual(['invalid_grade']);
    });
  });

  describe('moisture (configured 8.0% to 13.5%, converted at the edge)', () => {
    const moisture = (percent: number) => ({ moistureBps: moisturePercentToBps(percent) });

    it.each([8.0, 8.1, 12.5, 13.4, 13.5])('accepts %s%%', (percent) => {
      expect(codesFor(moisture(percent))).toEqual([]);
    });
    it.each([7.9, 13.6, 0, -0.1, 100])('rejects %s%% as out of range', (percent) => {
      expect(codesFor(moisture(percent))).toEqual(['moisture_out_of_range']);
    });
    it.each([13.45, 12.55, 8.05])('rejects %s%% for having two decimals', (percent) => {
      expect(codesFor(moisture(percent))).toEqual(['invalid_moisture']);
    });
    it('stores basis points and explains limits as percentages', () => {
      const accepted = validateDeposit(draft(moisture(12.5)), rules, NOW);
      expect(accepted.ok && accepted.value.moistureBps).toBe(1250);
      const rejected = validateDeposit(draft(moisture(14)), rules, NOW);
      expect(!rejected.ok && rejected.errors[0]).toEqual({
        code: 'moisture_out_of_range',
        field: 'moisture_pct',
        message: 'Moisture must be between 8% and 13.5%',
      });
    });
    it('reports a conversion error alongside every other problem', () => {
      expect(codesFor({ ...moisture(12.55), grade: 9 })).toEqual([
        'invalid_grade',
        'invalid_moisture',
      ]);
    });
  });

  describe('bag count (confirm above 300, hard maximum 1000)', () => {
    const confirmed = (bagCount: number) => ({ bagCount, confirmBagCount: true });

    it.each([1, 2, 299, 300])('accepts %s without confirmation', (bagCount) => {
      expect(codesFor({ bagCount })).toEqual([]);
    });
    it.each([301, 999, 1000])('asks for confirmation of %s', (bagCount) => {
      expect(codesFor({ bagCount })).toEqual(['bag_count_needs_confirmation']);
      expect(codesFor({ bagCount, confirmBagCount: false })).toEqual([
        'bag_count_needs_confirmation',
      ]);
    });
    it.each([301, 1000])('accepts %s when confirmed, and records the confirmation', (bagCount) => {
      const result = validateDeposit(draft(confirmed(bagCount)), rules, NOW);
      expect(result.ok && result.value.bagCountConfirmed).toBe(true);
    });
    it('does not record a confirmation that was not needed', () => {
      const result = validateDeposit(draft(confirmed(300)), rules, NOW);
      expect(result.ok && result.value.bagCountConfirmed).toBe(false);
    });
    it.each([1001, 5000])('rejects %s even when confirmed', (bagCount) => {
      expect(codesFor(confirmed(bagCount))).toEqual(['bag_count_too_large']);
    });
    it.each([0, -5, 2.5, Number.NaN])('rejects %s as invalid', (bagCount) => {
      expect(codesFor({ bagCount })).toEqual(['invalid_bag_count']);
    });
  });

  describe('notes', () => {
    it('accepts 500 characters and turns blank into null', () => {
      expect(codesFor({ notes: 'n'.repeat(500) })).toEqual([]);
      const result = validateDeposit(draft({ notes: '   ' }), rules, NOW);
      expect(result.ok && result.value.notes).toBeNull();
    });
    it('rejects 501 characters', () => {
      expect(codesFor({ notes: 'n'.repeat(501) })).toEqual(['notes_too_long']);
    });
  });

  describe('captured_at (review after 48 h, reject after 7 days, 5 minutes clock skew)', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    const reviewReasons = (offset: number) => {
      const result = validateDeposit(draft({ capturedAt: at(offset) }), rules, NOW);
      return result.ok ? result.value.reviewReasons : result.errors.map((e) => e.code);
    };

    it('parses a timestamp with an offset', () => {
      const result = validateDeposit(
        draft({ capturedAt: '2026-09-28T10:15:00+01:00' }),
        rules,
        NOW,
      );
      expect(result.ok && result.value.capturedAt?.toISOString()).toBe('2026-09-28T09:15:00.000Z');
    });
    it.each([
      ['5 minutes ahead', 5 * 60 * 1000],
      ['exactly now', 0],
      ['exactly 48 hours ago', -48 * HOUR],
    ])('accepts %s without review', (_label, offset) => {
      expect(reviewReasons(offset)).toEqual([]);
    });
    it.each([
      ['just over 48 hours ago', -48 * HOUR - 1],
      ['3 days ago', -3 * DAY],
      ['exactly 7 days ago', -7 * DAY],
    ])('accepts %s but flags it for review', (_label, offset) => {
      expect(reviewReasons(offset)).toEqual(['late_capture']);
    });
    it('rejects just over 7 days ago', () => {
      expect(reviewReasons(-7 * DAY - 1)).toEqual(['captured_at_too_old']);
      const result = validateDeposit(draft({ capturedAt: at(-8 * DAY) }), rules, NOW);
      expect(!result.ok && result.errors[0]?.message).toBe(
        'captured_at is more than 7 days ago; record it manually with a supervisor',
      );
    });
    it('rejects just over 5 minutes ahead', () => {
      expect(reviewReasons(5 * 60 * 1000 + 1)).toEqual(['captured_at_in_future']);
    });
    it('never flags a deposit without captured_at (captured now)', () => {
      const result = validateDeposit(draft(), rules, NOW);
      expect(result.ok && result.value.reviewReasons).toEqual([]);
    });
    it.each(['2026-09-28', '2026-09-28T10:15:00', 'yesterday', '2026-13-01T00:00:00Z'])(
      'rejects %j',
      (capturedAt) => {
        expect(codesFor({ capturedAt })).toEqual(['invalid_captured_at']);
      },
    );
  });
});

describe('depositDifferences', () => {
  const stored: DepositContent = {
    farmerId: 'aaaaaaaa-0000-4000-8000-000000000001',
    warehouseId: 'aaaaaaaa-0000-4000-8000-000000000002',
    custodianId: 'aaaaaaaa-0000-4000-8000-000000000003',
    verifierId: 'aaaaaaaa-0000-4000-8000-000000000004',
    commodity: 'MAIZE_WHITE',
    grade: '1',
    moistureBps: 1250,
    bagCount: 20,
    notes: null,
  };

  it('finds no difference in an identical repeat, ignoring ID case', () => {
    expect(
      depositDifferences(stored, { ...stored, farmerId: stored.farmerId.toUpperCase() }),
    ).toEqual([]);
  });

  it('names each differing field', () => {
    expect(depositDifferences(stored, { ...stored, bagCount: 21, notes: 'x', grade: '2' })).toEqual(
      ['grade', 'bag_count', 'notes'],
    );
  });

  it('compares notes exactly', () => {
    expect(depositDifferences({ ...stored, notes: 'Wet' }, { ...stored, notes: 'wet' })).toEqual([
      'notes',
    ]);
  });
});
