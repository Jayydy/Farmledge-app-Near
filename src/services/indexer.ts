import type pg from 'pg';

import type {
  ChainClient,
  ChainEvent,
  DecodedEvent,
  EventJson as Json,
} from '../chain/chainClient.js';
import { decodeSorobanEvent as decodeEvent } from '../chain/sorobanChainClient.js';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { nextHead, ZERO_HEAD } from '../domain/merkle.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alerts.js';

export { decodeEvent, type DecodedEvent };

/** events.md requirement 2: page when indexing is more than ~24 h (17,280 ledgers) behind. */
export const MAX_LAG_LEDGERS = 17_280;

const str = (v: Json | undefined): string | null =>
  v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
const enumName = (v: Json | undefined): string =>
  Array.isArray(v) ? (str(v[0]) ?? '') : (str(v) ?? '');

/**
 * The event indexer and archive (docs/events.md, "Indexer requirements";
 * INV-8). Backend-enforced, because the chain keeps only current state and
 * RPC keeps events about 7 days:
 *
 * 1. every event is archived (raw XDR, ledger, tx hash, event index) in the
 *    same transaction that advances the cursor, never after, idempotently on
 *    (ledger, tx hash, event index), and never pruned (append-only table);
 * 2. a page when indexing falls more than 17,280 ledgers behind;
 * 3. after any outage, a gap check over [start_ledger, cursor], re-fetching
 *    holes while RPC still holds them, then reconciling receipt weights and
 *    each warehouse's head chain against the contract;
 * 4. backups: see ArchiveBackupService.
 *
 * Projections (chain_receipts, chain_anchors, chain_registry) are derived
 * only from the archive and can be rebuilt from it exactly.
 */
