import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpError, NetworkError, type ApiClient } from '../src/api/client';
import { openAppDb, type AppDb, type StoredSession } from '../src/db/schema';
import {
  acknowledgePending,
  resolveAllPending,
  resolvePending,
  savePending,
} from '../src/dispatch/pending';
import type { DispatchRequest, DispatchView } from '../src/types/api';

const NOW = Date.parse('2026-10-10T09:00:00Z');
const WAREHOUSE = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'KN-DAWANAU',
  name: 'Dawanau',
};
const AMINA = {
  id: '22222222-2222-4222-8222-222222222222',
  full_name: 'Amina Sani',
  phone: '+2348000000001',
};
const BALA = {
  id: '55555555-5555-4555-8555-555555555555',
  full_name: 'Bala Umar',
  phone: '+2348000000005',
};

function session(id: string, custodian: typeof AMINA, signedInAt = NOW): StoredSession {
  return {
    id,
    token: `token-${id}`,
    session: { id, expires_at: new Date(NOW + 168 * 3600_000).toISOString() },
    custodian,
    warehouse: WAREHOUSE,
    roster: { verifiers: [] },
    pinCheck: { salt: '', hash: '', iterations: 1 },
    failedUnlocks: 0,
    signedInAt,
    ended: false,
    invalid: false,
  };
}

const request = (): DispatchRequest => ({
  dispatch_id: randomUUID(),
  warehouse_id: WAREHOUSE.id,
  farmer_id: randomUUID(),
  custodian_id: AMINA.id,
  commodity: 'MAIZE_WHITE',
  grade: '1',
  bag_count: 5,
  not_weighed_reason: 'Scale not working',
  farmer_confirmed: true,
  deposit_id: null,
});

const view = (r: DispatchRequest): DispatchView =>
  ({ dispatch_id: r.dispatch_id, delivery_note_no: 'KN-DAWANAU-DN-000001' }) as DispatchView;

type Answer = 'ok' | 'offline' | 'missing' | { status: number; code: string };

/** Scripted answers: `post` for POST /dispatches, `get` for the read; each call takes the next. */
function scriptedApi(script: { post: Answer[]; get?: Answer[] }) {
  const calls: { method: string; path: string; token: string | undefined }[] = [];
  const answer = (a: Answer | undefined, body: () => unknown) => {
    if (a === undefined) throw new Error('unexpected call');
    if (a === 'ok') return Promise.resolve({ status: 200, data: body() });
    if (a === 'offline') return Promise.reject(new NetworkError('offline'));
    if (a === 'missing') {
      return Promise.reject(
        new HttpError(404, { error: { code: 'not_found', message: 'Dispatch not found' } }),
      );
    }
    return Promise.reject(new HttpError(a.status, { error: { code: a.code, message: a.code } }));
  };
  const api = ((method: string, path: string, options?: { token?: string; json?: unknown }) => {
    calls.push({ method, path, token: options?.token });
    if (method === 'POST') {
      return answer(script.post.shift(), () => ({
        dispatch: view(options?.json as DispatchRequest),
      }));
    }
    const id = path.split('/').at(-1) ?? '';
    return answer(script.get?.shift(), () => ({ dispatch: { dispatch_id: id } }));
  }) as ApiClient;
  return { api, calls };
}

