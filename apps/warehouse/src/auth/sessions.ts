import { HttpError, type ApiClient } from '../api/client';
import { getMeta, setMeta, type AppDb, type StoredSession } from '../db/schema';
import { normaliseNigerianMobile } from '../lib/phone';
import type { Features, SignInResponse } from '../types/api';
import { MAX_FAILED_UNLOCKS, makePinCheck, verifyPinCheck } from './pinCheck';

/**
 * Staff sessions on a shared tablet (docs/decisions.md D41).
 *
 * - Sign-in is online: the API checks phone and PIN and returns a token.
 * - The screen locks after IDLE_LOCK_MS without a touch; the same custodian
 *   unlocks with their PIN, offline too (pinCheck.ts).
 * - Signing out ends the session on the tablet but keeps its token while it
 *   still has captures to send; then it is revoked on the server and deleted.
 *   Signing out never clears the queue.
 */
export const IDLE_LOCK_MS = 5 * 60_000;

export type SignInOutcome =
  | { ok: true; session: StoredSession }
  | {
      ok: false;
      reason:
        | 'invalid_phone'
        | 'invalid_credentials'
        | 'locked_out'
        | 'offline_unknown'
        | 'offline_locked'
        | 'server';
    };

/**
 * Online: the API decides. Offline: only a custodian who signed in online on
 * this tablet before, with a session that hasn't expired, can come back in.
 */
export async function signIn(
  db: AppDb,
  api: ApiClient,
  phoneInput: string,
  pin: string,
  online: boolean,
  now: number = Date.now(),
): Promise<SignInOutcome> {
  const phone = normaliseNigerianMobile(phoneInput);
  if (phone === null) return { ok: false, reason: 'invalid_phone' };

  if (online) {
    try {
      const { data } = await api<SignInResponse>('POST', '/auth/sessions', {
        json: { phone, pin },
      });
      const session: StoredSession = {
        ...data,
        id: data.session.id,
        pinCheck: await makePinCheck(pin),
        failedUnlocks: 0,
        signedInAt: now,
        ended: false,
        invalid: false,
      };
      await db.put('sessions', session);
      await refreshFeatures(db, api);
      return { ok: true, session };
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 429) return { ok: false, reason: 'locked_out' };
        if (err.status === 401) return { ok: false, reason: 'invalid_credentials' };
        if (!err.transient) return { ok: false, reason: 'server' };
      }
      // No answer: fall through to an offline unlock.
    }
  }

  const session = newestFor(await db.getAll('sessions'), phone, now);
  if (session === null) return { ok: false, reason: 'offline_unknown' };
  if (session.failedUnlocks >= MAX_FAILED_UNLOCKS) return { ok: false, reason: 'offline_locked' };
  return unlockWith(db, session, pin);
}

/** Unlocks the lock screen for the session's own custodian. */
export async function unlock(db: AppDb, sessionId: string, pin: string): Promise<SignInOutcome> {
  const session = await db.get('sessions', sessionId);
  if (session === undefined) return { ok: false, reason: 'offline_unknown' };
  if (session.failedUnlocks >= MAX_FAILED_UNLOCKS) return { ok: false, reason: 'offline_locked' };
  return unlockWith(db, session, pin);
}

async function unlockWith(db: AppDb, session: StoredSession, pin: string): Promise<SignInOutcome> {
  if (await verifyPinCheck(pin, session.pinCheck)) {
    const fresh = { ...session, failedUnlocks: 0, ended: false };
    await db.put('sessions', fresh);
    return { ok: true, session: fresh };
  }
  const failedUnlocks = session.failedUnlocks + 1;
  // Too many wrong tries: forget the PIN check, so only an online sign-in works.
  const wiped = failedUnlocks >= MAX_FAILED_UNLOCKS;
  await db.put('sessions', {
    ...session,
    failedUnlocks,
    pinCheck: wiped ? { salt: '', hash: '', iterations: 0 } : session.pinCheck,
  });
  return { ok: false, reason: wiped ? 'offline_locked' : 'invalid_credentials' };
}

function newestFor(sessions: StoredSession[], phone: string, now: number): StoredSession | null {
  return (
    sessions
      .filter(
        (s) => s.custodian.phone === phone && !s.invalid && Date.parse(s.session.expires_at) > now,
      )
      .sort((a, b) => b.signedInAt - a.signedInAt)[0] ?? null
  );
}

/**
 * Ends the session on this tablet. Its token is kept only while captures it
 * made are still queued; otherwise it is revoked on the server (best effort)
 * and deleted.
 */
export async function signOut(db: AppDb, api: ApiClient, sessionId: string): Promise<void> {
  const session = await db.get('sessions', sessionId);
  if (session === undefined) return;
  await db.put('sessions', { ...session, ended: true });
  await releaseEndedSessions(db, api);
}

/** Revokes and deletes ended sessions that have nothing left to send. */
export async function releaseEndedSessions(db: AppDb, api: ApiClient): Promise<void> {
  const outbox = await db.getAll('outbox');
  const waiting = new Set(
    outbox.filter((item) => item.status !== 'done').map((item) => item.sessionId),
  );
  for (const session of await db.getAll('sessions')) {
    if (!session.ended || waiting.has(session.id)) continue;
    if (!session.invalid) {
      try {
        await api('DELETE', '/auth/sessions/current', { token: session.token });
      } catch (err) {
        // Offline: try again later. Already revoked or expired: just delete it.
        if (!(err instanceof HttpError && err.status === 401)) continue;
      }
    }
    await db.delete('sessions', session.id);
  }
}

export async function refreshFeatures(db: AppDb, api: ApiClient): Promise<void> {
  try {
    const { data } = await api<Features>('GET', '/features');
    if (typeof data.intake === 'object') await setMeta(db, 'features', data);
  } catch {
    // Keep the cached rules.
  }
}

export async function cachedFeatures(db: AppDb): Promise<Features | undefined> {
  return getMeta(db, 'features');
}