export class IndexerService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: ChainClient,
    private readonly alerts: AlertService,
    private readonly logger: Logger,
    private readonly startLedger: number,
  ) {}

  /** Archives every new event up to the network's latest ledger. */
  async ingest(): Promise<{ archived: number; cursor: number; latest: number }> {
    const contractId = this.chain.contractId;
    await this.pool.query(
      `INSERT INTO indexer_cursors (contract_id, start_ledger, cursor_ledger)
       VALUES ($1, $2::bigint, $2::bigint - 1) ON CONFLICT (contract_id) DO NOTHING`,
      [contractId, this.startLedger],
    );
    let archived = 0;
    for (;;) {
      const cursor = await this.cursor();
      // RPC refuses a start ledger past its latest: nothing new has closed.
      const network = await this.chain.latestLedger();
      if (cursor >= network.sequence) {
        await this.checkLag(cursor, network.sequence);
        return { archived, cursor, latest: network.sequence };
      }
      const page = await this.chain.getEvents({ startLedger: cursor + 1 });
      if (cursor + 1 < page.oldestLedger) {
        await this.alerts.raise({
          key: `indexer_retention_gap:${contractId}`,
          severity: 'urgent',
          category: 'indexer',
          message:
            `Ledgers ${cursor + 1}..${page.oldestLedger - 1} have left RPC retention unindexed; ` +
            'recover them from Stellar history archives (disaster recovery)',
          details: { cursor, oldest_ledger: page.oldestLedger },
        });
        throw new Error('indexer fell out of RPC retention');
      }
      const through = page.coveredThrough;
      if (through < cursor + 1) {
        await this.checkLag(cursor, page.latestLedger);
        return { archived, cursor, latest: page.latestLedger };
      }
      archived += await this.archivePage(page.events, cursor + 1, through, page.latestLedger);
      if (through >= page.latestLedger) {
        await this.checkLag(through, page.latestLedger);
        return { archived, cursor: through, latest: page.latestLedger };
      }
    }
  }

  /**
   * Writes a page of events and the range it covers, applies them to the
   * projections, and advances the cursor, all in one transaction.
   */
  private async archivePage(
    events: readonly ChainEvent[],
    from: number,
    through: number,
    latest: number,
    advanceCursor = true,
  ): Promise<number> {
    const contractId = this.chain.contractId;
    return withTransaction(this.pool, async (client) => {
      let inserted = 0;
      const ordered = [...events]
        .filter((e) => e.ledger >= from && e.ledger <= through)
        .sort(eventOrder);
      for (const event of ordered) {
        const decoded = event.decoded;
        const result = await client.query(
          `INSERT INTO events_archive (event_id, contract_id, ledger, ledger_closed_at, tx_hash,
                                       tx_index, op_index, event_index, event_type, topics, value,
                                       topic_xdr, value_xdr, in_successful_contract_call)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (ledger, tx_hash, event_index) DO NOTHING`,
          [
            event.id,
            event.contractId,
            event.ledger,
            event.ledgerClosedAt,
            event.txHash,
            event.txIndex,
            event.opIndex,
            event.eventIndex,
            decoded.name,
            JSON.stringify(decoded.topics),
            JSON.stringify(decoded.fields),
            event.topicXdr,
            event.valueXdr || event.raw,
            event.inSuccessfulContractCall,
          ],
        );
        if ((result.rowCount ?? 0) > 0) {
          inserted++;
          if (event.inSuccessfulContractCall && advanceCursor) {
            await applyEvent(client, contractId, decoded, event.ledger, this.alerts);
          }
        }
      }
      await client.query(
        `INSERT INTO indexed_ranges (contract_id, from_ledger, to_ledger, event_count)
         VALUES ($1, $2, $3, $4)`,
        [contractId, from, through, ordered.length],
      );
      if (advanceCursor) {
        // INV-8: the cursor moves only with the archive, in this transaction.
        await client.query(
          `UPDATE indexer_cursors SET cursor_ledger = $2, latest_network_ledger = $3
            WHERE contract_id = $1 AND cursor_ledger < $2`,
          [contractId, through, latest],
        );
      }
      return inserted;
    });
  }

  async cursor(): Promise<number> {
    const { rows } = await this.pool.query<{ cursor_ledger: string }>(
      'SELECT cursor_ledger FROM indexer_cursors WHERE contract_id = $1',
      [this.chain.contractId],
    );
    return Number(rows[0]?.cursor_ledger ?? this.startLedger - 1);
  }

  private async checkLag(cursor: number, latest: number): Promise<void> {
    const key = `indexer_behind:${this.chain.contractId}`;
    if (latest - cursor > MAX_LAG_LEDGERS) {
      await this.alerts.raise({
        key,
        severity: 'page',
        category: 'indexer',
        message: `Indexing is ${latest - cursor} ledgers behind (over a day); about 6 days of RPC retention left to catch up`,
        details: { cursor, latest },
      });
    } else {
      await this.alerts.resolve(key);
    }
  }

  /**
   * events.md requirement 3. Finds holes in the archived ranges from the
   * start ledger to the cursor and re-fetches each while RPC still holds it;
   * then rebuilds the projections and reconciles them with the contract.
   */
  async verifyNoGaps(): Promise<{
    holes: [number, number][];
    refetched: number;
    problems: string[];
  }> {
    const contractId = this.chain.contractId;
    const cursor = await this.cursor();
    const { rows } = await this.pool.query<{ from_ledger: string; to_ledger: string }>(
      `SELECT from_ledger, to_ledger FROM indexed_ranges WHERE contract_id = $1
        ORDER BY from_ledger, to_ledger`,
      [contractId],
    );
    const holes = findHoles(
      rows.map((r) => [Number(r.from_ledger), Number(r.to_ledger)]),
      this.startLedger,
      cursor,
    );
    let refetched = 0;
    for (const [from, to] of holes) {
      let start = from;
      while (start <= to) {
        const page = await this.chain.getEvents({ startLedger: start, endLedger: to + 1 });
        if (start < page.oldestLedger) {
          await this.alerts.raise({
            key: `indexer_gap_unrecoverable:${contractId}:${from}`,
            severity: 'urgent',
            category: 'indexer',
            message: `Ledgers ${start}..${Math.min(to, page.oldestLedger - 1)} are a gap outside RPC retention; replay them from history archives`,
            details: { from: start, to },
          });
          break;
        }
        const through = Math.min(page.coveredThrough, to);
        refetched += await this.archivePage(page.events, start, through, page.latestLedger, false);
        start = through + 1;
      }
    }
    if (refetched > 0 || holes.length > 0) await this.rebuild();
    const problems = await this.reconcile();
    return { holes, refetched, problems };
  }

  /**
   * Reconciles the archive with the contract (events.md requirement 3):
   * - each receipt: its first weight (minted, or taken in a split) minus
   *   every weight split off it must equal `get_receipt`'s weight;
   * - each warehouse: the head chain recomputed from archived `anchored`
   *   events must link up and end at `get_anchor`'s head. A break means an
   *   `anchored` event is missing.
   */
  async reconcile(receiptIds?: readonly bigint[]): Promise<string[]> {
    const contractId = this.chain.contractId;
    const problems: string[] = [];
    const receipts = await this.pool.query<{ receipt_id: string; status: string }>(
      `SELECT receipt_id, status FROM chain_receipts WHERE contract_id = $1
          AND ($2::numeric[] IS NULL OR receipt_id = ANY($2::numeric[]))
        ORDER BY receipt_id`,
      [contractId, receiptIds === undefined ? null : receiptIds.map(String)],
    );
    for (const { receipt_id: id, status } of receipts.rows) {
      const expected = await this.expectedWeight(this.pool, id);
      let actual;
      try {
        actual = await this.chain.getReceipt(BigInt(id));
      } catch (err) {
        // Finished receipts archive on-chain and may need a restore to read.
        if (status === 'Exited' || status === 'Revoked') continue;
        throw err;
      }
      if (actual === null) {
        problems.push(`receipt ${id}: archived events show it, the contract does not`);
      } else if (actual.weightKg !== expected) {
        problems.push(
          `receipt ${id}: archived events give ${expected} kg, the contract ${actual.weightKg} kg`,
        );
      }
    }

    const anchors = await this.pool.query<{ warehouse_id: string; fields: Record<string, string> }>(
      `SELECT topics->>1 AS warehouse_id, value AS fields FROM events_archive
        WHERE contract_id = $1 AND event_type = 'anchored' AND in_successful_contract_call
        ORDER BY ledger, tx_index, op_index, event_index`,
      [contractId],
    );
    const byWarehouse = new Map<string, Record<string, string>[]>();
    for (const row of anchors.rows) {
      byWarehouse.set(row.warehouse_id, [...(byWarehouse.get(row.warehouse_id) ?? []), row.fields]);
    }
    for (const [symbol, events] of byWarehouse) {
      let head = ZERO_HEAD;
      for (const e of events) {
        const prev = Buffer.from(e.prev_head ?? '', 'hex');
        const computed = nextHead(
          prev,
          Number(e.day),
          Number(e.leaves),
          Buffer.from(e.root ?? '', 'hex'),
        );
        if (!prev.equals(head)) {
          problems.push(
            `${symbol}: anchored day ${e.day} does not chain on the previous archived head: an anchored event is missing`,
          );
        }
        if (computed.toString('hex') !== e.head) {
          problems.push(
            `${symbol}: anchored day ${e.day}'s head is not sha256(prev ‖ day ‖ leaves ‖ root)`,
          );
        }
        head = Buffer.from(e.head ?? '', 'hex');
      }
      const onChain = await this.chain.getAnchor(symbol);
      if (onChain === null || !onChain.head.equals(head)) {
        problems.push(
          `${symbol}: the archived head chain does not end at get_anchor's head: an anchored event is missing`,
        );
      }
    }
    if (problems.length > 0) {
      await this.alerts.raise({
        key: `indexer_reconcile:${contractId}`,
        severity: 'urgent',
        category: 'indexer',
        message: `The event archive disagrees with the contract (${problems.length} problems)`,
        details: { problems: problems.slice(0, 50) },
      });
    } else {
      await this.alerts.resolve(`indexer_reconcile:${contractId}`);
    }
    return problems;
  }

  /** First weight minus everything split off, recomputed from the archive alone. */
  private async expectedWeight(db: Queryable, receiptId: string): Promise<bigint> {
    const { rows } = await db.query<{ initial: string | null; taken: string | null }>(
      `SELECT
         (SELECT COALESCE(
            (SELECT value->>'weight_kg' FROM events_archive WHERE contract_id = $1
                AND event_type = 'minted' AND value->>'receipt_id' = $2 LIMIT 1),
            (SELECT value->>'taken_weight_kg' FROM events_archive WHERE contract_id = $1
                AND event_type = 'split' AND value->>'taken_id' = $2 LIMIT 1))) AS initial,
         (SELECT sum((value->>'taken_weight_kg')::numeric) FROM events_archive
           WHERE contract_id = $1 AND event_type = 'split' AND value->>'parent_id' = $2) AS taken`,
      [this.chain.contractId, receiptId],
    );
    const row = rows[0];
    return BigInt(row?.initial ?? 0) - BigInt(row?.taken ?? 0);
  }

  /** Rebuilds every projection from the archive alone, in event order. */
  async rebuild(): Promise<number> {
    const contractId = this.chain.contractId;
    return withTransaction(this.pool, async (client) => {
      for (const table of ['chain_receipts', 'chain_anchors', 'chain_registry']) {
        await client.query(`DELETE FROM ${table} WHERE contract_id = $1`, [contractId]);
      }
      const { rows } = await client.query<{
        event_type: string;
        topics: Json[];
        value: Record<string, Json>;
        ledger: string;
      }>(
        `SELECT event_type, topics, value, ledger FROM events_archive
          WHERE contract_id = $1 AND in_successful_contract_call
          ORDER BY ledger, tx_index, op_index, event_index`,
        [contractId],
      );
      for (const row of rows) {
        await applyEvent(
          client,
          contractId,
          { name: row.event_type, fields: row.value, topics: row.topics },
          Number(row.ledger),
          null,
        );
      }
      return rows.length;
    });
  }
}

