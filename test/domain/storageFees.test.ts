import { describe, expect, it } from 'vitest';

import type { DomainErrorCode } from '../../src/domain/errors.js';
import {
  accrualRows,
  accrualWindow,
  computeExpectedCharges,
  dailyCharge,
  feeStatementFigures,
  outstandingKobo,
  scheduleOn,
  validatePayment,
  validateSchedule,
  type ExpectedCharge,
  type FeeSchedule,
  type LedgerEvent,
} from '../../src/domain/storageFees.js';

const key = {
  warehouseId: 'w1',
  farmerId: 'f1',
  commodity: 'MAIZE_WHITE',
  gradingScheme: 'provisional',
  grade: '1',
};

const schedule = (overrides: Partial<FeeSchedule> = {}): FeeSchedule => ({
  id: 's1',
  commodity: null,
  basis: 'per_bag',
  period: 'day',
  rateNgn: 10,
  minimumDays: null,
  effectiveFrom: '2026-01-01',
  ...overrides,
});

const event = (
  kind: LedgerEvent['kind'],
  day: string,
  bagsDelta: number,
  over: Partial<LedgerEvent> = {},
): LedgerEvent => ({
  ...key,
  kind,
  day,
  bagsDelta,
  centiKgDelta: bagsDelta * 10_000,
  depositId: kind.startsWith('deposit') ? 'd1' : null,
  ...over,
});

const charges = (
  events: LedgerEvent[],
  schedules: FeeSchedule[],
  from: string,
  to: string,
): ExpectedCharge[] =>
  computeExpectedCharges({ events, schedules: new Map([['w1', schedules]]), from, to });

describe('rates', () => {
  it('picks the latest schedule starting on or before the day', () => {
    const list = [schedule({ id: 'a' }), schedule({ id: 'b', effectiveFrom: '2026-03-01' })];
    expect(scheduleOn(list, '2025-12-31')).toBeNull();
    expect(scheduleOn(list, '2026-02-28')?.id).toBe('a');
    expect(scheduleOn(list, '2026-03-01')?.id).toBe('b');
  });

  it('prefers a schedule for the commodity and falls back to the default', () => {
    const list = [
      schedule({ id: 'default' }),
      schedule({ id: 'white', commodity: 'MAIZE_WHITE', effectiveFrom: '2026-02-01' }),
      schedule({ id: 'default-2', effectiveFrom: '2026-03-01' }),
    ];
    expect(scheduleOn(list, '2026-01-15', 'MAIZE_WHITE')?.id).toBe('default');
    expect(scheduleOn(list, '2026-02-15', 'MAIZE_WHITE')?.id).toBe('white');
    // A later default doesn't override a commodity's own schedule.
    expect(scheduleOn(list, '2026-03-15', 'MAIZE_WHITE')?.id).toBe('white');
    expect(scheduleOn(list, '2026-03-15', 'MAIZE_YELLOW')?.id).toBe('default-2');
    expect(
      scheduleOn([schedule({ commodity: 'MAIZE_WHITE' })], '2026-03-15', 'MAIZE_YELLOW'),
    ).toBeNull();
  });

  it('charges each commodity under its own schedule or the default', () => {
    const result = computeExpectedCharges({
      events: [
        event('deposit_in', '2026-01-10', 10),
        event('deposit_in', '2026-01-10', 10, { commodity: 'MAIZE_YELLOW', depositId: 'd2' }),
      ],
      schedules: new Map([
        ['w1', [schedule(), schedule({ id: 'w', commodity: 'MAIZE_WHITE', rateNgn: 30 })]],
      ]),
      from: '2026-01-10',
      to: '2026-01-10',
    });
    expect(result.map((c) => [c.commodity, c.scheduleId, c.amountNgn])).toEqual([
      ['MAIZE_WHITE', 'w', 300],
      ['MAIZE_YELLOW', 's1', 100],
    ]);
  });

  it('spreads a monthly rate over the days of that month, so a full month is the rate', () => {
    const monthly = schedule({ period: 'month', rateNgn: 100 });
    for (const [month, days] of [
      ['2026-01', 31],
      ['2026-02', 28],
      ['2026-04', 30],
    ] as const) {
      let sum = 0;
      for (let day = 1; day <= days; day += 1) {
        sum += dailyCharge(monthly, `${month}-${String(day).padStart(2, '0')}`, 20, 0);
      }
      expect(Math.round(sum * 100) / 100).toBe(2000);
    }
  });

  it('charges a weekly rate as a seventh a day, and per tonne on kg', () => {
    expect(dailyCharge(schedule({ period: 'week', rateNgn: 70 }), '2026-01-05', 3, 0)).toBe(30);
    // 2 500 kg at 400 per tonne per day = 1 000.
    expect(
      dailyCharge(schedule({ basis: 'per_tonne', rateNgn: 400 }), '2026-01-05', 25, 250_000),
    ).toBe(1000);
  });
});

