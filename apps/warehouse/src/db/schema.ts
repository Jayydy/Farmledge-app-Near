import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type {
  AuditView,
  Commodity,
  DepositRequest,
  DispatchBlockedRequest,
  DispatchRequest,
  DispatchView,
  Features,
  RegisterFarmerRequest,
  ScaleSampleRequest,
  SessionView,
} from '../types/api';

/**
 * Everything the tablet keeps, in one IndexedDB database. See README
 * "Offline storage" for the design.
 *
 * - `outbox`      every write waiting for (or done with) the API; the sync
 *                 queue. Only ever cleared of `done` items past retention.
 * - `photoBlobs`  photo bytes, until their upload is done.
 * - `farmers`     the farmer lookup cache (D43): id, phone, name, with TTL.
 * - `balances`    farmers' balances as last seen online here (D43 as amended):
 *                 bags and kg by commodity and grade, free / held on-chain
 *                 only, 24-hour TTL. No fees, no movements.
 * - `deposits`    what was captured here, for the success, queue and reprint screens.
 * - `sessions`    staff sign-ins on this device (token + local PIN check).
 * - `pendingDispatches`  dispatches submitted but not yet known to be
 *                 recorded or not, until someone acknowledges the outcome.
 * - `meta`        cached features, language, directory refresh time, when the
 *                 tablet was last online, and its blocked-dispatch count.
 */

export const DB_NAME = 'farmledge-warehouse';
export const DB_VERSION = 3;

export type OutboxStatus = 'pending' | 'sending' | 'done' | 'failed';

export interface OutboxError {
  /**
   * network: no answer (retried with backoff). server: 5xx/429 (retried).
   * rejected: the API refused it (needs a person). needs_sign_in: no valid
   * session for the custodian who captured it (sent after they sign in).
   */
  kind: 'network' | 'server' | 'rejected' | 'needs_sign_in';
  status?: number;
  code: string;
  message: string;
  details?: unknown;
}

interface OutboxBase {
  opId: string;
  /** The sign-in the item was captured under; its token sends it. */
  sessionId: string;
  /** Who captured it. If their session ends, any newer session of theirs sends it. */
  custodianId: string;
  /** The deposit it belongs to (null for a farmer registration). */
  depositId: string | null;
  createdAt: number;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms before which it is not retried. */
  nextAttemptAt: number;
  /** Items that must be `done` first. */
  dependsOn: string[];
  lastError: OutboxError | null;
  doneAt: number | null;
}

export interface FarmerOp extends OutboxBase {
  kind: 'farmer';
  payload: { localFarmerId: string; request: RegisterFarmerRequest };
  /** The server's farmer id, once registered (or found already registered). */
  result: { farmerId: string } | null;
}

export interface DepositOp extends OutboxBase {
  kind: 'deposit';
  payload: {
    /** Frozen at capture. farmer_id is null until `farmerOpId` is done. */
    request: Omit<DepositRequest, 'farmer_id'> & { farmer_id: string | null };
    farmerOpId: string | null;
  };
  result: { depositNo: number; needsReview: boolean } | null;
}

export interface SampleOp extends OutboxBase {
  kind: 'sample';
  payload: { depositId: string; request: ScaleSampleRequest };
  result: null;
}

export interface PhotoOp extends OutboxBase {
  kind: 'photo';
  payload: {
    depositId: string;
    photoId: string;
    contentType: string;
    sha256: string;
    uploadedBy: string;
  };
  result: null;
}

/** A dispatch this tablet refused to start offline (D54). Counted, not described. */
export interface DispatchBlockedOp extends OutboxBase {
  kind: 'dispatchBlocked';
  payload: { warehouseId: string; request: DispatchBlockedRequest };
  result: null;
}

export type OutboxItem = FarmerOp | DepositOp | SampleOp | PhotoOp | DispatchBlockedOp;
export type OutboxKind = OutboxItem['kind'];

export interface PhotoBlob {
  photoId: string;
  depositId: string;
  blob: Blob;
}

export interface CachedFarmer {
  /** E.164; the cache key. */
  phone: string;
  full_name: string;
  /** Server id; null while the registration is still queued. */
  id: string | null;
  /** Set for a farmer registered on this tablet whose registration is queued. */
  localFarmerId: string | null;
  /** Epoch ms the server last confirmed this entry; drives the TTL. */
  confirmedAt: number;
  warehouseId: string;
}

/** One cached balance line: quantities only (D43 as amended). */
export interface CachedBalanceLine {
  commodity: Commodity;
  grade: string;
  bags: number;
  kg: number;
  free_bags: number;
  free_kg: number;
  held_bags: number;
  held_kg: number;
}

export interface CachedBalance {
  /** Server farmer id; the store key. */
  farmerId: string;
  warehouseId: string;
  phone: string;
  full_name: string;
  lines: CachedBalanceLine[];
  /** Epoch ms the server returned these figures; drives the TTL and the age shown. */
  fetchedAt: number;
}

