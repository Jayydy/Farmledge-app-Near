import { NetworkError, type ApiClient } from '../api/client';
import type { AppDb, CachedBalance, StoredSession } from '../db/schema';
import type { BalanceLine, BalanceResponse, FarmerStatement } from '../types/api';

/**
 * Farmers' balances as last seen online on this tablet (docs/decisions.md
 * D43, as amended by D55): bags and kg by commodity and grade, split free /
 * held on-chain, of farmers looked up here, at this warehouse only, for 24
 * hours. No fee amounts and no movement history: a shared tablet holding
 * what each farmer has stored and owes is a physical security risk. Expired
 * entries are deleted, never shown. Wiped with the farmer cache when the
 * tablet is deregistered.
 */
export const BALANCE_TTL_MS = 24 * 3600_000;
/** How far back the balance screen lists deposits and dispatches. */
export const RECENT_DAYS = 30;

export interface Farmer {
  id: string;
  full_name: string;
  phone: string;
}

export type BalanceLookup =
  /** Current figures from the API, with fees and recent movements (null if the statement failed). */
  | { source: 'live'; fetchedAt: number; lines: BalanceLine[]; statement: FarmerStatement | null }
  /** Offline: what this tablet last saw, with its age. Never shown as current. */
  | { source: 'cached'; fetchedAt: number; balance: CachedBalance }
  /** Offline and not looked up here in the last 24 hours. */
  | { source: 'none' };

const fresh = (entry: CachedBalance, now: number) => now - entry.fetchedAt < BALANCE_TTL_MS;

/** YYYY-MM-DD, `days` before `now`, on the tablet's calendar. */
function daysBefore(now: number, days: number): string {
  const date = new Date(now - days * 24 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Online: the API's figures (cached, narrowed). Offline or unreachable: the cache, if fresh. */
export async function lookUpBalance(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  farmer: Farmer,
  online: boolean,
  now: number = Date.now(),
): Promise<BalanceLookup> {
  const warehouseId = session.warehouse.id;
  if (online) {
    try {
      const { data } = await api<BalanceResponse>(
        'GET',
        `/farmers/${farmer.id}/balance?warehouse=${warehouseId}`,
        { token: session.token },
      );
      let statement: FarmerStatement | null = null;
      try {
        statement = (
          await api<FarmerStatement>(
            'GET',
            `/farmers/${farmer.id}/statement?warehouse=${warehouseId}&from=${daysBefore(now, RECENT_DAYS)}`,
            { token: session.token },
          )
        ).data;
      } catch {
        // The quantities are still current; the screen says fees could not be loaded.
      }
      await saveBalance(db, warehouseId, farmer, data.items, now);
      return { source: 'live', fetchedAt: now, lines: data.items, statement };
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
    }
  }
  const cached = await db.get('balances', farmer.id);
  if (cached !== undefined && cached.warehouseId === warehouseId && fresh(cached, now)) {
    return { source: 'cached', fetchedAt: cached.fetchedAt, balance: cached };
  }
  return { source: 'none' };
}

/** Keeps only what D43 (as amended) allows: quantities by commodity and grade. */
async function saveBalance(
  db: AppDb,
  warehouseId: string,
  farmer: Farmer,
  lines: readonly BalanceLine[],
  now: number,
): Promise<void> {
  await db.put('balances', {
    farmerId: farmer.id,
    warehouseId,
    phone: farmer.phone,
    full_name: farmer.full_name,
    lines: lines
      .filter((line) => line.warehouse_id === warehouseId)
      .map((line) => ({
        commodity: line.commodity,
        grade: line.grade,
        bags: line.bags,
        kg: line.kg,
        free_bags: line.free_bags,
        free_kg: line.free_kg,
        held_bags: line.held_on_chain_bags,
        held_kg: line.held_on_chain_kg,
      })),
    fetchedAt: now,
  });
}

/** Farmers looked up at this warehouse in the last 24 hours, newest first. */
export async function recentLookups(
  db: AppDb,
  warehouseId: string,
  now: number = Date.now(),
): Promise<CachedBalance[]> {
  return (await db.getAll('balances'))
    .filter((entry) => entry.warehouseId === warehouseId && fresh(entry, now))
    .sort((a, b) => b.fetchedAt - a.fetchedAt);
}

/** Deletes expired entries. */
export async function purgeExpiredBalances(db: AppDb, now: number = Date.now()): Promise<number> {
  const tx = db.transaction('balances', 'readwrite');
  let removed = 0;
  for (const entry of await tx.store.getAll()) {
    if (!fresh(entry, now)) {
      await tx.store.delete(entry.farmerId);
      removed++;
    }
  }
  await tx.done;
  return removed;
}
