import type { ApiClient } from '../api/client';
import type { AppDb, StoredSession } from '../db/schema';
import type {
  DepositPage,
  DepositView,
  DispatchBlockedCount,
  DispatchList,
  DispatchView,
} from '../types/api';

/** The business date (YYYY-MM-DD) of an instant in the warehouse's time zone. */
export function businessDate(at: Date | number, timeZone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

/** The business date `days` before or after `date`. */
export function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export interface DayIn {
  deposits: number;
  bags: number;
  kg: number;
  /** Deposits whose weight is bags × bag size: the trial's normal case, a plain figure. */
  bagEstimated: number;
}

export interface DayOut {
  dispatches: number;
  bags: number;
  /** Exit weight where weighed, else the book weight. */
  kg: number;
  /** Dispatches out without a weight: the one Out figure that warns. */
  notWeighed: number;
}

export interface DaySummary {
  date: string;
  fetchedAt: number;
  in: DayIn;
  out: DayOut;
  /** Refused offline at this warehouse, from every tablet (D57). */
  blocked: number;
  deposits: DepositView[];
  dispatches: DispatchView[];
  /** The API lists at most this many dispatches; more means the list was cut. */
  dispatchesTruncated: boolean;
}

const PAGE = 200;

/** Deposits that hold or held stock; rejected and cancelled ones never did. */
function counts(deposit: DepositView): boolean {
  return deposit.status !== 'rejected' && deposit.status !== 'cancelled';
}

export function summariseIn(deposits: readonly DepositView[]): DayIn {
  const kept = deposits.filter(counts);
  return {
    deposits: kept.length,
    bags: kept.reduce((sum, d) => sum + d.bag_count, 0),
    kg: kept.reduce((sum, d) => sum + (d.weight_kg ?? d.bag_count * d.bag_size_kg), 0),
    bagEstimated: kept.filter((d) => d.weight_source === 'bag_estimate').length,
  };
}

export function summariseOut(dispatches: readonly DispatchView[]): DayOut {
  const out = dispatches.filter((d) => d.status === 'completed');
  return {
    dispatches: out.length,
    bags: out.reduce((sum, d) => sum + d.bag_count, 0),
    kg: out.reduce((sum, d) => sum + (d.exit_weight_kg ?? d.book_kg), 0),
    notWeighed: out.filter((d) => d.exit_weight_kg === null).length,
  };
}

/**
 * One business day at the session's warehouse, from the API: every deposit
 * and dispatch on that date and the warehouse-wide blocked count. Online
 * only; a NetworkError or HttpError is the caller's to show.
 */
export async function loadDaySummary(
  api: ApiClient,
  session: StoredSession,
  date: string,
  now: () => number = Date.now,
): Promise<DaySummary> {
  const warehouse = session.warehouse.id;
  const token = session.token;
  const range = `from=${date}&to=${date}`;
  const deposits = async () => {
    const all: DepositView[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const page = await api<DepositPage>(
        'GET',
        `/deposits?warehouse=${warehouse}&${range}&limit=${PAGE}${after}`,
        { token },
      );
      all.push(...page.data.items);
      cursor = page.data.next_cursor;
    } while (cursor !== null);
    return all;
  };
  const [depositList, dispatchList, blocked] = await Promise.all([
    deposits(),
    api<DispatchList>('GET', `/dispatches?warehouse=${warehouse}&${range}&limit=${PAGE}`, {
      token,
    }),
    api<DispatchBlockedCount>('GET', `/warehouses/${warehouse}/dispatch-blocked?${range}`, {
      token,
    }),
  ]);
  const dispatches = dispatchList.data.items;
  return {
    date,
    fetchedAt: now(),
    in: summariseIn(depositList),
    out: summariseOut(dispatches),
    blocked: blocked.data.blocked,
    deposits: depositList.filter(counts),
    dispatches: dispatches.filter((d) => d.status === 'completed'),
    dispatchesTruncated: dispatches.length >= PAGE,
  };
}

/** Offline: only what this tablet recorded today, as bags (no weights are kept here). */
export async function localToday(
  db: AppDb,
  session: StoredSession,
  timeZone: string,
  now: number = Date.now(),
): Promise<{ deposits: number; bags: number }> {
  const today = businessDate(now, timeZone);
  const mine = (await db.getAll('deposits')).filter(
    (d) =>
      d.warehouse.id === session.warehouse.id &&
      businessDate(Date.parse(d.captured_at), timeZone) === today,
  );
  return { deposits: mine.length, bags: mine.reduce((sum, d) => sum + d.bag_count, 0) };
}