/**
 * A dispatch signed off and sent, kept until its outcome is known and seen.
 * The request is frozen at sign-off: every resend is byte-for-byte the same.
 */
export interface PendingDispatch {
  /** The request's dispatch_id; the store key. */
  dispatchId: string;
  request: DispatchRequest;
  /** The sign-in that signed it off. */
  sessionId: string;
  farmerName: string;
  /** Epoch ms of the first send. */
  firstSentAt: number;
  /**
   * unconfirmed: may or may not be recorded. recorded: the server has it.
   * not_recorded: definitely not; the custodian starts again.
   */
  state: 'unconfirmed' | 'recorded' | 'not_recorded';
  result: DispatchView | null;
  /** The last error, in the API's words, while unconfirmed or not recorded. */
  lastError: { code: string; message: string } | null;
}

export interface LocalDeposit {
  deposit_id: string;
  reference: string;
  captured_at: string;
  warehouse: { id: string; code: string; name: string };
  custodian: { id: string; full_name: string };
  verifier: { id: string; full_name: string };
  farmer: { full_name: string; phone: string };
  commodity: Commodity;
  grade: string;
  moisture_pct: number;
  bag_count: number;
  photo_count: number;
  sample: { bags_weighed: number; total_kg: number } | null;
  /** From the API once the deposit is recorded there. */
  server: { deposit_no: number; needs_review: boolean } | null;
  /** The counter slip's proof data, fetched after sync. */
  slip: { qr_payload: string; anchored: boolean } | null;
}

export interface StoredSession extends SessionView {
  /** session.id; the store key. */
  id: string;
  token: string;
  /** PBKDF2 of the PIN, to unlock offline (src/auth/pinCheck.ts). */
  pinCheck: { salt: string; hash: string; iterations: number };
  failedUnlocks: number;
  signedInAt: number;
  /** Signed out on the tablet: kept only to send what it captured. */
  ended: boolean;
  /** The API refused the token (revoked, expired, suspended). */
  invalid: boolean;
}

export interface Meta {
  features: Features;
  language: 'en' | 'ha';
  directoryRefreshedAt: number;
  /** Epoch ms of the last sync that reached the API. */
  lastOnlineAt: number;
  /** Dispatches this tablet refused to start offline, ever (shown in Settings). */
  blockedDispatchCount: number;
  /**
   * A stock count started here and not yet finished. Kept so the idle lock,
   * a reload or a different custodian signing in never strands it open on
   * the server.
   */
  openAudit: OpenAudit;
}

export interface OpenAudit {
  audit: AuditView;
  /** Lines the server has, in the order counted. */
  lines: CountedLine[];
}

/** One commodity and grade counted, with what the system recorded when it was saved (D9). */
export interface CountedLine {
  commodity: Commodity;
  grade: string;
  recorded_bags: number;
  recorded_kg: number;
  counted_bags: number;
  counted_kg: number;
  difference_bags: number;
  difference_kg: number;
}

export interface FarmledgeSchema extends DBSchema {
  outbox: {
    key: string;
    value: OutboxItem;
    indexes: { status: OutboxStatus; depositId: string; sessionId: string };
  };
  photoBlobs: { key: string; value: PhotoBlob; indexes: { depositId: string } };
  farmers: { key: string; value: CachedFarmer; indexes: { localFarmerId: string } };
  balances: { key: string; value: CachedBalance };
  pendingDispatches: { key: string; value: PendingDispatch };
  deposits: { key: string; value: LocalDeposit };
  sessions: { key: string; value: StoredSession };
  meta: { key: keyof Meta; value: Meta[keyof Meta] };
}

export type AppDb = IDBPDatabase<FarmledgeSchema>;

export function openAppDb(name = DB_NAME): Promise<AppDb> {
  return openDB<FarmledgeSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'opId' });
        outbox.createIndex('status', 'status');
        outbox.createIndex('depositId', 'depositId');
        outbox.createIndex('sessionId', 'sessionId');
        const photos = db.createObjectStore('photoBlobs', { keyPath: 'photoId' });
        photos.createIndex('depositId', 'depositId');
        const farmers = db.createObjectStore('farmers', { keyPath: 'phone' });
        farmers.createIndex('localFarmerId', 'localFarmerId');
        db.createObjectStore('deposits', { keyPath: 'deposit_id' });
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('meta');
      }
      if (oldVersion < 2) db.createObjectStore('balances', { keyPath: 'farmerId' });
      if (oldVersion < 3) db.createObjectStore('pendingDispatches', { keyPath: 'dispatchId' });
    },
  });
}

export async function getMeta<K extends keyof Meta>(
  db: AppDb,
  key: K,
): Promise<Meta[K] | undefined> {
  return (await db.get('meta', key)) as Meta[K] | undefined;
}

export async function setMeta<K extends keyof Meta>(
  db: AppDb,
  key: K,
  value: Meta[K],
): Promise<void> {
  await db.put('meta', value, key);
}
