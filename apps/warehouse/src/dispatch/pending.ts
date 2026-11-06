import { HttpError, NetworkError, type ApiClient } from '../api/client';
import type { AppDb, PendingDispatch, StoredSession } from '../db/schema';
import type { DispatchReadResponse, DispatchRequest, DispatchResponse } from '../types/api';

/**
 * Dispatches sent but not yet known to be recorded (D54, D56). Saved before
 * the first send, so closing the tablet, a reload or a crash never loses
 * one. Each is resolved by facts, never by inference:
 *
 * 1. The same request is sent again (the API ignores a repeat dispatch_id).
 *    An answer settles it: recorded. A 400, or a 409 on balance or lot,
 *    proves nothing exists under this id (the API looks for a repeat first),
 *    so: not recorded.
 * 2. Any other refusal (a 401 because the sign-in ended, a 403 because only
 *    another custodian is signed in) proves nothing about an earlier send.
 *    Then the dispatch itself is read, with any sign-in on this tablet: 200
 *    means recorded, 404 not recorded.
 * 3. No answer, or a server error: still unconfirmed; tried again later.
 */

/** A short reference to write on paper while a dispatch is pending: X-3F9A-C21B. */
export function dispatchReference(dispatchId: string): string {
  const hex = dispatchId.replaceAll('-', '').toUpperCase();
  return `X-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/** How long the custodian waits at the counter before "Leave pending" is offered. */
export const LEAVE_PENDING_AFTER_MS = 5 * 60_000;

const PROVES_NOT_RECORDED = new Set(['insufficient_balance', 'lot_governed_on_chain']);

export async function savePending(
  db: AppDb,
  request: DispatchRequest,
  session: StoredSession,
  farmerName: string,
  now: number = Date.now(),
): Promise<PendingDispatch> {
  const existing = await db.get('pendingDispatches', request.dispatch_id);
  if (existing !== undefined) return existing;
  const pending: PendingDispatch = {
    dispatchId: request.dispatch_id,
    request,
    sessionId: session.id,
    farmerName,
    firstSentAt: now,
    state: 'unconfirmed',
    result: null,
    lastError: null,
  };
  await db.put('pendingDispatches', pending);
  return pending;
}

/** Sessions on this tablet that can still talk to the API, the signer's first. */
async function usableSessions(db: AppDb, pending: PendingDispatch, now: number) {
  const usable = (await db.getAll('sessions')).filter(
    (s) => !s.invalid && Date.parse(s.session.expires_at) > now,
  );
  const rank = (s: StoredSession) =>
    s.id === pending.sessionId ? 0 : s.custodian.id === pending.request.custodian_id ? 1 : 2;
  return usable.sort((a, b) => rank(a) - rank(b) || b.signedInAt - a.signedInAt);
}

export type Resolution = PendingDispatch & {
  /** True when no request got any answer: the tablet is probably offline. */
  unreachable: boolean;
};

/**
 * One attempt to settle a pending dispatch; saves and returns the new state.
 * `firstSend`: nothing was sent before, so any refusal means not recorded.
 */
export async function resolvePending(
  db: AppDb,
  api: ApiClient,
  pending: PendingDispatch,
  options: { firstSend?: boolean; now?: number } = {},
): Promise<Resolution> {
  if (pending.state !== 'unconfirmed') return { ...pending, unreachable: false };
  const now = options.now ?? Date.now();
  const sessions = await usableSessions(db, pending, now);
  const save = async (change: Partial<PendingDispatch>, unreachable = false) => {
    const next = { ...pending, ...change };
    await db.put('pendingDispatches', next);
    return { ...next, unreachable };
  };
  const errorOf = (err: HttpError) => ({ code: err.code, message: err.message });

  const sender = sessions[0];
  if (sender === undefined) {
    return save({ lastError: { code: 'session_invalid', message: 'No sign-in on this tablet' } });
  }
  let refusal: HttpError;
  try {
    const { data } = await api<DispatchResponse>('POST', '/dispatches', {
      token: sender.token,
      json: pending.request,
    });
    return await save({ state: 'recorded', result: data.dispatch, lastError: null });
  } catch (err) {
    if (err instanceof NetworkError) return save({}, true);
    if (!(err instanceof HttpError) || err.transient) {
      return save({
        lastError:
          err instanceof HttpError ? errorOf(err) : { code: 'client_error', message: String(err) },
      });
    }
    if (options.firstSend === true || err.status === 400 || PROVES_NOT_RECORDED.has(err.code)) {
      return save({ state: 'not_recorded', lastError: errorOf(err) });
    }
    refusal = err;
  }

  // A refusal that proves nothing about an earlier send: read the dispatch itself.
  for (const session of sessions) {
    try {
      const { data } = await api<DispatchReadResponse>('GET', `/dispatches/${pending.dispatchId}`, {
        token: session.token,
      });
      return await save({ state: 'recorded', result: data.dispatch, lastError: null });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return save({ state: 'not_recorded', lastError: errorOf(refusal) });
      }
      if (err instanceof NetworkError) return save({ lastError: errorOf(refusal) }, true);
      // This sign-in can't read it (ended, say): try the next one.
    }
  }
  return save({ lastError: errorOf(refusal) });
}

/** Background pass, after each sync: every pending dispatch still unconfirmed. */
export async function resolveAllPending(db: AppDb, api: ApiClient): Promise<void> {
  for (const pending of await db.getAll('pendingDispatches')) {
    if (pending.state !== 'unconfirmed') continue;
    const result = await resolvePending(db, api, pending);
    if (result.unreachable) return;
  }
}

/** The custodian has seen the outcome: forget it. */
export async function acknowledgePending(db: AppDb, dispatchId: string): Promise<void> {
  await db.delete('pendingDispatches', dispatchId);
}
