import { HttpError, NetworkError, type ApiClient } from '../api/client';
import type {
  AppDb,
  DepositOp,
  DispatchBlockedOp,
  FarmerOp,
  OutboxError,
  OutboxItem,
  PhotoOp,
  SampleOp,
  StoredSession,
} from '../db/schema';
import {
  MAX_BATCH_ITEMS,
  type BatchResponse,
  type DepositRequest,
  type DepositSlip,
  type FarmerAlreadyRegisteredDetails,
  type RegisterFarmerResponse,
} from '../types/api';
import { backoffMs } from './backoff';

/** Done items (and their local deposit records) are kept this long, for reprints. */
export const DONE_RETENTION_MS = 14 * 24 * 3600_000;

export type Lock = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export interface SyncDeps {
  db: AppDb;
  api: ApiClient;
  now?: () => number;
  random?: () => number;
  /**
   * Runs `fn` unless another sync holds the lock (then resolves undefined).
   * Defaults to the Web Locks API across tabs, else an in-process flag.
   */
  lock?: Lock;
  /** Called after every change to the outbox, so the UI can refresh. */
  onChange?: () => void;
}

export interface SyncReport {
  /** False when another sync was already running. */
  ran: boolean;
  sent: number;
  failed: number;
  /** True when a request got no answer: the tablet is effectively offline. */
  unreachable: boolean;
}

/**
 * Order of sending: a deposit needs its farmer; samples and photos need
 * their deposit. Blocked-dispatch records depend on nothing; they go last.
 */
const KIND_ORDER = ['farmer', 'deposit', 'sample', 'photo', 'dispatchBlocked'] as const;

/**
 * The sync queue. Every state change is written to IndexedDB before and
 * after each request, so closing the tablet at any moment loses nothing:
 * an item caught mid-send is `sending`, goes back to `pending` on the next
 * run, and is sent again. That is safe because every request is idempotent
 * on a key the tablet chose (deposit_id, sample_id, photo SHA-256) or
 * resolves to the same record (a farmer's phone: 409 farmer_already_registered
 * carries the existing id). So nothing is lost and nothing is recorded twice.
 */
export class SyncEngine {
  private readonly db: AppDb;
  private readonly api: ApiClient;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lock: Lock;
  private readonly onChange: () => void;

  constructor(deps: SyncDeps) {
    this.db = deps.db;
    this.api = deps.api;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.lock = deps.lock ?? defaultLock();
    this.onChange = deps.onChange ?? (() => undefined);
  }

  /** One sync: sends everything that is due, in dependency order. */
  async run(): Promise<SyncReport> {
    const report = await this.lock(async () => {
      const totals: SyncReport = { ran: true, sent: 0, failed: 0, unreachable: false };
      await this.recoverInterrupted();
      // A farmer registered this run unblocks its deposit in the next round.
      for (let round = 0; round < KIND_ORDER.length + 1; round++) {
        const progress = await this.round();
        totals.sent += progress.sent;
        totals.failed += progress.failed;
        if (progress.unreachable) {
          totals.unreachable = true;
          break;
        }
        if (progress.sent === 0) break;
      }
      if (!totals.unreachable) await this.fetchSlips();
      await this.prune();
      return totals;
    });
    return report ?? { ran: false, sent: 0, failed: 0, unreachable: false };
  }

