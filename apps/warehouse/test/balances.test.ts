import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpError, NetworkError, type ApiClient } from '../src/api/client';
import { openAppDb, type AppDb, type StoredSession } from '../src/db/schema';
import {
  BALANCE_TTL_MS,
  lookUpBalance,
  purgeExpiredBalances,
  recentLookups,
} from '../src/farmers/balances';
import { deregisterDevice } from '../src/farmers/cache';
import type { BalanceLine, FarmerStatement } from '../src/types/api';

const NOW = Date.parse('2026-10-10T09:00:00Z');
const WAREHOUSE = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'KN-DAWANAU',
  name: 'Dawanau',
};
const OTHER_WAREHOUSE = '99999999-9999-4999-8999-999999999999';
const FARMER = {
  id: '44444444-4444-4444-8444-444444444444',
  full_name: 'Musa Bello',
  phone: '+2348031234567',
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

const line: BalanceLine = {
  warehouse_id: WAREHOUSE.id,
  farmer_id: FARMER.id,
  commodity: 'MAIZE_WHITE',
  grading_scheme: 'provisional',
  grade: '1',
  bags: 30,
  kg: 2985,
  free_bags: 20,
  free_kg: 2000,
  held_on_chain_bags: 10,
  held_on_chain_kg: 985,
  held_on_chain_lots: [2],
};

const statement = {
  farmer: FARMER,
  warehouse: WAREHOUSE,
  period: { from: '2026-09-10', to: '2026-10-10' },
  accrued_through: '2026-10-09',
  stock: { movements: [{ date: '2026-10-01', bags_delta: 20 }] },
  fees: { closing_outstanding_ngn: 4500 },
} as unknown as FarmerStatement;

/** Answers balance and statement; `online: false` is a network failure. */
function fakeApi(state: { online: boolean; calls: string[] }): ApiClient {
  return ((_method: string, path: string) => {
    state.calls.push(path);
    if (!state.online) return Promise.reject(new NetworkError('offline'));
    if (path.startsWith(`/farmers/${FARMER.id}/balance`)) {
      return Promise.resolve({ status: 200, data: { farmer_id: FARMER.id, items: [line] } });
    }
    if (path.startsWith(`/farmers/${FARMER.id}/statement`)) {
      return Promise.resolve({ status: 200, data: statement });
    }
    return Promise.reject(new HttpError(404, { error: { code: 'not_found', message: path } }));
  }) as ApiClient;
}

describe('balance cache (D43 as amended, D55)', () => {
  let db: AppDb;
  let state: { online: boolean; calls: string[] };
  let api: ApiClient;

  beforeEach(async () => {
    db = await openAppDb(`test-${randomUUID()}`);
    state = { online: true, calls: [] };
    api = fakeApi(state);
  });
  afterEach(() => {
    db.close();
  });

  it('online: returns current figures with fees and movements, and keeps only quantities', async () => {
    const live = await lookUpBalance(db, api, session, FARMER, true, NOW);
    expect(live).toMatchObject({ source: 'live', fetchedAt: NOW, statement });
    expect(state.calls.some((path) => path.includes('/statement?') && path.includes('from='))).toBe(
      true,
    );

    const stored = await db.get('balances', FARMER.id);
    expect(stored).toEqual({
      farmerId: FARMER.id,
      warehouseId: WAREHOUSE.id,
      phone: FARMER.phone,
      full_name: FARMER.full_name,
      lines: [
        {
          commodity: 'MAIZE_WHITE',
          grade: '1',
          bags: 30,
          kg: 2985,
          free_bags: 20,
          free_kg: 2000,
          held_bags: 10,
          held_kg: 985,
        },
      ],
      fetchedAt: NOW,
    });
    // No fee amounts, movements or lot numbers on the tablet.
    const text = JSON.stringify(stored);
    expect(text).not.toContain('4500');
    expect(text).not.toContain('movements');
    expect(text).not.toContain('held_on_chain_lots');
  });

  it('offline: shows the cached figures with their age, never as current', async () => {
    await lookUpBalance(db, api, session, FARMER, true, NOW);
    state.online = false;
    const later = NOW + 5 * 3600_000;
    const cached = await lookUpBalance(db, api, session, FARMER, true, later);
    expect(cached).toMatchObject({ source: 'cached', fetchedAt: NOW });
    expect(await lookUpBalance(db, api, session, FARMER, false, later)).toMatchObject({
      source: 'cached',
      fetchedAt: NOW,
    });
  });

  it('expires after 24 hours: an expired entry is never shown, and is deleted', async () => {
    await lookUpBalance(db, api, session, FARMER, true, NOW);
    state.online = false;
    const justInside = NOW + BALANCE_TTL_MS - 1;
    expect((await lookUpBalance(db, api, session, FARMER, false, justInside)).source).toBe(
      'cached',
    );
    const expired = NOW + BALANCE_TTL_MS;
    expect(await lookUpBalance(db, api, session, FARMER, false, expired)).toEqual({
      source: 'none',
    });
    expect(await recentLookups(db, WAREHOUSE.id, expired)).toEqual([]);

    expect(await purgeExpiredBalances(db, justInside)).toBe(0);
    expect(await purgeExpiredBalances(db, expired)).toBe(1);
    expect(await db.get('balances', FARMER.id)).toBeUndefined();
  });

  it('is per warehouse: another warehouse’s tablet session sees nothing', async () => {
    await lookUpBalance(db, api, session, FARMER, true, NOW);
    state.online = false;
    const elsewhere = { ...session, warehouse: { ...WAREHOUSE, id: OTHER_WAREHOUSE } };
    expect(await lookUpBalance(db, api, elsewhere, FARMER, false, NOW + 60_000)).toEqual({
      source: 'none',
    });
    expect(await recentLookups(db, OTHER_WAREHOUSE, NOW + 60_000)).toEqual([]);
    expect((await recentLookups(db, WAREHOUSE.id, NOW + 60_000)).map((e) => e.farmerId)).toEqual([
      FARMER.id,
    ]);
  });

  it('is wiped when the tablet is deregistered', async () => {
    await lookUpBalance(db, api, session, FARMER, true, NOW);
    await deregisterDevice(db);
    expect(await db.count('balances')).toBe(0);
  });

  it('stays live without fees when only the statement fails', async () => {
    const flaky: ApiClient = (async (method: 'GET', path: string) => {
      if (path.includes('/statement')) throw new HttpError(500, null);
      return api(method, path);
    }) as ApiClient;
    const live = await lookUpBalance(db, flaky, session, FARMER, true, NOW);
    expect(live).toMatchObject({ source: 'live', statement: null });
  });
});
