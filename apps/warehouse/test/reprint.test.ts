import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpError, NetworkError, type ApiClient } from '../src/api/client';
import { openAppDb, type AppDb, type StoredSession } from '../src/db/schema';
import { findDeposits, loadSlip } from '../src/reprint/find';
import { saveCapture } from '../src/sync/capture';
import type { DepositSlip } from '../src/types/api';

const WAREHOUSE = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'KN-DAWANAU',
  name: 'Dawanau',
};
const CUSTODIAN = { id: '22222222-2222-4222-8222-222222222222', full_name: 'Amina Sani' };
const NOW = Date.parse('2026-10-07T09:00:00Z');
const session = {
  id: 's',
  token: 't',
  session: { id: 's', expires_at: new Date(NOW + 3600_000).toISOString() },
  custodian: { ...CUSTODIAN, phone: '+2348000000001' },
  warehouse: WAREHOUSE,
  roster: { verifiers: [] },
} as unknown as StoredSession;

async function captureHere(db: AppDb, phone: string) {
  return saveCapture(db, {
    depositId: randomUUID(),
    capturedAt: new Date(NOW),
    session: { id: 's', custodian: CUSTODIAN, warehouse: WAREHOUSE },
    verifier: { id: randomUUID(), full_name: 'Bala Musa' },
    farmer: { kind: 'known', id: randomUUID(), full_name: 'Musa Bello', phone },
    commodity: 'MAIZE_WHITE',
    grade: '1',
    moisturePct: 12.5,
    bagCount: 20,
    confirmBagCount: false,
    sample: null,
    photos: [],
  });
}

function serverSlip(depositId: string, depositNo: number): DepositSlip {
  return {
    deposit: {
      deposit_id: depositId,
      deposit_no: depositNo,
      farmer_id: 'f1',
      commodity: 'MAIZE_WHITE',
      grade: '2',
      moisture_pct: 11,
      bag_count: 7,
      captured_at: '2026-09-01T10:00:00+01:00',
    } as DepositSlip['deposit'],
    proofs: [{ leaf: { index: null }, qr_payload: '{"leaf":1}', anchored: false }],
    printable: {
      warehouse: { code: 'KN-DAWANAU', name: 'Dawanau' },
      farmer: { full_name: 'Musa Bello', phone: '+2348031234567' },
      custodian: { full_name: 'Other Custodian' },
      verifier: { full_name: 'Bala Musa' },
    },
  };
}

describe('reprint', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = await openAppDb(`test-${randomUUID()}`);
  });
  afterEach(() => {
    db.close();
  });

  it('finds this tablet’s deposits offline, including ones not yet sent', async () => {
    const local = await captureHere(db, '+2348031234567');
    const offline: ApiClient = () => Promise.reject(new NetworkError('offline'));
    const result = await findDeposits(
      db,
      offline,
      session,
      { by: 'phone', phone: '0803 123 4567' },
      false,
    );
    expect(result.localOnly).toBe(true);
    expect(result.candidates.map((c) => c.depositId)).toEqual([local.deposit_id]);
    expect(result.candidates[0]?.depositNo).toBeNull();

    const slip = await loadSlip(db, offline, session, local.deposit_id, false);
    expect(slip).toMatchObject({
      depositNo: null,
      proofPayload: null,
      farmer: { full_name: 'Musa Bello' },
    });
  });

  it('online, adds deposits captured on other tablets, and prints the server’s slip', async () => {
    const local = await captureHere(db, '+2348031234567');
    const elsewhere = randomUUID();
    const api = (async (_method: string, path: string) => {
      await Promise.resolve(); // an API answers asynchronously
      if (path.startsWith('/farmers?phone=')) {
        return { status: 200, data: { items: [{ id: 'f1', full_name: 'Musa Bello' }] } };
      }
      if (path.startsWith('/deposits?farmer=f1')) {
        return {
          status: 200,
          data: { items: [serverSlip(elsewhere, 7).deposit], next_cursor: null },
        };
      }
      if (path === `/deposits/${elsewhere}/slip`)
        return { status: 200, data: serverSlip(elsewhere, 7) };
      throw new HttpError(404, { error: { code: 'not_found', message: 'Deposit not found' } });
    }) as ApiClient;

    const result = await findDeposits(
      db,
      api,
      session,
      { by: 'phone', phone: '08031234567' },
      true,
    );
    expect(result.localOnly).toBe(false);
    expect(result.candidates.map((c) => c.depositId).sort()).toEqual(
      [local.deposit_id, elsewhere].sort(),
    );

    expect(await loadSlip(db, api, session, elsewhere, true)).toMatchObject({
      depositNo: 7,
      custodian: 'Other Custodian',
      proofPayload: '{"leaf":1}',
    });
    // Not on the server yet: falls back to this tablet's record.
    expect(await loadSlip(db, api, session, local.deposit_id, true)).toMatchObject({
      depositNo: null,
    });
  });

  it('falls back to this tablet when the API does not answer', async () => {
    await captureHere(db, '+2348031234567');
    const dead: ApiClient = () => Promise.reject(new NetworkError('reset'));
    const result = await findDeposits(
      db,
      dead,
      session,
      { by: 'phone', phone: '08031234567' },
      true,
    );
    expect(result).toMatchObject({ localOnly: true });
    expect(result.candidates).toHaveLength(1);
  });
});
