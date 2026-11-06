import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signIn, signOut, unlock } from '../src/auth/sessions';
import { MAX_FAILED_UNLOCKS } from '../src/auth/pinCheck';
import { openAppDb, type AppDb } from '../src/db/schema';
import {
  deregisterDevice,
  FARMER_TTL_MS,
  findFarmer,
  purgeExpiredFarmers,
} from '../src/farmers/cache';
import { saveCapture } from '../src/sync/capture';
import type { ApiClient } from '../src/api/client';
import { NetworkError } from '../src/api/client';
import type { SignInResponse } from '../src/types/api';

const NOW = Date.parse('2026-10-07T09:00:00Z');
const WAREHOUSE = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'KN-DAWANAU',
  name: 'Dawanau',
};

const signInResponse: SignInResponse = {
  token: 'token-a',
  session: { id: 'session-a', expires_at: new Date(NOW + 168 * 3600_000).toISOString() },
  custodian: {
    id: '22222222-2222-4222-8222-222222222222',
    full_name: 'Amina Sani',
    phone: '+2348000000001',
  },
  warehouse: WAREHOUSE,
  roster: { verifiers: [] },
};

/** Answers sign-in for PIN 482915; everything else is a network failure unless `online`. */
function fakeApi(state: { online: boolean; calls: string[] }): ApiClient {
  return (async (method: string, path: string, options?: { json?: unknown }) => {
    state.calls.push(`${method} ${path}`);
    if (!state.online) throw new NetworkError('offline');
    if (path === '/auth/sessions') {
      const { pin } = options?.json as { pin: string };
      if (pin !== '482915') {
        const { HttpError } = await import('../src/api/client');
        throw new HttpError(401, { error: { code: 'invalid_credentials', message: 'wrong' } });
      }
      return { status: 201, data: signInResponse };
    }
    if (path === '/features') return { status: 200, data: {} };
    if (path.startsWith('/farmers?phone=')) return { status: 200, data: { items: [] } };
    return { status: 204, data: null };
  }) as ApiClient;
}

describe('on the tablet', () => {
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

  describe('sign-in', () => {
    it('signs in online and keeps a PIN check, never the PIN', async () => {
      const outcome = await signIn(db, api, '0800 000 0001', '482915', true, NOW);
      expect(outcome.ok).toBe(true);
      const stored = await db.get('sessions', 'session-a');
      expect(stored?.token).toBe('token-a');
      expect(JSON.stringify(stored)).not.toContain('482915');
    });

    it('lets the same custodian back in offline with the right PIN only', async () => {
      await signIn(db, api, '08000000001', '482915', true, NOW);
      state.online = false;
      expect((await signIn(db, api, '08000000001', '000111', false, NOW)).ok).toBe(false);
      expect((await signIn(db, api, '08000000001', '482915', false, NOW)).ok).toBe(true);
    });

    it('refuses offline someone who never signed in on this tablet', async () => {
      state.online = false;
      expect(await signIn(db, api, '08000000009', '482915', false, NOW)).toEqual({
        ok: false,
        reason: 'offline_unknown',
      });
    });

    it('forgets the PIN check after too many wrong unlocks', async () => {
      await signIn(db, api, '08000000001', '482915', true, NOW);
      for (let i = 0; i < MAX_FAILED_UNLOCKS; i++) await unlock(db, 'session-a', '999990');
      expect(await unlock(db, 'session-a', '482915')).toEqual({
        ok: false,
        reason: 'offline_locked',
      });
    });

    it('keeps the token after sign-out while captures still need it, never clearing the queue', async () => {
      const { session } = (await signIn(db, api, '08000000001', '482915', true, NOW)) as {
        session: { id: string };
      };
      await saveCapture(db, {
        depositId: randomUUID(),
        capturedAt: new Date(NOW),
        session: { id: session.id, custodian: signInResponse.custodian, warehouse: WAREHOUSE },
        verifier: { id: randomUUID(), full_name: 'V' },
        farmer: { kind: 'known', id: randomUUID(), full_name: 'F', phone: '+2348031234567' },
        commodity: 'MAIZE_WHITE',
        grade: '1',
        moisturePct: 12,
        bagCount: 3,
        confirmBagCount: false,
        sample: null,
        photos: [],
      });

      await signOut(db, api, session.id);
      expect(await db.get('sessions', session.id)).toMatchObject({ ended: true });
      expect(await db.count('outbox')).toBe(1);
      expect(state.calls).not.toContain('DELETE /auth/sessions/current');
    });

    it('revokes and deletes the session on sign-out when nothing is waiting', async () => {
      await signIn(db, api, '08000000001', '482915', true, NOW);
      await signOut(db, api, 'session-a');
      expect(state.calls).toContain('DELETE /auth/sessions/current');
      expect(await db.get('sessions', 'session-a')).toBeUndefined();
    });
  });

  describe('farmer cache (D43)', () => {
    const farmer = (phone: string, confirmedAt: number, localFarmerId: string | null = null) => ({
      phone,
      full_name: 'Musa Bello',
      id: localFarmerId === null ? randomUUID() : null,
      localFarmerId,
      confirmedAt,
      warehouseId: WAREHOUSE.id,
    });

    it('finds a cached farmer offline, but not once the entry has expired', async () => {
      await signIn(db, api, '08000000001', '482915', true, NOW);
      const session = await db.get('sessions', 'session-a');
      if (session === undefined) throw new Error('no session');
      state.online = false;
      await db.put('farmers', farmer('+2348031234567', NOW));

      expect(await findFarmer(db, api, session, '0803 123 4567', false, NOW)).toMatchObject({
        kind: 'found',
      });
      expect(
        await findFarmer(db, api, session, '0803 123 4567', false, NOW + FARMER_TTL_MS),
      ).toEqual({
        kind: 'unknown_offline',
      });
    });

    it('purges expired entries but keeps farmers whose registration is still queued', async () => {
      await db.put('farmers', farmer('+2348031234567', NOW - FARMER_TTL_MS - 1));
      await db.put('farmers', farmer('+2348031234568', NOW - FARMER_TTL_MS - 1, randomUUID()));
      await db.put('farmers', farmer('+2348031234569', NOW));
      expect(await purgeExpiredFarmers(db, NOW)).toBe(1);
      expect((await db.getAllKeys('farmers')).sort()).toEqual(['+2348031234568', '+2348031234569']);
    });

    it('wipes farmers and sessions on deregistration, and never the outbox', async () => {
      await signIn(db, api, '08000000001', '482915', true, NOW);
      await db.put('farmers', farmer('+2348031234567', NOW));
      await saveCapture(db, {
        depositId: randomUUID(),
        capturedAt: new Date(NOW),
        session: { id: 'session-a', custodian: signInResponse.custodian, warehouse: WAREHOUSE },
        verifier: { id: randomUUID(), full_name: 'V' },
        farmer: { kind: 'known', id: randomUUID(), full_name: 'F', phone: '+2348031234567' },
        commodity: 'MAIZE_WHITE',
        grade: '1',
        moisturePct: 12,
        bagCount: 3,
        confirmBagCount: false,
        sample: null,
        photos: [
          {
            photoId: randomUUID(),
            blob: new Blob([new Uint8Array([1])]),
            contentType: 'image/jpeg',
            sha256: '0'.repeat(64),
          },
        ],
      });

      await deregisterDevice(db);

      expect(await db.count('farmers')).toBe(0);
      expect(await db.count('sessions')).toBe(0);
      expect(await db.count('outbox')).toBe(2);
      expect(await db.count('photoBlobs')).toBe(1);
      expect(await db.count('deposits')).toBe(1);
    });
  });
});
