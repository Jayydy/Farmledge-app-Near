import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMeta, openAppDb, setMeta, type AppDb, type StoredSession } from '../src/db/schema';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffMs } from '../src/sync/backoff';
import { recordBlockedDispatch } from '../src/dispatch/blocked';
import { saveCapture, type Capture } from '../src/sync/capture';
import { DONE_RETENTION_MS, SyncEngine, type Lock } from '../src/sync/engine';
import { FakeApi } from './fakeApi';

const WAREHOUSE = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'KN-DAWANAU',
  name: 'Dawanau',
};
const CUSTODIAN = { id: '22222222-2222-4222-8222-222222222222', full_name: 'Amina Sani' };
const VERIFIER = { id: '33333333-3333-4333-8333-333333333333', full_name: 'Bala Musa' };
const START = Date.parse('2026-10-07T09:00:00Z');

function session(id: string, token: string, signedInAt = START): StoredSession {
  return {
    id,
    token,
    session: { id, expires_at: new Date(START + 168 * 3600_000).toISOString() },
    custodian: { ...CUSTODIAN, phone: '+2348000000001' },
    warehouse: WAREHOUSE,
    roster: { verifiers: [VERIFIER] },
    pinCheck: { salt: '', hash: '', iterations: 1 },
    failedUnlocks: 0,
    signedInAt,
    ended: false,
    invalid: false,
  };
}

function capture(overrides: Partial<Capture> = {}): Capture {
  return {
    depositId: randomUUID(),
    capturedAt: new Date(START),
    session: { id: 'session-a', custodian: CUSTODIAN, warehouse: WAREHOUSE },
    verifier: VERIFIER,
    farmer: { kind: 'known', id: randomUUID(), full_name: 'Musa Bello', phone: '+2348031234567' },
    commodity: 'MAIZE_WHITE',
    grade: '1',
    moisturePct: 12.5,
    bagCount: 20,
    confirmBagCount: false,
    sample: null,
    photos: [],
    ...overrides,
  };
}

const photo = (byte: number) => ({
  photoId: randomUUID(),
  blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, byte])], { type: 'image/jpeg' }),
  contentType: 'image/jpeg',
  sha256: String(byte).padStart(64, '0'),
});

