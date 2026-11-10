import type pg from 'pg';

import { MAX_TTL_BATCH, type ChainClient } from '../chain/chainClient.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alerts.js';
import { chainHalted } from './chainDeployment.js';
import { archiveCoverage, MAX_INDEXER_STALENESS_LEDGERS } from './indexer.js';

/** Ledgers close about every 5 seconds: 17,280 a day. */
const LEDGERS_PER_DAY = 17_280;
/** backend-requirements §2: alert when a receipt has 14 days of TTL left. */
export const TTL_ALERT_DAYS = 14;
/** Keep-alive trusts the projection only when the indexer is this close to the network. */
export { MAX_INDEXER_STALENESS_LEDGERS };

export const LIVE_STATUSES = ['Active', 'Locked', 'Recovery'] as const;

export interface KeepAliveReport {
  sent: string[];
  skippedFinished: number;
  batches: number;
  minDaysRemaining: number | null;
  lowTtl: string[];
  /** Live receipts the projection lacked, found on-chain and kept alive anyway. */
  recovered: string[];
  /** True when the archive had holes, so every status was read from the chain. */
  statusesFromChain: boolean;
}

/**
 * The daily keep-alive job (INV-9; backend-requirements §2). The contract
 * bumps each kept receipt to its agreed 175-day TTL itself; the backend's
 * duties, which the contract cannot check, are:
 *
 * - run it daily for every live receipt (Active, Locked, Recovery);
 * - **never send an Exited or Revoked id**: they are left to archive, and a
 *   stale list is how one would slip in, so the job refuses to run on a
 *   projection the indexer has not brought up to date;
 * - **never miss a live receipt**: a missed `minted` or `split` would leave
 *   one out of the projection, and it would archive. Receipt ids run
 *   1..lastReceiptId with no reuse, so every id the projection lacks is read
 *   from the chain, kept alive if live, and raised as urgent;
 * - when the archive has holes, a missed exit could make a finished receipt
 *   look live, so every status is read from the chain instead;
 * - at most 25 ids per call;
 * - read back each receipt's TTL afterwards (`ttl_extended` is not proof
 *   that rent was paid) and page at 14 days left.
 */
