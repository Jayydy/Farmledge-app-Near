import type {
  AppDb,
  CachedFarmer,
  DepositOp,
  FarmerOp,
  LocalDeposit,
  OutboxItem,
  PhotoBlob,
  PhotoOp,
  SampleOp,
} from '../db/schema';
import type { Commodity } from '../types/api';
import { isoWithOffset, shortReference } from '../lib/numbers';

/** A finished intake, as the review screen confirms it. */
export interface Capture {
  depositId: string;
  capturedAt: Date;
  session: {
    id: string;
    custodian: { id: string; full_name: string };
    warehouse: { id: string; code: string; name: string };
  };
  verifier: { id: string; full_name: string };
  farmer:
    | { kind: 'known'; id: string; full_name: string; phone: string }
    /** Registered on this tablet, registration still queued. */
    | { kind: 'queued'; localFarmerId: string; full_name: string; phone: string }
    | {
        kind: 'new';
        localFarmerId: string;
        full_name: string;
        phone: string;
        consent: true;
        lookupConsent: boolean;
      };
  commodity: Commodity;
  grade: string;
  moisturePct: number;
  bagCount: number;
  confirmBagCount: boolean;
  sample: { sampleId: string; bagsWeighed: number; totalKg: number } | null;
  /** Already resized; sha256 is hex of the bytes. */
  photos: { photoId: string; blob: Blob; contentType: string; sha256: string }[];
}

const base = (capture: Capture, opId: string, now: number) => ({
  opId,
  sessionId: capture.session.id,
  custodianId: capture.session.custodian.id,
  createdAt: now,
  status: 'pending' as const,
  attempts: 0,
  nextAttemptAt: now,
  lastError: null,
  doneAt: null,
});

/** The outbox items one capture becomes, with their dependencies. */
export function outboxItemsFor(
  capture: Capture,
  now: number,
  newId: () => string,
  pendingFarmerOpId: string | null,
): OutboxItem[] {
  const items: OutboxItem[] = [];
  const capturedAt = isoWithOffset(capture.capturedAt);

  let farmerOpId: string | null = null;
  if (capture.farmer.kind === 'new') {
    farmerOpId = newId();
    const farmerOp: FarmerOp = {
      ...base(capture, farmerOpId, now),
      kind: 'farmer',
      depositId: null,
      dependsOn: [],
      payload: {
        localFarmerId: capture.farmer.localFarmerId,
        request: {
          full_name: capture.farmer.full_name,
          phone: capture.farmer.phone,
          warehouse_id: capture.session.warehouse.id,
          registered_by: capture.session.custodian.id,
          consent: capture.farmer.consent,
          lookup_consent: capture.farmer.lookupConsent,
        },
      },
      result: null,
    };
    items.push(farmerOp);
  } else if (capture.farmer.kind === 'queued') {
    farmerOpId = pendingFarmerOpId;
  }

  const depositOpId = newId();
  const depositOp: DepositOp = {
    ...base(capture, depositOpId, now),
    kind: 'deposit',
    depositId: capture.depositId,
    dependsOn: farmerOpId === null ? [] : [farmerOpId],
    payload: {
      farmerOpId,
      request: {
        deposit_id: capture.depositId,
        farmer_id: capture.farmer.kind === 'known' ? capture.farmer.id : null,
        warehouse_id: capture.session.warehouse.id,
        custodian_id: capture.session.custodian.id,
        verifier_id: capture.verifier.id,
        commodity: capture.commodity,
        grade: capture.grade,
        moisture_pct: capture.moisturePct,
        bag_count: capture.bagCount,
        confirm_bag_count: capture.confirmBagCount,
        captured_at: capturedAt,
      },
    },
    result: null,
  };
  items.push(depositOp);

  if (capture.sample !== null) {
    const sampleOp: SampleOp = {
      ...base(capture, newId(), now),
      kind: 'sample',
      depositId: capture.depositId,
      dependsOn: [depositOpId],
      payload: {
        depositId: capture.depositId,
        request: {
          sample_id: capture.sample.sampleId,
          bags_weighed: capture.sample.bagsWeighed,
          total_kg: capture.sample.totalKg,
          recorded_by: capture.session.custodian.id,
          recorded_at: capturedAt,
        },
      },
      result: null,
    };
    items.push(sampleOp);
  }

  for (const photo of capture.photos) {
    const photoOp: PhotoOp = {
      ...base(capture, newId(), now),
      kind: 'photo',
      depositId: capture.depositId,
      dependsOn: [depositOpId],
      payload: {
        depositId: capture.depositId,
        photoId: photo.photoId,
        contentType: photo.contentType,
        sha256: photo.sha256,
        uploadedBy: capture.session.custodian.id,
      },
      result: null,
    };
    items.push(photoOp);
  }
  return items;
}

