import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpError, type ApiClient } from '../src/api/client';
import {
  countLine,
  finishCount,
  openCount,
  parseCountedBags,
  samePersonName,
  startCount,
} from '../src/audit/count';
import {
  getMeta,
  openAppDb,
  type AppDb,
  type LocalDeposit,
  type StoredSession,
} from '../src/db/schema';
import {
  businessDate,
  loadDaySummary,
  localToday,
  shiftDate,
  summariseIn,
  summariseOut,
} from '../src/summary/day';
import type { AuditReport, AuditView, DepositView, DispatchView } from '../src/types/api';

const NOW = Date.parse('2026-10-11T09:00:00Z');
const WAREHOUSE = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'KN-DAWANAU',
  name: 'Dawanau',
};

const session: StoredSession = {
  id: 'session-a',
  token: 'token-a',
  session: { id: 'session-a', expires_at: new Date(NOW + 168 * 3600_000).toISOString() },
  custodian: {
    id: '22222222-2222-4222-8222-222222222222',
    full_name: 'Amina Sani',
    phone: '+2348000000001',
  },
  warehouse: WAREHOUSE,
  roster: { verifiers: [] },
  pinCheck: { salt: '', hash: '', iterations: 1 },
  failedUnlocks: 0,
  signedInAt: NOW,
  ended: false,
  invalid: false,
};

const deposit = (overrides: Partial<DepositView> = {}): DepositView =>
  ({
    deposit_id: randomUUID(),
    deposit_no: 1,
    warehouse_id: WAREHOUSE.id,
    commodity: 'MAIZE_WHITE',
    grade: '1',
    bag_count: 10,
    bag_size_kg: 100,
    weight_kg: 1000,
    weight_source: 'bag_estimate',
    status: 'recorded',
    captured_at: '2026-10-11T08:00:00+01:00',
    ...overrides,
  }) as DepositView;

const dispatch = (overrides: Partial<DispatchView> = {}): DispatchView =>
  ({
    dispatch_id: randomUUID(),
    warehouse_id: WAREHOUSE.id,
    commodity: 'MAIZE_WHITE',
    grade: '1',
    bag_count: 5,
    book_kg: 500,
    exit_weight_kg: 495,
    not_weighed_reason: null,
    delivery_note_no: 'DN-1',
    status: 'completed',
    dispatched_at: '2026-10-11T09:00:00+01:00',
    lots_drawn: [],
    ...overrides,
  }) as DispatchView;

type Handler = (method: string, path: string, json: unknown) => unknown;

/** A stub API: each call is logged, and `handle` answers or throws. */
function stubApi(handle: Handler, calls: string[] = []): ApiClient {
  return (async (method: string, path: string, options: { json?: unknown } = {}) => {
    calls.push(`${method} ${path}`);
    return { status: 200, data: await handle(method, path, options.json) };
  }) as ApiClient;
}