export class KeepAliveService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: ChainClient,
    private readonly alerts: AlertService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(): Promise<KeepAliveReport> {
    if (!this.chain.capabilities.ttl) {
      this.logger.info(
        { backend: this.chain.backend, contractId: this.chain.contractId },
        'keep-alive skipped: chain uses storage staking rather than TTL rent',
      );
      return {
        sent: [],
        skippedFinished: 0,
        batches: 0,
        minDaysRemaining: null,
        lowTtl: [],
        recovered: [],
        statusesFromChain: false,
      };
    }
    const contractId = this.chain.contractId;
    if (await chainHalted(this.pool))
      throw new Error('chain writers are halted: a Testnet reset is unresolved');
    const started = this.clock();
    const latest = await this.chain.latestLedger();
    const cursor = await this.pool.query<{ cursor_ledger: string }>(
      'SELECT cursor_ledger FROM indexer_cursors WHERE contract_id = $1',
      [contractId],
    );
    const indexed = Number(cursor.rows[0]?.cursor_ledger ?? 0);
    const coverage = await archiveCoverage(this.pool, contractId, latest.sequence);
    if (latest.sequence - indexed > MAX_INDEXER_STALENESS_LEDGERS) {
      await this.alerts.raise({
        key: `keepalive_blocked:${contractId}`,
        severity: 'page',
        category: 'keepalive',
        message: `Keep-alive did not run: the indexer is ${latest.sequence - indexed} ledgers behind, so the receipt list could include finished receipts`,
        details: { indexed, latest: latest.sequence },
      });
      throw new Error('keep-alive refused: the indexer is not up to date');
    }
    await this.alerts.resolve(`keepalive_blocked:${contractId}`);

    const { rows } = await this.pool.query<{ receipt_id: string; status: string }>(
      'SELECT receipt_id, status FROM chain_receipts WHERE contract_id = $1 ORDER BY receipt_id',
      [contractId],
    );
    const fromChain = coverage.holes.length > 0;
    if (fromChain) {
      await this.alerts.raise({
        key: `keepalive_archive_gap:${contractId}`,
        severity: 'page',
        category: 'keepalive',
        message:
          'The event archive has holes, so receipt statuses may be stale: keep-alive read every status from the chain',
        details: { holes: coverage.holes },
      });
    } else {
      await this.alerts.resolve(`keepalive_archive_gap:${contractId}`);
    }
    let ids = fromChain
      ? await this.liveOnChain(rows.map((row) => row.receipt_id))
      : selectLive(rows);

    // Every id the contract has assigned and the projection lacks.
    const projected = new Set(rows.map((row) => row.receipt_id));
    const missing = missingIds(projected, await this.chain.lastReceiptId());
    const recovered = await this.liveOnChain(missing);
    if (missing.length > 0) {
      await this.alerts.raise({
        key: `receipts_missing_from_projection:${contractId}`,
        severity: 'urgent',
        category: 'keepalive',
        message:
          `${missing.length} receipt id(s) exist on-chain but not in the indexer's projection ` +
          `(${recovered.length} live, kept alive anyway): events were missed`,
        details: { missing: missing.slice(0, 100), live: recovered.slice(0, 100) },
      });
    } else {
      await this.alerts.resolve(`receipts_missing_from_projection:${contractId}`);
    }
    ids = [...ids, ...recovered].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const batches = batchesOf(ids, MAX_TTL_BATCH);
    for (const batch of batches) {
      const outcome = await this.chain.extendTtlBatch(this.pool, batch.map(BigInt));
      if (outcome.status !== 'success') {
        await this.alerts.raise({
          key: `keepalive_failed:${contractId}`,
          severity: 'page',
          category: 'keepalive',
          message: `extend_ttl_batch did not succeed (${outcome.status}): ${outcome.error ?? ''}`,
          details: { receipt_ids: batch },
        });
      }
    }

    const lives = await this.chain.receiptLiveUntil(ids.map(BigInt));
    const after = await this.chain.latestLedger();
    const lowTtl: string[] = [];
    let minDays: number | null = null;
    for (const id of ids) {
      const liveUntil = lives.get(id) ?? null;
      const days = liveUntil === null ? 0 : (liveUntil - after.sequence) / LEDGERS_PER_DAY;
      minDays = minDays === null ? days : Math.min(minDays, days);
      const key = `ttl_low:${contractId}:${id}`;
      if (days <= TTL_ALERT_DAYS) {
        lowTtl.push(id);
        await this.alerts.raise({
          key,
          severity: 'page',
          category: 'keepalive',
          message: `Receipt ${id} has ${days.toFixed(1)} days of TTL left after keep-alive`,
          details: { receipt_id: id, live_until_ledger: liveUntil, days_remaining: days },
        });
      } else {
        await this.alerts.resolve(key);
      }
    }
    await this.pool.query(
      `INSERT INTO keepalive_runs (contract_id, receipt_ids, skipped_finished, batches,
                                   min_days_remaining, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        contractId,
        ids,
        rows.length + missing.length - ids.length,
        batches.length,
        minDays,
        started,
        this.clock(),
      ],
    );
    this.logger.info({ sent: ids.length, batches: batches.length, minDays }, 'keep-alive run');
    return {
      sent: ids,
      skippedFinished: rows.length + missing.length - ids.length,
      batches: batches.length,
      minDaysRemaining: minDays,
      lowTtl,
      recovered,
      statusesFromChain: fromChain,
    };
  }

  /** The ids among `ids` whose receipt is live on-chain, read one by one. */
  private async liveOnChain(ids: readonly string[]): Promise<string[]> {
    const live: string[] = [];
    for (const id of ids) {
      const receipt = await this.chain.getReceipt(BigInt(id));
      if (receipt !== null && (LIVE_STATUSES as readonly string[]).includes(receipt.status)) {
        live.push(id);
      }
    }
    return live;
  }
}

/** Ids in 1..last that are not in `projected`. */
export function missingIds(projected: ReadonlySet<string>, last: bigint): string[] {
  const out: string[] = [];
  for (let id = 1n; id <= last; id++) {
    if (!projected.has(id.toString())) out.push(id.toString());
  }
  return out;
}

/** INV-9: only live receipts are ever sent; Exited and Revoked never. */
export function selectLive(rows: readonly { receipt_id: string; status: string }[]): string[] {
  return rows
    .filter((row) => (LIVE_STATUSES as readonly string[]).includes(row.status))
    .map((row) => row.receipt_id);
}

export function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