/**
 * Saves a confirmed intake: every outbox item, the photo bytes, the local
 * deposit record and (for a new farmer) the cache entry, in ONE IndexedDB
 * transaction. Either all of it is on the tablet or none of it is, so the
 * success screen is only shown for something that is really saved.
 * Saving the same deposit_id twice is refused rather than queued twice.
 */
export async function saveCapture(
  db: AppDb,
  capture: Capture,
  now: number = Date.now(),
  newId: () => string = () => crypto.randomUUID(),
): Promise<LocalDeposit> {
  const tx = db.transaction(['outbox', 'photoBlobs', 'deposits', 'farmers'], 'readwrite');
  const done = tx.done;
  try {
    if ((await tx.objectStore('deposits').getKey(capture.depositId)) !== undefined) {
      throw new Error(`deposit ${capture.depositId} is already saved`);
    }
    let pendingFarmerOpId: string | null = null;
    if (capture.farmer.kind === 'queued') {
      // The registration queued with an earlier deposit.
      const localId = capture.farmer.localFarmerId;
      const ops = await tx.objectStore('outbox').getAll();
      pendingFarmerOpId =
        ops.find((op) => op.kind === 'farmer' && op.payload.localFarmerId === localId)?.opId ??
        null;
      if (pendingFarmerOpId === null) throw new Error(`no queued registration for ${localId}`);
    }

    for (const item of outboxItemsFor(capture, now, newId, pendingFarmerOpId)) {
      await tx.objectStore('outbox').add(item);
    }
    for (const photo of capture.photos) {
      const record: PhotoBlob = {
        photoId: photo.photoId,
        depositId: capture.depositId,
        blob: photo.blob,
      };
      await tx.objectStore('photoBlobs').add(record);
    }
    if (capture.farmer.kind === 'new') {
      const farmer: CachedFarmer = {
        phone: capture.farmer.phone,
        full_name: capture.farmer.full_name,
        id: null,
        localFarmerId: capture.farmer.localFarmerId,
        confirmedAt: now,
        warehouseId: capture.session.warehouse.id,
      };
      await tx.objectStore('farmers').put(farmer);
    }
    const local: LocalDeposit = {
      deposit_id: capture.depositId,
      reference: shortReference(capture.depositId),
      captured_at: isoWithOffset(capture.capturedAt),
      warehouse: capture.session.warehouse,
      custodian: capture.session.custodian,
      verifier: capture.verifier,
      farmer: { full_name: capture.farmer.full_name, phone: capture.farmer.phone },
      commodity: capture.commodity,
      grade: capture.grade,
      moisture_pct: capture.moisturePct,
      bag_count: capture.bagCount,
      photo_count: capture.photos.length,
      sample:
        capture.sample === null
          ? null
          : { bags_weighed: capture.sample.bagsWeighed, total_kg: capture.sample.totalKg },
      server: null,
      slip: null,
    };
    await tx.objectStore('deposits').add(local);
    await done;
    return local;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already finished or aborted.
    }
    await done.catch(() => undefined);
    throw err;
  }
}