describe('business dates', () => {
  it('uses the warehouse time zone, not UTC', () => {
    // 23:30 UTC on the 10th is 00:30 on the 11th in Lagos.
    expect(businessDate(Date.parse('2026-10-10T23:30:00Z'), 'Africa/Lagos')).toBe('2026-10-11');
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('day figures (D57)', () => {
  it('counts deposits in, with bag-estimated as a plain figure, and leaves out cancelled and rejected', () => {
    expect(
      summariseIn([
        deposit(),
        deposit({ weight_source: 'scale', weight_kg: 985 }),
        deposit({ weight_kg: null }),
        deposit({ status: 'cancelled' }),
        deposit({ status: 'rejected' }),
      ]),
    ).toEqual({ deposits: 3, bags: 30, kg: 2985, bagEstimated: 2 });
  });

  it('counts completed dispatches out, and how many went unweighed', () => {
    expect(
      summariseOut([
        dispatch(),
        dispatch({ exit_weight_kg: null, not_weighed_reason: 'No scale today' }),
        dispatch({ status: 'pending_confirmation' }),
      ]),
    ).toEqual({ dispatches: 2, bags: 10, kg: 995, notWeighed: 1 });
  });

  it('loads one day: every deposit page, the dispatches and the warehouse-wide blocked count', async () => {
    const calls: string[] = [];
    const api = stubApi((_method, path) => {
      if (path.startsWith('/deposits') && !path.includes('cursor=')) {
        return { items: [deposit()], next_cursor: 'page-2' };
      }
      if (path.startsWith('/deposits')) return { items: [deposit()], next_cursor: null };
      if (path.startsWith('/dispatches')) return { items: [dispatch()] };
      if (path.includes('/dispatch-blocked')) {
        return { warehouse_id: WAREHOUSE.id, from: '2026-10-11', to: '2026-10-11', blocked: 3 };
      }
      throw new Error(path);
    }, calls);
    const day = await loadDaySummary(api, session, '2026-10-11', () => NOW);
    expect(day).toMatchObject({
      date: '2026-10-11',
      fetchedAt: NOW,
      in: { deposits: 2, bags: 20 },
      out: { dispatches: 1, notWeighed: 0 },
      blocked: 3,
      dispatchesTruncated: false,
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        `GET /deposits?warehouse=${WAREHOUSE.id}&from=2026-10-11&to=2026-10-11&limit=200`,
        `GET /deposits?warehouse=${WAREHOUSE.id}&from=2026-10-11&to=2026-10-11&limit=200&cursor=page-2`,
        `GET /warehouses/${WAREHOUSE.id}/dispatch-blocked?from=2026-10-11&to=2026-10-11`,
      ]),
    );
  });
});

describe('on the tablet', () => {
  let db: AppDb;

  beforeEach(async () => {
    db = await openAppDb(`test-${randomUUID()}`);
  });
  afterEach(() => {
    db.close();
  });

  it('offline, counts only this tablet’s deposits today at this warehouse', async () => {
    const local = (captured_at: string, warehouseId = WAREHOUSE.id, bags = 4) =>
      ({
        deposit_id: randomUUID(),
        captured_at,
        warehouse: { ...WAREHOUSE, id: warehouseId },
        bag_count: bags,
      }) as LocalDeposit;
    for (const d of [
      local('2026-10-11T07:00:00+01:00'),
      local('2026-10-11T09:30:00+01:00', WAREHOUSE.id, 6),
      local('2026-10-10T23:00:00+01:00'),
      local('2026-10-11T08:00:00+01:00', '99999999-9999-4999-8999-999999999999'),
    ]) {
      await db.put('deposits', d);
    }
    expect(await localToday(db, session, 'Africa/Lagos', NOW)).toEqual({ deposits: 2, bags: 10 });
  });

  describe('stock count', () => {
    const audit: AuditView = {
      id: '33333333-3333-4333-8333-333333333333',
      warehouse_id: WAREHOUSE.id,
      conducted_by: null,
      entered_by: session.custodian.id,
      counted_by: 'Musa Bello',
      witnessed_by: 'Hauwa Sani',
      status: 'open',
      started_at: '2026-10-11T09:00:00Z',
      completed_at: null,
      notes: null,
    };
    const report: AuditReport = {
      audit: { ...audit, status: 'completed', completed_at: '2026-10-11T10:00:00Z' },
      lines: [
        {
          commodity: 'MAIZE_WHITE',
          grade: '1',
          recorded_bags: 20,
          counted_bags: 19,
          difference_bags: -1,
          difference_bags_pct: -5,
          recorded_kg: 2000,
          counted_kg: 1900,
          difference_kg: -100,
          difference_kg_pct: -5,
        },
      ],
      totals: {
        recorded_bags: 20,
        counted_bags: 19,
        difference_bags: -1,
        difference_bags_pct: -5,
        recorded_kg: 2000,
        counted_kg: 1900,
        difference_kg: -100,
        difference_kg_pct: -5,
      },
      uncounted: [],
    };
    const lineView = {
      id: 'l1',
      audit_id: audit.id,
      commodity: 'MAIZE_WHITE',
      grading_scheme: 'provisional',
      grade: '1',
      recorded_bags: 20,
      recorded_kg: 2000,
      counted_bags: 19,
      counted_kg: 1900,
      counted_kg_estimated: true,
      variance_bags: -1,
      variance_kg: -100,
      notes: null,
    };

    it('starts as the signed-in custodian, naming counter and witness, and keeps the open count', async () => {
      let sent: unknown;
      const api = stubApi((_method, _path, json) => {
        sent = json;
        return { audit };
      });
      await startCount(db, api, session, { countedBy: ' Musa Bello ', witnessedBy: 'Hauwa Sani' });
      expect(sent).toMatchObject({
        warehouse_id: WAREHOUSE.id,
        entered_by: session.custodian.id,
        counted_by: 'Musa Bello',
        witnessed_by: 'Hauwa Sani',
      });
      expect(await openCount(db, session)).toEqual({ audit, lines: [] });
      // Another warehouse's session never sees it.
      expect(
        await openCount(db, { ...session, warehouse: { ...WAREHOUSE, id: randomUUID() } }),
      ).toBeNull();
    });

    it('keeps each saved line, and recovers the lines from the report when a retry finds it saved', async () => {
      const open = { audit, lines: [] };
      const saved = await countLine(
        db,
        stubApi(() => ({ line: lineView })),
        session,
        open,
        { commodity: 'MAIZE_WHITE', grade: '1', counted_bags: 19 },
      );
      expect(saved.saved).toMatchObject({
        recorded_bags: 20,
        counted_bags: 19,
        difference_bags: -1,
      });
      expect((await getMeta(db, 'openAudit'))?.lines).toHaveLength(1);

      // The first answer was lost: the server has the line, the tablet doesn't.
      const retry = await countLine(
        db,
        stubApi((_method, path) => {
          if (path.endsWith('/lines')) {
            throw new HttpError(409, {
              error: { code: 'audit_line_exists', message: 'already counted' },
            });
          }
          return report;
        }),
        session,
        open,
        { commodity: 'MAIZE_WHITE', grade: '1', counted_bags: 19 },
      );
      expect(retry.repeated).toBe(true);
      expect(retry.open.lines).toEqual([
        expect.objectContaining({ commodity: 'MAIZE_WHITE', grade: '1', difference_kg: -100 }),
      ]);
    });

    it('finishes even if the count was already closed, then drops the tablet copy', async () => {
      await db.put('meta', { audit, lines: [] }, 'openAudit');
      const api = stubApi((_method, path) => {
        if (path.endsWith('/complete')) {
          throw new HttpError(409, { error: { code: 'audit_completed', message: 'done' } });
        }
        return report;
      });
      expect(await finishCount(db, api, session, { audit, lines: [] })).toEqual(report);
      expect(await openCount(db, session)).toBeNull();
    });

    it('keeps the tablet copy when finishing fails', async () => {
      await db.put('meta', { audit, lines: [] }, 'openAudit');
      const api = stubApi(() => {
        throw new HttpError(500, { error: { code: 'internal_error', message: 'boom' } });
      });
      await expect(finishCount(db, api, session, { audit, lines: [] })).rejects.toThrow();
      expect(await openCount(db, session)).not.toBeNull();
    });
  });
});

describe('typed names and counts', () => {
  it('compares names as the API does', () => {
    expect(samePersonName(' amina  SANI ', 'Amina Sani')).toBe(true);
    expect(samePersonName('Amina Sani', 'Amina Sanni')).toBe(false);
  });

  it('accepts 0 counted bags, but nothing that isn’t a whole number', () => {
    expect(parseCountedBags('0')).toBe(0);
    expect(parseCountedBags('198')).toBe(198);
    for (const bad of ['', '1.5', '-1', '1000001']) expect(parseCountedBags(bad)).toBeNull();
  });
});