describe('computeExpectedCharges', () => {
  it('charges the end-of-day balance for every day it is held', () => {
    const result = charges(
      [
        event('deposit_in', '2026-01-10', 20),
        event('dispatch_out', '2026-01-12', -5, { depositId: null }),
      ],
      [schedule()],
      '2026-01-09',
      '2026-01-13',
    );
    expect(result.map((c) => [c.date, c.bags, c.amountNgn])).toEqual([
      ['2026-01-10', 20, 200],
      ['2026-01-11', 20, 200],
      ['2026-01-12', 15, 150],
      ['2026-01-13', 15, 150],
    ]);
  });

  it('charges each day under the schedule in force that day', () => {
    const result = charges(
      [event('deposit_in', '2026-01-10', 20)],
      [schedule(), schedule({ id: 's2', rateNgn: 25, effectiveFrom: '2026-01-12' })],
      '2026-01-10',
      '2026-01-13',
    );
    expect(result.map((c) => [c.date, c.scheduleId, c.amountNgn])).toEqual([
      ['2026-01-10', 's1', 200],
      ['2026-01-11', 's1', 200],
      ['2026-01-12', 's2', 500],
      ['2026-01-13', 's2', 500],
    ]);
  });

  it('charges nothing on days with no schedule', () => {
    const result = charges(
      [event('deposit_in', '2026-01-10', 20)],
      [schedule({ effectiveFrom: '2026-01-12' })],
      '2026-01-10',
      '2026-01-12',
    );
    expect(result.map((c) => c.date)).toEqual(['2026-01-12']);
  });

  describe('minimum period', () => {
    const minimum = schedule({ minimumDays: 30 });

    it('tops up the missing days when bags leave early', () => {
      const result = charges(
        [
          event('deposit_in', '2026-01-01', 20),
          event('dispatch_out', '2026-01-11', -5, { depositId: null }),
        ],
        [minimum],
        '2026-01-11',
        '2026-01-11',
      );
      // 5 bags stored 10 days of 30: 20 days × 5 bags × 10.
      expect(result.filter((c) => c.kind === 'minimum_topup')).toEqual([
        expect.objectContaining({ date: '2026-01-11', bags: 5, amountNgn: 1000 }),
      ]);
    });

    it('takes dispatched bags from the oldest stock first', () => {
      const result = charges(
        [
          event('deposit_in', '2026-01-01', 10, { depositId: 'old' }),
          event('deposit_in', '2026-01-25', 10, { depositId: 'new' }),
          event('dispatch_out', '2026-02-05', -15, { depositId: null }),
        ],
        [minimum],
        '2026-02-05',
        '2026-02-05',
      );
      // 10 old bags held 35 days: no top-up. 5 new bags held 11 days: 19 days × 5 × 10.
      expect(result.filter((c) => c.kind === 'minimum_topup')).toEqual([
        expect.objectContaining({ bags: 5, amountNgn: 950 }),
      ]);
    });

    it('uses the minimum of the schedule in force when the stock came in', () => {
      const result = charges(
        [
          event('deposit_in', '2026-01-01', 10),
          event('dispatch_out', '2026-01-06', -10, { depositId: null }),
        ],
        [
          schedule({ minimumDays: 7 }),
          schedule({ id: 's2', minimumDays: null, effectiveFrom: '2026-01-03' }),
        ],
        '2026-01-06',
        '2026-01-06',
      );
      expect(result.filter((c) => c.kind === 'minimum_topup')).toEqual([
        expect.objectContaining({ scheduleId: 's1', bags: 10, amountNgn: 200 }),
      ]);
    });

    it('does not top up for spoilage adjustments or after the minimum', () => {
      const result = charges(
        [
          event('deposit_in', '2026-01-01', 20),
          event('adjustment', '2026-01-05', -2, { depositId: null }),
          event('dispatch_out', '2026-02-15', -18, { depositId: null }),
        ],
        [minimum],
        '2026-01-01',
        '2026-02-15',
      );
      expect(result.filter((c) => c.kind === 'minimum_topup')).toEqual([]);
    });

    it('removes a voided deposit from the stock it matches', () => {
      const result = charges(
        [
          event('deposit_in', '2026-01-01', 10, { depositId: 'kept' }),
          event('deposit_in', '2026-01-20', 10, { depositId: 'voided' }),
          event('deposit_void', '2026-01-21', -10, { depositId: 'voided' }),
          event('dispatch_out', '2026-01-25', -10, { depositId: null }),
        ],
        [minimum],
        '2026-01-25',
        '2026-01-25',
      );
      // The dispatch takes the 10 kept bags (24 days held): 6 days × 10 × 10.
      expect(result.filter((c) => c.kind === 'minimum_topup')).toEqual([
        expect.objectContaining({ bags: 10, amountNgn: 600 }),
      ]);
    });
  });
});