describe('pending dispatches', () => {
  let db: AppDb;
  let dbName: string;
  const amina = session('s-amina', AMINA);

  beforeEach(async () => {
    dbName = `test-${randomUUID()}`;
    db = await openAppDb(dbName);
    await db.put('sessions', amina);
  });
  afterEach(() => {
    db.close();
  });

  const pend = async () => savePending(db, request(), amina, 'Musa Bello', NOW);

  it('is saved before the first send, and survives closing the tablet', async () => {
    const pending = await pend();
    db.close();
    db = await openAppDb(dbName);
    expect(await db.get('pendingDispatches', pending.dispatchId)).toMatchObject({
      state: 'unconfirmed',
      farmerName: 'Musa Bello',
      request: pending.request,
    });
  });

  it('first send: an answer records it; any refusal means nothing was recorded', async () => {
    const ok = scriptedApi({ post: ['ok'] });
    expect(
      await resolvePending(db, ok.api, await pend(), { firstSend: true, now: NOW }),
    ).toMatchObject({
      state: 'recorded',
    });
    const refused = scriptedApi({ post: [{ status: 401, code: 'session_invalid' }] });
    expect(
      await resolvePending(db, refused.api, await pend(), { firstSend: true, now: NOW }),
    ).toMatchObject({ state: 'not_recorded', lastError: { code: 'session_invalid' } });
    expect(refused.calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('no answer or a server error: still unconfirmed', async () => {
    const pending = await pend();
    const offline = scriptedApi({ post: ['offline'] });
    expect(await resolvePending(db, offline.api, pending, { now: NOW })).toMatchObject({
      state: 'unconfirmed',
      unreachable: true,
    });
    const busy = scriptedApi({ post: [{ status: 503, code: 'service_unavailable' }] });
    expect(await resolvePending(db, busy.api, pending, { now: NOW })).toMatchObject({
      state: 'unconfirmed',
      unreachable: false,
      lastError: { code: 'service_unavailable' },
    });
  });

  it.each([
    [{ status: 409, code: 'insufficient_balance' }],
    [{ status: 409, code: 'lot_governed_on_chain' }],
    [{ status: 400, code: 'validation_failed' }],
  ])(
    'a refusal that proves no record (%o) settles it as not recorded, without a read',
    async (refusal) => {
      const script = scriptedApi({ post: [refusal] });
      expect(await resolvePending(db, script.api, await pend(), { now: NOW })).toMatchObject({
        state: 'not_recorded',
      });
      expect(script.calls.map((c) => c.method)).toEqual(['POST']);
    },
  );

  it.each([[{ status: 401, code: 'session_invalid' }], [{ status: 403, code: 'actor_mismatch' }]])(
    'any other refusal (%o) is settled by reading the dispatch: 200 recorded',
    async (refusal) => {
      const pending = await pend();
      const script = scriptedApi({ post: [refusal], get: ['ok'] });
      expect(await resolvePending(db, script.api, pending, { now: NOW })).toMatchObject({
        state: 'recorded',
        result: { dispatch_id: pending.dispatchId },
      });
      expect(script.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /dispatches',
        `GET /dispatches/${pending.dispatchId}`,
      ]);
    },
  );

  it('a refusal, then the read says 404: not recorded', async () => {
    const script = scriptedApi({
      post: [{ status: 403, code: 'actor_mismatch' }],
      get: ['missing'],
    });
    expect(await resolvePending(db, script.api, await pend(), { now: NOW })).toMatchObject({
      state: 'not_recorded',
      lastError: { code: 'actor_mismatch' },
    });
  });

  it('a refusal, and the read gets no answer: still unconfirmed', async () => {
    const script = scriptedApi({
      post: [{ status: 401, code: 'session_invalid' }],
      get: ['offline'],
    });
    expect(await resolvePending(db, script.api, await pend(), { now: NOW })).toMatchObject({
      state: 'unconfirmed',
      unreachable: true,
    });
  });

  it('reads with any sign-in on the tablet when the signer’s has ended', async () => {
    const pending = await pend();
    await db.put('sessions', { ...amina, invalid: true });
    await db.put('sessions', session('s-bala', BALA));
    const script = scriptedApi({ post: [{ status: 403, code: 'actor_mismatch' }], get: ['ok'] });
    expect((await resolvePending(db, script.api, pending, { now: NOW })).state).toBe('recorded');
    expect(script.calls.every((c) => c.token === 'token-s-bala')).toBe(true);
  });

  it('sends with the signer’s own sign-in first, else the same custodian’s newest', async () => {
    const pending = await pend();
    await db.put('sessions', session('s-bala', BALA, NOW + 10));
    const first = scriptedApi({ post: ['offline'] });
    await resolvePending(db, first.api, pending, { now: NOW });
    expect(first.calls[0]?.token).toBe('token-s-amina');

    await db.put('sessions', { ...amina, invalid: true });
    await db.put('sessions', session('s-amina-2', AMINA, NOW + 5));
    const second = scriptedApi({ post: ['ok'] });
    await resolvePending(db, second.api, pending, { now: NOW });
    expect(second.calls[0]?.token).toBe('token-s-amina-2');
  });

  it('settles in the background, and is forgotten once acknowledged', async () => {
    const a = await pend();
    const b = await pend();
    const script = scriptedApi({ post: ['ok', 'ok'] });
    await resolveAllPending(db, script.api);
    expect((await db.getAll('pendingDispatches')).map((p) => p.state)).toEqual([
      'recorded',
      'recorded',
    ]);
    await acknowledgePending(db, a.dispatchId);
    expect((await db.getAll('pendingDispatches')).map((p) => p.dispatchId)).toEqual([b.dispatchId]);
  });

  it('stops the background pass at the first sign of no signal', async () => {
    await pend();
    await pend();
    const script = scriptedApi({ post: ['offline'] });
    await resolveAllPending(db, script.api);
    expect(script.calls).toHaveLength(1);
  });
});