  /**
   * Puts failed items (or the given ones) back in the queue to be sent now,
   * and clears any backoff wait. Never creates a new item, so a retry can't
   * duplicate anything.
   */
  async retry(opIds?: readonly string[]): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    const items =
      opIds === undefined
        ? await tx.store.getAll()
        : await Promise.all(opIds.map((id) => tx.store.get(id)));
    for (const item of items) {
      if (item === undefined || item.status === 'done' || item.status === 'sending') continue;
      await tx.store.put({ ...item, status: 'pending', attempts: 0, nextAttemptAt: this.now() });
    }
    await tx.done;
    this.onChange();
  }

  /** Items left `sending` by a closed tab or a crash go back to `pending`. Only safe under the lock. */
  private async recoverInterrupted(): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    const stuck = await tx.store.index('status').getAll('sending');
    for (const item of stuck) await tx.store.put({ ...item, status: 'pending' });
    await tx.done;
    if (stuck.length > 0) this.onChange();
  }

  private async round(): Promise<{ sent: number; failed: number; unreachable: boolean }> {
    const all = await this.db.getAll('outbox');
    const byId = new Map(all.map((item) => [item.opId, item]));
    const now = this.now();
    const ready = all.filter(
      (item) =>
        item.status === 'pending' &&
        item.nextAttemptAt <= now &&
        item.dependsOn.every((id) => byId.get(id)?.status === 'done'),
    );
    const progress = { sent: 0, failed: 0, unreachable: false };

    for (const kind of KIND_ORDER) {
      const group = ready.filter((item) => item.kind === kind);
      if (kind === 'deposit') {
        await this.sendDeposits(group as DepositOp[], byId, progress);
      } else {
        for (const item of group) {
          if (progress.unreachable) break;
          if (item.kind !== 'deposit') await this.sendOne(item, progress);
        }
      }
      if (progress.unreachable) break;
    }
    return progress;
  }

  // ---- Sessions ----------------------------------------------------------

  /** The session to send an item with: its own, else the capturer's newest valid one. */
  private async senderFor(item: OutboxItem): Promise<StoredSession | null> {
    const now = this.now();
    const usable = (s: StoredSession | undefined): s is StoredSession =>
      s !== undefined && !s.invalid && Date.parse(s.session.expires_at) > now;
    const own = await this.db.get('sessions', item.sessionId);
    if (usable(own)) return own;
    const theirs = (await this.db.getAll('sessions'))
      .filter((s) => s.custodian.id === item.custodianId && usable(s))
      .sort((a, b) => b.signedInAt - a.signedInAt);
    return theirs[0] ?? null;
  }

  private async markSessionInvalid(sessionId: string): Promise<void> {
    const session = await this.db.get('sessions', sessionId);
    if (session !== undefined) await this.db.put('sessions', { ...session, invalid: true });
  }

  // ---- Sending ------------------------------------------------------------

  private async sendOne(
    item: FarmerOp | SampleOp | PhotoOp | DispatchBlockedOp,
    progress: { sent: number; failed: number; unreachable: boolean },
  ): Promise<void> {
    const sender = await this.senderFor(item);
    if (sender === null) {
      await this.needsSignIn([item]);
      return;
    }
    const sending = await this.markSending([item]);
    if (sending.length === 0) return;
    try {
      if (item.kind === 'farmer') {
        const farmerId = await this.registerFarmer(item, sender);
        await this.completeFarmer(item, farmerId);
      } else if (item.kind === 'dispatchBlocked') {
        await this.api('POST', `/warehouses/${item.payload.warehouseId}/dispatch-blocked`, {
          token: sender.token,
          json: item.payload.request,
        });
        await this.complete(item);
      } else if (item.kind === 'sample') {
        await this.api('POST', `/deposits/${item.payload.depositId}/scale-samples`, {
          token: sender.token,
          json: item.payload.request,
        });
        await this.complete(item);
      } else {
        const stored = await this.db.get('photoBlobs', item.payload.photoId);
        if (stored === undefined) {
          await this.fail(item, {
            kind: 'rejected',
            code: 'photo_missing',
            message: 'The photo is no longer on this tablet',
          });
          progress.failed++;
          return;
        }
        const query = `uploaded_by=${encodeURIComponent(item.payload.uploadedBy)}`;
        await this.api('POST', `/deposits/${item.payload.depositId}/photos?${query}`, {
          token: sender.token,
          body: stored.blob,
          contentType: item.payload.contentType,
        });
        await this.complete(item);
      }
      progress.sent++;
    } catch (err) {
      const outcome = await this.handleError([item], sender, err);
      if (outcome === 'unreachable') progress.unreachable = true;
      if (outcome === 'failed') progress.failed++;
    }
  }

  /** 201 → new farmer; 409 farmer_already_registered → the existing one. Both are success. */
  private async registerFarmer(item: FarmerOp, sender: StoredSession): Promise<string> {
    try {
      const { data } = await this.api<RegisterFarmerResponse>('POST', '/farmers', {
        token: sender.token,
        json: item.payload.request,
      });
      return data.farmer.id;
    } catch (err) {
      if (err instanceof HttpError && err.code === 'farmer_already_registered') {
        const details = err.details as Partial<FarmerAlreadyRegisteredDetails> | undefined;
        if (typeof details?.farmer_id === 'string') return details.farmer_id;
      }
      throw err;
    }
  }

  /** Deposits go through /deposits/batch, up to 100 per request, per sending session. */
  private async sendDeposits(
    items: DepositOp[],
    byId: Map<string, OutboxItem>,
    progress: { sent: number; failed: number; unreachable: boolean },
  ): Promise<void> {
    const bySender = new Map<string, { sender: StoredSession; items: DepositOp[] }>();
    for (const item of items) {
      const sender = await this.senderFor(item);
      if (sender === null) {
        await this.needsSignIn([item]);
        continue;
      }
      const group = bySender.get(sender.id) ?? { sender, items: [] };
      group.items.push(item);
      bySender.set(sender.id, group);
    }

    for (const { sender, items: group } of bySender.values()) {
      for (let start = 0; start < group.length; start += MAX_BATCH_ITEMS) {
        if (progress.unreachable) return;
        const chunk = await this.markSending(group.slice(start, start + MAX_BATCH_ITEMS));
        if (chunk.length === 0) continue;
        try {
          const requests = chunk.map((item) => depositRequest(item, byId));
          const { data } = await this.api<BatchResponse>('POST', '/deposits/batch', {
            token: sender.token,
            json: { items: requests },
          });
          for (const [index, item] of chunk.entries()) {
            const result = data.results.find((r) => r.index === index);
            if (result === undefined) {
              await this.retryLater(item, {
                kind: 'server',
                code: 'missing_result',
                message: 'The server did not answer for this deposit',
              });
            } else if (result.status === 'rejected') {
              await this.fail(item, { kind: 'rejected', status: 400, ...result.error });
              progress.failed++;
            } else {
              await this.completeDeposit(
                item,
                result.deposit.deposit_no,
                result.deposit.needs_review,
              );
              progress.sent++;
            }
          }
        } catch (err) {
          const outcome = await this.handleError(chunk, sender, err);
          if (outcome === 'unreachable') progress.unreachable = true;
          if (outcome === 'failed') progress.failed += chunk.length;
        }
      }
    }
  }

  // ---- State changes (each its own transaction, written before moving on) ----

  /** Claims items for sending. Returns those still pending (another tab may have taken some). */
  private async markSending<T extends OutboxItem>(items: T[]): Promise<T[]> {
    const tx = this.db.transaction('outbox', 'readwrite');
    const claimed: T[] = [];
    for (const item of items) {
      const current = await tx.store.get(item.opId);
      if (current?.status !== 'pending') continue;
      await tx.store.put({ ...current, status: 'sending' });
      claimed.push(current as T);
    }
    await tx.done;
    this.onChange();
    return claimed;
  }

  private async complete(item: OutboxItem): Promise<void> {
    const tx = this.db.transaction(['outbox', 'photoBlobs'], 'readwrite');
    const current = await tx.objectStore('outbox').get(item.opId);
    if (current !== undefined) {
      await tx.objectStore('outbox').put({
        ...current,
        status: 'done',
        lastError: null,
        doneAt: this.now(),
      });
    }
    if (item.kind === 'photo') await tx.objectStore('photoBlobs').delete(item.payload.photoId);
    await tx.done;
    this.onChange();
  }

  /** Records the server's farmer id on the op, in the cache, and in the deposits waiting on it. */
  private async completeFarmer(item: FarmerOp, farmerId: string): Promise<void> {
    const tx = this.db.transaction(['outbox', 'farmers'], 'readwrite');
    const outbox = tx.objectStore('outbox');
    const current = await outbox.get(item.opId);
    if (current?.kind === 'farmer') {
      await outbox.put({
        ...current,
        status: 'done',
        lastError: null,
        doneAt: this.now(),
        result: { farmerId },
      });
    }
    for (const op of await outbox.getAll()) {
      if (
        op.kind === 'deposit' &&
        op.payload.farmerOpId === item.opId &&
        op.payload.request.farmer_id === null
      ) {
        await outbox.put({
          ...op,
          payload: { ...op.payload, request: { ...op.payload.request, farmer_id: farmerId } },
        });
      }
    }
    const farmers = tx.objectStore('farmers');
    const cached = await farmers.index('localFarmerId').get(item.payload.localFarmerId);
    if (cached !== undefined) {
      await farmers.put({ ...cached, id: farmerId, localFarmerId: null, confirmedAt: this.now() });
    }
    await tx.done;
    this.onChange();
  }

  private async completeDeposit(
    item: DepositOp,
    depositNo: number,
    needsReview: boolean,
  ): Promise<void> {
    const tx = this.db.transaction(['outbox', 'deposits'], 'readwrite');
    const current = await tx.objectStore('outbox').get(item.opId);
    if (current?.kind === 'deposit') {
      await tx.objectStore('outbox').put({
        ...current,
        status: 'done',
        lastError: null,
        doneAt: this.now(),
        result: { depositNo, needsReview },
      });
    }
    const local = await tx.objectStore('deposits').get(item.payload.request.deposit_id);
    if (local !== undefined) {
      await tx
        .objectStore('deposits')
        .put({ ...local, server: { deposit_no: depositNo, needs_review: needsReview } });
    }
    await tx.done;
    this.onChange();
  }

  private async fail(item: OutboxItem, error: OutboxError): Promise<void> {
    await this.update(item.opId, (current) => ({ ...current, status: 'failed', lastError: error }));
  }

  /** Back to pending with the next backoff delay. */
  private async retryLater(item: OutboxItem, error: OutboxError): Promise<void> {
    await this.update(item.opId, (current) => {
      const attempts = current.attempts + 1;
      return {
        ...current,
        status: 'pending',
        attempts,
        nextAttemptAt: this.now() + backoffMs(attempts, this.random),
        lastError: error,
      };
    });
  }

  /** Waits, without counting an attempt, until the capturing custodian signs in again. */
  private async needsSignIn(items: OutboxItem[]): Promise<void> {
    for (const item of items) {
      await this.update(item.opId, (current) => ({
        ...current,
        status: 'pending',
        lastError: {
          kind: 'needs_sign_in',
          code: 'needs_sign_in',
          message: 'Waiting for the custodian who recorded this to sign in',
        },
      }));
    }
  }

  private async update(opId: string, change: (item: OutboxItem) => OutboxItem): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    const current = await tx.store.get(opId);
    if (current !== undefined) await tx.store.put(change(current));
    await tx.done;
    this.onChange();
  }

  /**
   * no answer / 5xx / 429 → retry with backoff; 401 → that session is dead,
   * wait for a sign-in; any other 4xx → failed, for a person to look at.
   */
  private async handleError(
    items: OutboxItem[],
    sender: StoredSession,
    err: unknown,
  ): Promise<'unreachable' | 'retry' | 'failed' | 'sign_in'> {
    if (err instanceof NetworkError) {
      for (const item of items) {
        await this.retryLater(item, { kind: 'network', code: 'unreachable', message: err.message });
      }
      return 'unreachable';
    }
    if (err instanceof HttpError && err.status === 401) {
      await this.markSessionInvalid(sender.id);
      await this.needsSignIn(items);
      return 'sign_in';
    }
    if (err instanceof HttpError && err.transient) {
      for (const item of items) {
        await this.retryLater(item, {
          kind: 'server',
          status: err.status,
          code: err.code,
          message: err.message,
        });
      }
      return 'retry';
    }
    if (err instanceof HttpError) {
      for (const item of items) {
        await this.fail(item, {
          kind: 'rejected',
          status: err.status,
          code: err.code,
          message: err.message,
          details: err.details,
        });
      }
      return 'failed';
    }
    // A bug on the tablet, not the network: keep the item, retry with backoff.
    for (const item of items) {
      await this.retryLater(item, {
        kind: 'server',
        code: 'client_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return 'retry';
  }

  // ---- After sync ------------------------------------------------------------

  /** Best effort: the slip's proof data (leaf and salt) for deposits now on the server. */
  private async fetchSlips(): Promise<void> {
    const waiting = (await this.db.getAll('deposits')).filter(
      (d) => d.server !== null && d.slip === null,
    );
    if (waiting.length === 0) return;
    const now = this.now();
    const session = (await this.db.getAll('sessions'))
      .filter((s) => !s.invalid && Date.parse(s.session.expires_at) > now)
      .sort((a, b) => b.signedInAt - a.signedInAt)[0];
    if (session === undefined) return;
    for (const local of waiting) {
      try {
        const { data } = await this.api<DepositSlip>('GET', `/deposits/${local.deposit_id}/slip`, {
          token: session.token,
        });
        const proof = data.proofs[0];
        if (proof === undefined) continue;
        const current = await this.db.get('deposits', local.deposit_id);
        if (current === undefined) continue;
        await this.db.put('deposits', {
          ...current,
          slip: { qr_payload: proof.qr_payload, anchored: proof.anchored },
        });
        this.onChange();
      } catch {
        return; // Next sync tries again.
      }
    }
  }

  /**
   * Drops done items past retention, and a deposit's local record once none
   * of its items remain. Pending and failed items are never touched, and a
   * done item stays while anything left depends on it.
   */
  private async prune(): Promise<void> {
    const cutoff = this.now() - DONE_RETENTION_MS;
    const tx = this.db.transaction(['outbox', 'deposits'], 'readwrite');
    const all = await tx.objectStore('outbox').getAll();
    const expired = (item: OutboxItem) => item.status === 'done' && (item.doneAt ?? 0) < cutoff;
    const needed = new Set(all.filter((item) => !expired(item)).flatMap((item) => item.dependsOn));
    const removed = all.filter((item) => expired(item) && !needed.has(item.opId));
    for (const item of removed) await tx.objectStore('outbox').delete(item.opId);
    const removedIds = new Set(removed.map((item) => item.opId));
    const kept = new Set(
      all.filter((item) => !removedIds.has(item.opId)).map((item) => item.depositId),
    );
    for (const item of removed) {
      if (item.depositId !== null && !kept.has(item.depositId)) {
        await tx.objectStore('deposits').delete(item.depositId);
      }
    }
    await tx.done;
  }
}

function depositRequest(item: DepositOp, byId: Map<string, OutboxItem>): DepositRequest {
  let farmerId = item.payload.request.farmer_id;
  if (farmerId === null && item.payload.farmerOpId !== null) {
    const farmerOp = byId.get(item.payload.farmerOpId);
    farmerId = farmerOp?.kind === 'farmer' ? (farmerOp.result?.farmerId ?? null) : null;
  }
  if (farmerId === null)
    throw new Error(`deposit ${item.payload.request.deposit_id} has no farmer id yet`);
  return { ...item.payload.request, farmer_id: farmerId };
}

/** Web Locks across tabs when available; otherwise one sync at a time in this tab. */
function defaultLock(): Lock {
  const locks: LockManager | undefined = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks !== undefined) {
    return (fn) =>
      locks.request('farmledge-sync', { ifAvailable: true }, (lock) =>
        lock === null ? undefined : fn(),
      );
  }
  let busy = false;
  return async (fn) => {
    if (busy) return undefined;
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
}
