import type { ApiClient } from '../api/client';
import { getMeta, setMeta, type AppDb, type CachedFarmer, type StoredSession } from '../db/schema';
import { normaliseNigerianMobile } from '../lib/phone';
import type { FarmerDirectoryPage, FindFarmerResponse } from '../types/api';

/**
 * The farmer lookup cache (docs/decisions.md D43): id, phone and name of
 * this warehouse's farmers only, each with a 7-day time to live. Expired
 * entries are deleted, never used.
 */
export const FARMER_TTL_MS = 7 * 24 * 3600_000;
/** How often the whole directory is refreshed while online. */
export const DIRECTORY_REFRESH_MS = 6 * 3600_000;

export type FarmerLookup =
  | { kind: 'found'; farmer: CachedFarmer }
  | { kind: 'not_found' }
  /** Offline and not in the cache: the farmer may exist; registering is safe (the API matches by phone). */
  | { kind: 'unknown_offline' };

const fresh = (farmer: CachedFarmer, now: number) =>
  farmer.localFarmerId !== null || now - farmer.confirmedAt < FARMER_TTL_MS;

/** Looks the phone up online when possible, else in the cache. */
export async function findFarmer(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  phoneInput: string,
  online: boolean,
  now: number = Date.now(),
): Promise<FarmerLookup | null> {
  const phone = normaliseNigerianMobile(phoneInput);
  if (phone === null) return null;
  const cached = await db.get('farmers', phone);

  // A farmer registered on this tablet and still queued is only known here.
  if (cached?.localFarmerId != null) return { kind: 'found', farmer: cached };

  if (online) {
    try {
      const { data } = await api<FindFarmerResponse>(
        'GET',
        `/farmers?phone=${encodeURIComponent(phone)}`,
        { token: session.token },
      );
      const found = data.items.find((f) =>
        f.warehouses.some((w) => w.warehouse_id === session.warehouse.id),
      );
      if (found === undefined) {
        if (cached !== undefined) await db.delete('farmers', phone);
        // Known at another warehouse: registering here links them (the API matches by phone).
        return { kind: 'not_found' };
      }
      const farmer: CachedFarmer = {
        phone,
        full_name: found.full_name,
        id: found.id,
        localFarmerId: null,
        confirmedAt: now,
        warehouseId: session.warehouse.id,
      };
      await db.put('farmers', farmer);
      return { kind: 'found', farmer };
    } catch {
      // Fall back to the cache.
    }
  }

  if (cached !== undefined && cached.warehouseId === session.warehouse.id && fresh(cached, now)) {
    return { kind: 'found', farmer: cached };
  }
  return { kind: 'unknown_offline' };
}

/** Deletes expired entries. Never touches farmers whose registration is still queued. */
export async function purgeExpiredFarmers(db: AppDb, now: number = Date.now()): Promise<number> {
  const tx = db.transaction('farmers', 'readwrite');
  let removed = 0;
  for (const farmer of await tx.store.getAll()) {
    if (!fresh(farmer, now)) {
      await tx.store.delete(farmer.phone);
      removed++;
    }
  }
  await tx.done;
  return removed;
}

/**
 * Replaces the cache with the warehouse's directory, every DIRECTORY_REFRESH_MS.
 * Farmers registered here and still queued are kept.
 */
export async function refreshDirectory(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  now: number = Date.now(),
  force = false,
): Promise<boolean> {
  const last = (await getMeta(db, 'directoryRefreshedAt')) ?? 0;
  if (!force && now - last < DIRECTORY_REFRESH_MS) return false;
  const entries: CachedFarmer[] = [];
  let cursor: string | null = null;
  try {
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const { data }: { data: FarmerDirectoryPage } = await api<FarmerDirectoryPage>(
        'GET',
        `/warehouses/${session.warehouse.id}/farmers?limit=1000${query}`,
        { token: session.token },
      );
      for (const item of data.items) {
        entries.push({
          phone: item.phone,
          full_name: item.full_name,
          id: item.id,
          localFarmerId: null,
          confirmedAt: now,
          warehouseId: session.warehouse.id,
        });
      }
      cursor = data.next_cursor;
    } while (cursor !== null);
  } catch {
    return false;
  }
  const tx = db.transaction('farmers', 'readwrite');
  for (const farmer of await tx.store.getAll()) {
    if (farmer.localFarmerId === null) await tx.store.delete(farmer.phone);
  }
  for (const entry of entries) {
    const existing = await tx.store.get(entry.phone);
    if (existing?.localFarmerId == null) await tx.store.put(entry);
  }
  await tx.done;
  await setMeta(db, 'directoryRefreshedAt', now);
  return true;
}

/**
 * Deregistering the tablet: deletes the farmer and balance caches, cached
 * rules and every session. Never touches the outbox or the photos waiting
 * in it.
 */
export async function deregisterDevice(db: AppDb): Promise<void> {
  const tx = db.transaction(['farmers', 'balances', 'sessions', 'meta'], 'readwrite');
  await tx.objectStore('farmers').clear();
  await tx.objectStore('balances').clear();
  await tx.objectStore('sessions').clear();
  await tx.objectStore('meta').delete('directoryRefreshedAt');
  await tx.objectStore('meta').delete('features');
  await tx.done;
}
