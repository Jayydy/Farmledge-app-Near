import type { ApiClient } from '../api/client';
import type { AppDb, LocalDeposit, StoredSession } from '../db/schema';
import { normaliseNigerianMobile } from '../lib/phone';
import { shortReference } from '../lib/numbers';
import { slipFromLocal, slipFromServer, type SlipData } from '../print/slipData';
import type {
  Commodity,
  DepositPage,
  DepositSlip,
  DepositView,
  FindFarmerResponse,
} from '../types/api';

/**
 * Finding a slip to reprint (API D46): any staff member, any time, no
 * request step. Online, the API has every deposit at the warehouse,
 * whichever tablet captured it. This tablet's own records are always
 * searched too, so a deposit not yet sent, or any captured here while
 * there is no signal, can still be reprinted.
 */
export interface ReprintCandidate {
  depositId: string;
  reference: string;
  depositNo: number | null;
  farmerName: string;
  commodity: Commodity;
  bags: number;
  capturedAt: string;
}

export type Search = { by: 'phone'; phone: string } | { by: 'number'; depositNo: number };

const fromLocal = (d: LocalDeposit): ReprintCandidate => ({
  depositId: d.deposit_id,
  reference: d.reference,
  depositNo: d.server?.deposit_no ?? null,
  farmerName: d.farmer.full_name,
  commodity: d.commodity,
  bags: d.bag_count,
  capturedAt: d.captured_at,
});

const fromServer = (d: DepositView, farmerName: string): ReprintCandidate => ({
  depositId: d.deposit_id,
  reference: shortReference(d.deposit_id),
  depositNo: d.deposit_no,
  farmerName,
  commodity: d.commodity as Commodity,
  bags: d.bag_count,
  capturedAt: d.captured_at,
});

export interface SearchResult {
  candidates: ReprintCandidate[];
  /** True when the API couldn't be asked: only this tablet's records were searched. */
  localOnly: boolean;
}

export async function findDeposits(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  search: Search,
  online: boolean,
): Promise<SearchResult> {
  const phone = search.by === 'phone' ? normaliseNigerianMobile(search.phone) : null;
  const local = (await db.getAll('deposits'))
    .filter((d) => d.warehouse.id === session.warehouse.id)
    .filter((d) =>
      search.by === 'phone' ? d.farmer.phone === phone : d.server?.deposit_no === search.depositNo,
    )
    .map(fromLocal);

  let server: ReprintCandidate[] = [];
  let localOnly = !online;
  if (online) {
    try {
      server = await serverDeposits(api, session, search, phone);
    } catch {
      localOnly = true;
    }
  }
  // One entry per deposit; the server's wins (it has the number).
  const byId = new Map<string, ReprintCandidate>();
  for (const c of [...local, ...server]) byId.set(c.depositId, c);
  const candidates = [...byId.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return { candidates, localOnly };
}

async function serverDeposits(
  api: ApiClient,
  session: StoredSession,
  search: Search,
  phone: string | null,
): Promise<ReprintCandidate[]> {
  const auth = { token: session.token };
  if (search.by === 'number') {
    const { data } = await api<DepositPage>(
      'GET',
      `/deposits?deposit_no=${search.depositNo}`,
      auth,
    );
    const names = new Map<string, string>();
    for (const d of data.items) {
      if (!names.has(d.farmer_id)) {
        const slip = await api<DepositSlip>('GET', `/deposits/${d.deposit_id}/slip`, auth);
        names.set(d.farmer_id, slip.data.printable.farmer.full_name);
      }
    }
    return data.items.map((d) => fromServer(d, names.get(d.farmer_id) ?? ''));
  }
  if (phone === null) return [];
  const farmers = await api<FindFarmerResponse>(
    'GET',
    `/farmers?phone=${encodeURIComponent(phone)}`,
    auth,
  );
  const farmer = farmers.data.items[0];
  if (farmer === undefined) return [];
  const { data } = await api<DepositPage>('GET', `/deposits?farmer=${farmer.id}&limit=50`, auth);
  return data.items.map((d) => fromServer(d, farmer.full_name));
}

/**
 * The slip to print: from the API when it has the deposit (the proof
 * payload and the deposit number), else this tablet's record.
 */
export async function loadSlip(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  depositId: string,
  online: boolean,
): Promise<SlipData | null> {
  if (online) {
    try {
      const { data } = await api<DepositSlip>('GET', `/deposits/${depositId}/slip`, {
        token: session.token,
      });
      return slipFromServer(data);
    } catch {
      // Not on the server yet, or no answer: use this tablet's record.
    }
  }
  const local = await db.get('deposits', depositId);
  return local === undefined ? null : slipFromLocal(local);
}