describe('accrualRows', () => {
  const scheduleFor = () => 's1';
  const expected = charges(
    [event('deposit_in', '2026-01-10', 20)],
    [schedule()],
    '2026-01-10',
    '2026-01-11',
  );
  const asAccrued = (list: ExpectedCharge[]) =>
    list.map((c) => ({ ...key, kind: c.kind, date: c.date, amountNgn: c.amountNgn }));

  it('writes a daily row for each day charged for the first time', () => {
    expect(
      accrualRows(expected, [], scheduleFor).map((r) => [r.kind, r.date, r.amountNgn]),
    ).toEqual([
      ['daily', '2026-01-10', 200],
      ['daily', '2026-01-11', 200],
    ]);
  });

  it('writes nothing when run again: accrual is idempotent', () => {
    expect(accrualRows(expected, asAccrued(expected), scheduleFor)).toEqual([]);
  });

  it('adds a correction for a late offline capture instead of changing old rows', () => {
    const withLate = charges(
      [event('deposit_in', '2026-01-10', 20), event('deposit_in', '2026-01-11', 5)],
      [schedule()],
      '2026-01-10',
      '2026-01-11',
    );
    expect(
      accrualRows(withLate, asAccrued(expected), scheduleFor).map((r) => [
        r.kind,
        r.date,
        r.amountNgn,
      ]),
    ).toEqual([['correction', '2026-01-11', 50]]);
  });

  it('reverses a day that is no longer owed (deposit voided)', () => {
    expect(
      accrualRows([], asAccrued(expected), scheduleFor).map((r) => [r.kind, r.amountNgn]),
    ).toEqual([
      ['correction', -200],
      ['correction', -200],
    ]);
  });
});

describe('accrualWindow', () => {
  it('starts at the first movement on the first run', () => {
    expect(accrualWindow('2026-01-31', null, '2026-01-02', 8)).toEqual({
      from: '2026-01-02',
      to: '2026-01-31',
    });
  });

  it('always rechecks the correction window', () => {
    expect(accrualWindow('2026-01-31', '2026-01-30', '2026-01-02', 8)).toEqual({
      from: '2026-01-24',
      to: '2026-01-31',
    });
  });

  it('catches up on missed days', () => {
    expect(accrualWindow('2026-01-31', '2026-01-10', null, 8).from).toBe('2026-01-11');
  });
});

describe('statement arithmetic', () => {
  it('makes opening + accrued − paid equal closing to the kobo', () => {
    const figures = feeStatementFigures({
      accruedBeforeStart: 333.3333,
      accruedThroughEnd: 1000.0049,
      paidBeforeStart: 300,
      paidThroughEnd: 500.5,
    });
    expect(figures).toEqual({
      opening_outstanding_ngn: 33.33,
      accrued_ngn: 666.67,
      paid_ngn: 200.5,
      closing_outstanding_ngn: 499.5,
    });
    const {
      opening_outstanding_ngn: o,
      accrued_ngn: a,
      paid_ngn: p,
      closing_outstanding_ngn: c,
    } = figures;
    expect(Math.round((o + a - p) * 100)).toBe(Math.round(c * 100));
  });

  it('rounds the outstanding amount to the kobo', () => {
    expect(outstandingKobo(1666.66666, 1000)).toBe(66_667);
  });
});

describe('validateSchedule and validatePayment', () => {
  const scheduleCodes = (overrides: Record<string, unknown>): DomainErrorCode[] => {
    const result = validateSchedule({
      basis: 'per_bag',
      period: 'month',
      rateNgn: 150,
      effectiveFrom: '2026-10-01',
      reason: 'New season rates',
      ...overrides,
    });
    return result.ok ? [] : result.errors.map((e) => e.code);
  };

  it('accepts a valid schedule, minimum and commodity optional', () => {
    expect(scheduleCodes({})).toEqual([]);
    expect(scheduleCodes({ commodity: 'MAIZE_WHITE' })).toEqual([]);
    expect(scheduleCodes({ minimumDays: 30, rateNgn: 0 })).toEqual([]);
  });

  it('reports every schedule problem', () => {
    expect(
      scheduleCodes({
        basis: 'per_sack',
        period: 'year',
        rateNgn: 1.005,
        minimumDays: 0,
        effectiveFrom: '2026-02-30',
      }),
    ).toEqual([
      'invalid_basis',
      'invalid_period',
      'invalid_rate',
      'invalid_minimum_days',
      'invalid_date',
    ]);
  });

  const paymentCodes = (overrides: Record<string, unknown>): DomainErrorCode[] => {
    const result = validatePayment(
      { amountNgn: 500, reference: 'RCPT-1', paidOn: '2026-10-01', method: 'cash', ...overrides },
      '2026-10-01',
    );
    return result.ok ? [] : result.errors.map((e) => e.code);
  };

  it('accepts a payment and rejects bad ones', () => {
    expect(paymentCodes({})).toEqual([]);
    expect(
      paymentCodes({ amountNgn: 0, reference: ' ', paidOn: '2026-10-02', method: 'crypto' }),
    ).toEqual(['invalid_amount', 'invalid_reference', 'date_in_future', 'invalid_method']);
  });
});
