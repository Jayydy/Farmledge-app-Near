import type { AppDb, DispatchBlockedOp, StoredSession } from '../db/schema';

/**
 * Dispatch is blocked offline (D54): without current data the tablet could
 * release grain that was pledged or already dispatched. Each refused start
 * is recorded so the trial shows how often connectivity stops a release.
 * The record is queued like any capture and sent on reconnect; it carries
 * when, who, and when the tablet was last online. Never the farmer, lot or
 * quantity. The tablet's own count is kept in `meta`.
 */
export async function recordBlockedDispatch(
  db: AppDb,
  session: StoredSession,
  now: number = Date.now(),
): Promise<number> {
  const id = crypto.randomUUID();
  const tx = db.transaction(['outbox', 'meta'], 'readwrite');
  const meta = tx.objectStore('meta');
  const lastOnlineAt = (await meta.get('lastOnlineAt')) as number | undefined;
  const item: DispatchBlockedOp = {
    opId: id,
    kind: 'dispatchBlocked',
    sessionId: session.id,
    custodianId: session.custodian.id,
    depositId: null,
    createdAt: now,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    dependsOn: [],
    lastError: null,
    doneAt: null,
    payload: {
      warehouseId: session.warehouse.id,
      request: {
        id,
        custodian_id: session.custodian.id,
        blocked_at: new Date(now).toISOString(),
        offline_since:
          lastOnlineAt === undefined || lastOnlineAt > now
            ? null
            : new Date(lastOnlineAt).toISOString(),
      },
    },
    result: null,
  };
  await tx.objectStore('outbox').put(item);
  const count = (((await meta.get('blockedDispatchCount')) as number | undefined) ?? 0) + 1;
  await meta.put(count, 'blockedDispatchCount');
  await tx.done;
  return count;
}