export function eventOrder(a: ChainEvent, b: ChainEvent): number {
  return (
    a.ledger - b.ledger ||
    a.txIndex - b.txIndex ||
    a.opIndex - b.opIndex ||
    a.eventIndex - b.eventIndex
  );
}

/** Ledgers close about every 5 seconds: 720 is about an hour. */
export const MAX_INDEXER_STALENESS_LEDGERS = 720;

export interface ArchiveCoverage {
  startLedger: number | null;
  cursor: number | null;
  /** Ledgers in [startLedger, cursor] the archive does not cover (INV-8). */
  holes: [number, number][];
  /** True when the archive covers start..cursor without a hole and the cursor is recent. */
  complete: boolean;
}

/**
 * Whether the event archive can stand for "every event so far": it covers
 * every ledger from the contract's start ledger to the cursor without a
 * hole, and the cursor is within MAX_INDEXER_STALENESS_LEDGERS of the
 * network. The cursor alone proves neither (it can move past a hole).
 */
export async function archiveCoverage(
  db: Queryable,
  contractId: string,
  latestLedger: number,
): Promise<ArchiveCoverage> {
  const cursor = await db.query<{ start_ledger: string; cursor_ledger: string }>(
    'SELECT start_ledger, cursor_ledger FROM indexer_cursors WHERE contract_id = $1',
    [contractId],
  );
  const row = cursor.rows[0];
  if (row === undefined) return { startLedger: null, cursor: null, holes: [], complete: false };
  const start = Number(row.start_ledger);
  const through = Number(row.cursor_ledger);
  const ranges = await db.query<{ from_ledger: string; to_ledger: string }>(
    'SELECT from_ledger, to_ledger FROM indexed_ranges WHERE contract_id = $1',
    [contractId],
  );
  const holes = findHoles(
    ranges.rows.map((r): [number, number] => [Number(r.from_ledger), Number(r.to_ledger)]),
    start,
    through,
  );
  return {
    startLedger: start,
    cursor: through,
    holes,
    complete: holes.length === 0 && latestLedger - through <= MAX_INDEXER_STALENESS_LEDGERS,
  };
}