describe('sync queue', () => {
  let db: AppDb;
  let dbName: string;
  let api: FakeApi;
  let now: number;
  const engine = (lock?: Lock) =>
    new SyncEngine({
      db,
      api: api.client,
      now: () => now,
      random: () => 0.5,
      ...(lock === undefined ? {} : { lock }),
    });
  const statuses = async () =>
    (await db.getAll('outbox')).map((item) => `${item.kind}:${item.status}`).sort();

  beforeEach(async () => {
    dbName = `test-${randomUUID()}`;
    db = await openAppDb(dbName);
    api = new FakeApi();
    now = START;
    await db.put('sessions', session('session-a', 'token-a'));
  });

  afterEach(() => {
    db.close();
  });

  it('sends a whole intake in dependency order: farmer, deposit, then sample and photos', async () => {
    const local = await saveCapture(
      db,
      capture({
        farmer: {
          kind: 'new',
          localFarmerId: randomUUID(),
          full_name: 'Hauwa Ali',
          phone: '+2348039990000',
          consent: true,
          lookupConsent: false,
        },
        sample: { sampleId: randomUUID(), bagsWeighed: 2, totalKg: 198.4 },
        photos: [photo(1), photo(2)],
      }),
      now,
    );

    const report = await engine().run();

    expect(report).toMatchObject({ ran: true, sent: 5, failed: 0, unreachable: false });
    expect(api.log.map((r) => r.path.replace(/\?.*/, '').replace(local.deposit_id, ':id'))).toEqual(
      [
        '/farmers',
        '/deposits/batch',
        '/deposits/:id/scale-samples',
        '/deposits/:id/photos',
        '/deposits/:id/photos',
        '/deposits/:id/slip',
      ],
    );
    const farmerId = api.farmers.get('+2348039990000')?.id;
    expect(api.deposits.get(local.deposit_id)?.farmer_id).toBe(farmerId);
    expect(await statuses()).toEqual([
      'deposit:done',
      'farmer:done',
      'photo:done',
      'photo:done',
      'sample:done',
    ]);
    expect(await db.count('photoBlobs')).toBe(0);
    const cached = await db.get('farmers', '+2348039990000');
    expect(cached).toMatchObject({ id: farmerId, localFarmerId: null });
    expect(await db.get('deposits', local.deposit_id)).toMatchObject({
      server: { deposit_no: 1 },
      slip: { qr_payload: '{"deposit_no":1}' },
    });
  });

  describe('retry and backoff', () => {
    it('backs off exponentially with jitter, capped at 10 minutes', () => {
      expect(backoffMs(1, () => 0)).toBe(BACKOFF_BASE_MS / 2);
      expect(backoffMs(1, () => 1)).toBe(BACKOFF_BASE_MS);
      expect(backoffMs(2, () => 1)).toBe(BACKOFF_BASE_MS * 2);
      expect(backoffMs(4, () => 1)).toBe(BACKOFF_BASE_MS * 8);
      expect(backoffMs(30, () => 1)).toBe(BACKOFF_CAP_MS);
      expect(backoffMs(30, () => 0)).toBe(BACKOFF_CAP_MS / 2);
    });

    it('keeps everything while offline, waits out the backoff, then sends', async () => {
      const { deposit_id } = await saveCapture(db, capture({ photos: [photo(1)] }), now);
      api.offline = true;

      expect(await engine().run()).toMatchObject({ sent: 0, unreachable: true });
      const [deposit] = (await db.getAll('outbox')).filter((i) => i.kind === 'deposit');
      expect(deposit).toMatchObject({
        status: 'pending',
        attempts: 1,
        nextAttemptAt: START + backoffMs(1, () => 0.5),
        lastError: { kind: 'network' },
      });

      // Back online, but the backoff hasn't passed: nothing is sent.
      api.offline = false;
      const before = api.log.length;
      await engine().run();
      expect(api.log.length).toBe(before);

      now += backoffMs(1, () => 0.5);
      expect(await engine().run()).toMatchObject({ sent: 2 });
      expect(api.deposits.has(deposit_id)).toBe(true);
    });

    it('grows the wait with each failed attempt', async () => {
      await saveCapture(db, capture(), now);
      api.offline = true;
      const waits: number[] = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        await engine().run();
        const [item] = await db.getAll('outbox');
        waits.push((item?.nextAttemptAt ?? 0) - now);
        now = item?.nextAttemptAt ?? now;
      }
      expect(waits).toEqual([1, 2, 3, 4].map((n) => backoffMs(n, () => 0.5)));
    });

    it('retries server errors with backoff but leaves rejections for a person', async () => {
      const bad = await saveCapture(db, capture(), now);
      const good = await saveCapture(db, capture(), now);
      api.rejectDeposits.add(bad.deposit_id);
      api.failNext('/deposits/batch', { kind: 'status', status: 503, code: 'service_unavailable' });

      await engine().run();
      expect(await statuses()).toEqual(['deposit:pending', 'deposit:pending']);

      now += BACKOFF_CAP_MS;
      await engine().run();
      expect(api.deposits.has(good.deposit_id)).toBe(true);
      const failed = (await db.getAll('outbox')).find((i) => i.depositId === bad.deposit_id);
      expect(failed).toMatchObject({
        status: 'failed',
        lastError: { kind: 'rejected', code: 'validation_failed' },
      });

      // Failed items are not retried on their own...
      now += BACKOFF_CAP_MS;
      const before = api.requestsTo('/deposits/batch').length;
      await engine().run();
      expect(api.requestsTo('/deposits/batch').length).toBe(before);

      // ...only by a manual retry, which sends the same item, not a copy.
      api.rejectDeposits.clear();
      await engine().retry([failed?.opId ?? '']);
      await engine().run();
      expect(api.deposits.has(bad.deposit_id)).toBe(true);
      expect(await db.count('outbox')).toBe(2);
    });
  });

  describe('never duplicates', () => {
    it('records a deposit once when the answer is lost after the server saved it', async () => {
      const { deposit_id } = await saveCapture(db, capture({ photos: [photo(7)] }), now);
      api.failNext('/deposits/batch', { kind: 'lost_response' });
      api.failNext(`/deposits/${deposit_id}/photos`, { kind: 'lost_response' });

      await engine().run();
      now += BACKOFF_CAP_MS;
      await engine().run();
      now += BACKOFF_CAP_MS;
      await engine().run();

      expect(api.requestsTo('/deposits/batch')).toHaveLength(2);
      expect(api.deposits.size).toBe(1);
      expect(api.photos.get(deposit_id)?.size).toBe(1);
      expect(await statuses()).toEqual(['deposit:done', 'photo:done']);
    });

    it('treats an already-registered farmer as success and uses their id', async () => {
      api.farmers.set('+2348039990000', {
        id: 'existing-farmer',
        request: {} as never,
      });
      const { deposit_id } = await saveCapture(
        db,
        capture({
          farmer: {
            kind: 'new',
            localFarmerId: randomUUID(),
            full_name: 'Hauwa Ali',
            phone: '+2348039990000',
            consent: true,
            lookupConsent: false,
          },
        }),
        now,
      );
      await engine().run();
      expect(api.deposits.get(deposit_id)?.farmer_id).toBe('existing-farmer');
      expect(await statuses()).toEqual(['deposit:done', 'farmer:done']);
    });

    it('registers a farmer once for two deposits captured before it synced', async () => {
      const localFarmerId = randomUUID();
      const farmer = { full_name: 'Hauwa Ali', phone: '+2348039990000' };
      const first = await saveCapture(
        db,
        capture({
          farmer: { kind: 'new', localFarmerId, ...farmer, consent: true, lookupConsent: false },
        }),
        now,
      );
      const second = await saveCapture(
        db,
        capture({ farmer: { kind: 'queued', localFarmerId, ...farmer } }),
        now,
      );

      await engine().run();

      expect(api.requestsTo('/farmers')).toHaveLength(1);
      const id = api.farmers.get(farmer.phone)?.id;
      expect(api.deposits.get(first.deposit_id)?.farmer_id).toBe(id);
      expect(api.deposits.get(second.deposit_id)?.farmer_id).toBe(id);
    });

    it('lets only one of two concurrent syncs send', async () => {
      await saveCapture(db, capture(), now);
      let held = false;
      const shared: Lock = async (fn) => {
        if (held) return undefined;
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      };
      const [a, b] = await Promise.all([engine(shared).run(), engine(shared).run()]);
      expect([a.ran, b.ran].sort()).toEqual([false, true]);
      expect(api.requestsTo('/deposits/batch')).toHaveLength(1);
    });

    it('refuses to save the same deposit_id twice, leaving nothing half-written', async () => {
      const first = capture();
      await saveCapture(db, first, now);
      const before = await db.count('outbox');
      await expect(saveCapture(db, { ...first, photos: [photo(3)] }, now)).rejects.toThrow(
        /already saved/,
      );
      expect(await db.count('outbox')).toBe(before);
      expect(await db.count('photoBlobs')).toBe(0);
    });

    it('sends 150 queued deposits in batches of at most 100', async () => {
      for (let i = 0; i < 150; i++) await saveCapture(db, capture(), now);
      await engine().run();
      const sizes = api
        .requestsTo('/deposits/batch')
        .map((r) => (r.json as { items: unknown[] }).items.length);
      expect(sizes).toEqual([100, 50]);
      expect(api.deposits.size).toBe(150);
    });
  });

  describe('survives the tablet being closed', () => {
    it('keeps the queue across a close and reopen', async () => {
      const { deposit_id } = await saveCapture(db, capture({ photos: [photo(1)] }), now);
      db.close();

      db = await openAppDb(dbName);
      expect(await statuses()).toEqual(['deposit:pending', 'photo:pending']);
      expect(await db.count('photoBlobs')).toBe(1);
      await engine().run();
      expect(api.deposits.has(deposit_id)).toBe(true);
      expect(api.photos.get(deposit_id)?.size).toBe(1);
    });

    it('resends an item that was mid-send when the tablet closed, exactly once on the server', async () => {
      const { deposit_id } = await saveCapture(db, capture(), now);
      const [item] = await db.getAll('outbox');
      if (item?.kind !== 'deposit') throw new Error('expected the deposit');
      // Marked sending, the server saved it, then the tab died before the answer was written down.
      await db.put('outbox', { ...item, status: 'sending' });
      await api.client('POST', '/deposits/batch', {
        token: 'token-a',
        json: { items: [item.payload.request] },
      });
      db.close();

      db = await openAppDb(dbName);
      await engine().run();
      expect(api.deposits.size).toBe(1);
      expect(await statuses()).toEqual(['deposit:done']);
      expect(await db.get('deposits', deposit_id)).toMatchObject({ server: { deposit_no: 1 } });
    });
  });

  describe('sessions', () => {
    it('waits for the custodian to sign in again when the session is refused, without using up attempts', async () => {
      await saveCapture(db, capture(), now);
      api.validTokens.clear();

      await engine().run();
      const [item] = await db.getAll('outbox');
      expect(item).toMatchObject({
        status: 'pending',
        attempts: 0,
        lastError: { kind: 'needs_sign_in' },
      });
      expect((await db.get('sessions', 'session-a'))?.invalid).toBe(true);

      // The same custodian signs in again: their new session sends it.
      api.validTokens.add('token-b');
      await db.put('sessions', session('session-b', 'token-b', START + 1000));
      await engine().run();
      expect(api.deposits.size).toBe(1);
      expect(api.requestsTo('/deposits/batch').at(-1)?.token).toBe('token-b');
    });
  });

  describe('retention', () => {
    it('drops done items after 14 days but never pending or failed ones', async () => {
      const done = await saveCapture(db, capture(), now);
      const failed = await saveCapture(db, capture(), now);
      api.rejectDeposits.add(failed.deposit_id);
      await engine().run();
      const pending = await saveCapture(db, capture(), now);
      api.offline = true;

      now += DONE_RETENTION_MS + 1;
      await engine().run();

      const left = (await db.getAll('outbox')).map((i) => i.depositId).sort();
      expect(left).toEqual([failed.deposit_id, pending.deposit_id].sort());
      expect(await db.get('deposits', done.deposit_id)).toBeUndefined();
      expect(await db.get('deposits', failed.deposit_id)).toBeDefined();
    });
  });

  describe('blocked dispatches (D54)', () => {
    it('sends each one once, with only when, who and how long offline', async () => {
      await setMeta(db, 'lastOnlineAt', START - 3 * 3600_000);
      const sessionA = await db.get('sessions', 'session-a');
      if (sessionA === undefined) throw new Error('no session');
      expect(await recordBlockedDispatch(db, sessionA, START)).toBe(1);
      expect(await recordBlockedDispatch(db, sessionA, START + 60_000)).toBe(2);
      expect(await getMeta(db, 'blockedDispatchCount')).toBe(2);

      now = START + 60_000;
      await engine().run();
      expect(await statuses()).toEqual(['dispatchBlocked:done', 'dispatchBlocked:done']);
      const sent = api.requestsTo(`/warehouses/${WAREHOUSE.id}/dispatch-blocked`);
      expect(sent).toHaveLength(2);
      expect(Object.keys(sent[0]?.json as object).sort()).toEqual([
        'blocked_at',
        'custodian_id',
        'id',
        'offline_since',
      ]);
      const first = sent
        .map((r) => r.json as { blocked_at: string })
        .find((json) => json.blocked_at === new Date(START).toISOString());
      expect(first).toMatchObject({
        custodian_id: CUSTODIAN.id,
        offline_since: new Date(START - 3 * 3600_000).toISOString(),
      });
      expect(api.blocked.size).toBe(2);
    });

    it('says null for offline_since when the tablet has never reached the API', async () => {
      const sessionA = await db.get('sessions', 'session-a');
      if (sessionA === undefined) throw new Error('no session');
      await recordBlockedDispatch(db, sessionA, START);
      await engine().run();
      expect([...api.blocked.values()][0]?.offline_since).toBeNull();
    });

    it('lands exactly once when the answer is lost and it is sent again', async () => {
      const sessionA = await db.get('sessions', 'session-a');
      if (sessionA === undefined) throw new Error('no session');
      await recordBlockedDispatch(db, sessionA, START);
      api.failNext('/warehouses/', { kind: 'lost_response' });
      await engine().run();
      expect(await statuses()).toEqual(['dispatchBlocked:pending']);
      now += BACKOFF_CAP_MS;
      await engine().run();
      expect(await statuses()).toEqual(['dispatchBlocked:done']);
      expect(api.requestsTo('/warehouses/')).toHaveLength(2);
      expect(api.blocked.size).toBe(1);
    });
  });
});