/** Ranges [from, to] not covered by `ranges` within [start, end]. */
export function findHoles(
  ranges: readonly [number, number][],
  start: number,
  end: number,
): [number, number][] {
  const holes: [number, number][] = [];
  let next = start;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from > next) holes.push([next, Math.min(from - 1, end)]);
    next = Math.max(next, to + 1);
    if (next > end) break;
  }
  if (next <= end) holes.push([next, end]);
  return holes.filter(([a, b]) => a <= b);
}

/**
 * Applies one archived event to the projections, in emission order (a
 * partial operation's `split` comes before its own event). `alerts` is null
 * during a rebuild, which must not page again for old events.
 */
export async function applyEvent(
  db: Queryable,
  contractId: string,
  event: DecodedEvent,
  ledger: number,
  alerts: AlertService | null,
): Promise<void> {
  const f = event.fields;
  switch (event.name) {
    case 'minted':
      await db.query(
        `INSERT INTO chain_receipts (contract_id, receipt_id, parent_id, warehouse_symbol,
                                     deposit_no, deposit_id, owner, status, weight_kg, bag_count,
                                     initial_weight_kg, weight_source, anchor_day, leaf_hash,
                                     minted_ledger, minted_at, last_event_ledger)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'Active', $7, $8, $7, $9, $10, $11, $12, $13, $12)`,
        [
          contractId,
          str(f.receipt_id),
          str(f.warehouse_id),
          str(f.deposit_no),
          str(f.deposit_id),
          str(f.owner),
          str(f.weight_kg),
          Number(f.bag_count),
          enumName(f.weight_source),
          Number(f.anchor_day),
          str(f.leaf_hash),
          ledger,
          str(f.minted_at),
        ],
      );
      return;
    case 'split':
      await db.query(
        `UPDATE chain_receipts SET weight_kg = $3, bag_count = $4, last_event_ledger = $5
          WHERE contract_id = $1 AND receipt_id = $2`,
        [
          contractId,
          str(f.parent_id),
          str(f.remainder_weight_kg ?? f.remaining_weight_kg),
          Number(f.remainder_bag_count ?? f.remaining_bag_count),
          ledger,
        ],
      );
      await db.query(
        `INSERT INTO chain_receipts (contract_id, receipt_id, parent_id, warehouse_symbol,
                                     deposit_no, deposit_id, owner, status, weight_kg, bag_count,
                                     initial_weight_kg, weight_source, lender, loan_ref,
                                     anchor_day, leaf_hash, last_event_ledger)
         SELECT contract_id, $3, receipt_id, warehouse_symbol, deposit_no, deposit_id,
                COALESCE($4, owner), COALESCE(NULLIF($5, ''), status), $6,
                $7, $6, weight_source, COALESCE($8, lender), loan_ref, anchor_day, leaf_hash, $9
           FROM chain_receipts WHERE contract_id = $1 AND receipt_id = $2`,
        [
          contractId,
          str(f.parent_id),
          str(f.taken_id),
          str(f.owner),
          enumName(f.status),
          str(f.taken_weight_kg),
          Number(f.taken_bag_count),
          str(f.lender),
          ledger,
        ],
      );
      return;
    case 'exited':
    case 'revoked':
      await setStatus(
        db,
        contractId,
        f.receipt_id,
        event.name === 'exited' ? 'Exited' : 'Revoked',
        ledger,
      );
      return;
    case 'locked':
      await db.query(
        `UPDATE chain_receipts SET status = 'Locked', lender = $3, loan_ref = $4, last_event_ledger = $5
          WHERE contract_id = $1 AND receipt_id = $2`,
        [contractId, str(f.receipt_id), str(f.lender), str(f.loan_ref), ledger],
      );
      return;
    case 'unlocked':
      await db.query(
        `UPDATE chain_receipts SET status = 'Active', lender = NULL, loan_ref = NULL,
                last_event_ledger = $3
          WHERE contract_id = $1 AND receipt_id = $2`,
        [contractId, str(f.receipt_id), ledger],
      );
      return;
    case 'recovery_started':
      await setStatus(db, contractId, f.receipt_id, 'Recovery', ledger);
      return;
    case 'recovery_completed':
      await db.query(
        `UPDATE chain_receipts SET status = 'Active', owner = $3, lender = NULL, loan_ref = NULL,
                last_event_ledger = $4
          WHERE contract_id = $1 AND receipt_id = $2`,
        [contractId, str(f.receipt_id), str(f.buyer), ledger],
      );
      return;
    case 'anchored':
      await db.query(
        `INSERT INTO chain_anchors (contract_id, warehouse_symbol, day, leaves, root, prev_head, head,
                                    custodian, anchored_at, ledger)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          contractId,
          str(f.warehouse_id),
          Number(f.day),
          Number(f.leaves),
          str(f.root),
          str(f.prev_head),
          str(f.head),
          str(f.custodian),
          str(f.anchored_at) ?? '0',
          ledger,
        ],
      );
      return;
    case 'warehouse_added':
    case 'warehouse_removed':
      await registry(
        db,
        contractId,
        'warehouse',
        str(f.warehouse_id) ?? '',
        '',
        event.name.endsWith('added'),
        ledger,
      );
      return;
    case 'custodian_added':
    case 'custodian_removed':
      await registry(
        db,
        contractId,
        'custodian',
        str(f.warehouse_id) ?? '',
        str(f.custodian) ?? '',
        event.name.endsWith('added'),
        ledger,
      );
      return;
    case 'verifier_added':
    case 'verifier_removed':
      await registry(
        db,
        contractId,
        'verifier',
        '',
        str(f.verifier) ?? '',
        event.name.endsWith('added'),
        ledger,
      );
      return;
    case 'recovery_operator_added':
    case 'recovery_operator_removed':
      await registry(
        db,
        contractId,
        'recovery_operator',
        '',
        str(f.operator) ?? '',
        event.name.endsWith('added'),
        ledger,
      );
      return;
    case 'preclaimed':
      // events.md: no cutover is built, so the indexer should expect none.
      await alerts?.raise({
        key: `preclaimed_event:${contractId}:${str(f.warehouse_id)}`,
        severity: 'page',
        category: 'indexer',
        message: `A preclaimed event appeared for ${str(f.warehouse_id)}; no cutover exists, so none was expected`,
        details: { deposit_no: f.deposit_no ?? null, ledger },
      });
      return;
    case 'ttl_extended':
    case 'due_extended':
    case 'settlement_recorded':
    case 'mint_proposed':
    case 'lock_offered':
      return;
    default:
      await alerts?.raise({
        key: `unknown_event:${contractId}:${event.name}`,
        severity: 'page',
        category: 'indexer',
        message: `Event "${event.name}" is not in docs/events.md; it is archived but not applied`,
        details: { ledger },
      });
  }
}

async function setStatus(
  db: Queryable,
  contractId: string,
  receiptId: Json | undefined,
  status: string,
  ledger: number,
): Promise<void> {
  await db.query(
    `UPDATE chain_receipts SET status = $3, last_event_ledger = $4
      WHERE contract_id = $1 AND receipt_id = $2`,
    [contractId, str(receiptId), status, ledger],
  );
}

async function registry(
  db: Queryable,
  contractId: string,
  role: string,
  warehouse: string,
  address: string,
  active: boolean,
  ledger: number,
): Promise<void> {
  await db.query(
    `INSERT INTO chain_registry (contract_id, role, warehouse_symbol, address, active, last_event_ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contract_id, role, warehouse_symbol, address)
       DO UPDATE SET active = EXCLUDED.active, last_event_ledger = EXCLUDED.last_event_ledger`,
    [contractId, role, warehouse, address, active, ledger],
  );
}
