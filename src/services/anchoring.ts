import { randomBytes } from 'node:crypto';

import type pg from 'pg';

import { addressFor, subjectOf } from '../chain/addresses.js';
import { ContractCallError, ContractError, type ChainClient } from '../chain/chainClient.js';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import {
  checkDay,
  chainSymbol,
  cutoffOf,
  endOfDaySeconds,
  unixSeconds,
  utcDay,
  warehouseSymbol,
  type DayMovement,
  type LotTotals,
} from '../domain/book.js';
import {
  buildTree,
  compareEntries,
  entryHash,
  nextHead,
  ZERO_HEAD,
  type BookEntryJson,
  type BookRecordJson,
  type LeafJson,
} from '../domain/merkle.js';
import type { KeyService } from '../keys/keyService.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alerts.js';
import {
  lockBookExclusive,
  lotIdentity,
  SCALE_WEIGHED_SQL,
  unbookedLotMovements,
  writeBookEntries,
} from './book.js';
import { chainHalted } from './chainDeployment.js';
import { archiveCoverage } from './indexer.js';

const HOUR_MS = 60 * 60 * 1000;
/**
 * backend-requirements §3, and the kit's I5: a day not anchored 2 h after
 * its cutoff is urgent (nothing in the warehouse can mint), escalated at
 * 24 h, and a warehouse 7 days without an anchor is urgent on its own.
 */
export const ANCHOR_URGENT_AFTER_MS = 2 * HOUR_MS;
export const ANCHOR_ESCALATE_AFTER_MS = 24 * HOUR_MS;
export const NO_ANCHOR_URGENT_DAYS = 7;
/** While a day is due and unanchored, anchoring is retried at most this often. */
export const ANCHOR_RETRY_EVERY_MS = HOUR_MS;
const RETRY_JOB = 'anchor_retry';

export interface DayReport {
  warehouseId: string;
  day: number;
  closed: 'built' | 'already' | 'failed';
  anchored: boolean;
  leaves: number | null;
  /** The day had no entries and was closed with a sentinel leaf. */
  sentinel?: boolean;
  error?: string;
}

interface EntryRow {
  id: string;
  entry_type: 'leaf' | 'record';
  kind: number | null;
  record_kind: string | null;
  deposit_no: string;
  content:
    Omit<LeafJson, 'day' | 'index' | 'salt'> | Omit<BookRecordJson, 'day' | 'index' | 'salt'>;
  salt: Buffer;
  source: string;
}

/**
 * The daily anchoring job (backend-requirements §3). Per warehouse, per UTC
 * day whose cutoff has passed, strictly in order:
 *
 * 1. **close the day** (`closeDay`): take the book lock exclusively, add a
 *    balance leaf for every lot holding stock, order and index every entry,
 *    build the tree and proofs, run the INV-3 / INV-4 checks, and persist
 *    every leaf, salt, proof and the root, all in one transaction. A day
 *    with no entries gets one sentinel leaf, so no day is ever skipped
 *    (protocol #7);
 * 2. **anchor it** (`anchorDay`): only once the contract's head equals the
 *    head we hold, submit `anchor`, and record the day as anchored only when
 *    `get_anchor` returns the head computed here.
 */
/**
 * The UTC day the contract registered a warehouse: its first archived
 * warehouse_added, by the contract's own clock (`added_at` is the ledger
 * timestamp, the clock `anchor` checks days against). Null if none is
 * archived. `contract` is the SQL parameter holding the contract id.
 */
const ONCHAIN_START_DAY = (code: string, contract = '$1') =>
  `(SELECT (min((e.value->>'added_at')::bigint) / 86400)::int FROM events_archive e
     WHERE e.contract_id = ${contract} AND e.event_type = 'warehouse_added'
       AND e.topics->>1 = replace(${code}, '-', '_'))`;

export class AnchoringService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: ChainClient,
    private readonly keys: KeyService,
    private readonly alerts: AlertService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Closes and anchors every day due, for every warehouse, then checks for missed anchors. */
  async runDaily(): Promise<DayReport[]> {
    const reports: DayReport[] = [];
    // Every registered warehouse, active or not, from the day the contract
    // registered it: a warehouse's first anchor must not be ambiguous
    // between "new" and "operating unrecorded" (INV-5, D53).
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM warehouses ORDER BY id');
    for (const { id } of rows) reports.push(...(await this.runWarehouse(id)));
    await this.checkMissedAnchors();
    return reports;
  }

  async runWarehouse(warehouseId: string): Promise<DayReport[]> {
    const reports: DayReport[] = [];
    const lastDue = utcDay(this.clock()) - 1;
    // Earlier days closed but not yet anchored go first, in order.
    for (const day of await this.unanchoredDays(warehouseId)) {
      const anchored = await this.tryAnchor(warehouseId, day);
      reports.push({
        warehouseId,
        day,
        closed: 'already',
        anchored: anchored.ok,
        leaves: null,
        ...(anchored.error ? { error: anchored.error } : {}),
      });
      if (!anchored.ok) return reports;
    }
    const first = await this.nextDayToClose(warehouseId);
    if (first === null) return reports;
    for (let day = first; day <= lastDue; day++) {
      let closed: { leaves: number; sentinel: boolean };
      try {
        closed = await this.closeDay(warehouseId, day);
      } catch (err) {
        reports.push({
          warehouseId,
          day,
          closed: 'failed',
          anchored: false,
          leaves: null,
          error: errText(err),
        });
        return reports;
      }
      const anchored = await this.tryAnchor(warehouseId, day);
      reports.push({
        warehouseId,
        day,
        closed: 'built',
        anchored: anchored.ok,
        leaves: closed.leaves,
        ...(closed.sentinel ? { sentinel: true } : {}),
        ...(anchored.error ? { error: anchored.error } : {}),
      });
      if (!anchored.ok) return reports;
    }
    return reports;
  }

  /**
   * The hourly retry, run from the 5-minute index job: while any warehouse
   * has a day whose cutoff has passed and that is not anchored, anchors
   * again, at most once per ANCHOR_RETRY_EVERY_MS across all
   * processes (claimed in job_runs). Returns whether it ran.
   */
  async retryIfDue(): Promise<boolean> {
    if (!this.chain.enabled || !(await this.hasDueDays())) return false;
    const now = this.clock();
    const claimed = await this.pool.query(
      `INSERT INTO job_runs (job, last_started_at) VALUES ($1, $2)
       ON CONFLICT (job) DO UPDATE SET last_started_at = EXCLUDED.last_started_at
         WHERE job_runs.last_started_at <= EXCLUDED.last_started_at - $3 * interval '1 millisecond'
       RETURNING job`,
      [RETRY_JOB, now, ANCHOR_RETRY_EVERY_MS],
    );
    if ((claimed.rowCount ?? 0) === 0) return false;
    await this.runDaily();
    return true;
  }

  /**
   * True if some warehouse's latest due day is not anchored on this
   * contract. (Days closed 'empty' before sentinels existed are history.)
   */
  private async hasDueDays(): Promise<boolean> {
    const lastDue = utcDay(this.clock()) - 1;
    const { rows } = await this.pool.query<{ due: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM (SELECT id AS warehouse_id, code FROM warehouses) w
          WHERE COALESCE((SELECT min(day) FROM book_days b WHERE b.warehouse_id = w.warehouse_id),
                         ${ONCHAIN_START_DAY('w.code')}) <= $2
            AND NOT EXISTS (SELECT 1 FROM book_anchors a WHERE a.contract_id = $1
                               AND a.warehouse_id = w.warehouse_id AND a.day = $2)
            AND NOT EXISTS (SELECT 1 FROM book_days b WHERE b.warehouse_id = w.warehouse_id
                               AND b.day = $2 AND b.status = 'empty')) AS due`,
      [this.chain.contractId, lastDue],
    );
    return rows[0]?.due === true;
  }

  /**
   * The next day to close: the day after the last closed, else the day the
   * contract registered the warehouse (its first archived warehouse_added).
   * Null while the contract has not registered it: nothing is closed then,
   * and checkMissedAnchors pages.
   */
  async nextDayToClose(warehouseId: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ last: number | null; registered: number | null }>(
      `SELECT (SELECT max(day) FROM book_days WHERE warehouse_id = w.id) AS last,
              ${ONCHAIN_START_DAY('w.code', '$2')} AS registered
         FROM warehouses w WHERE w.id = $1`,
      [warehouseId, this.chain.contractId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`warehouse ${warehouseId} does not exist`);
    if (row.last !== null) return row.last + 1;
    return row.registered;
  }

  private async unanchoredDays(warehouseId: string): Promise<number[]> {
    if (!this.chain.enabled) return [];
    const { rows } = await this.pool.query<{ day: number }>(
      `SELECT b.day FROM book_days b
        WHERE b.warehouse_id = $1 AND b.status = 'built'
          AND NOT EXISTS (SELECT 1 FROM book_anchors a WHERE a.contract_id = $2
                             AND a.warehouse_id = b.warehouse_id AND a.day = b.day)
        ORDER BY b.day`,
      [warehouseId, this.chain.contractId],
    );
    return rows.map((row) => row.day);
  }

  private async tryAnchor(
    warehouseId: string,
    day: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.chain.enabled) return { ok: false, error: 'CHAIN_ENABLED=false: not anchored' };
    try {
      await this.anchorDay(warehouseId, day);
      return { ok: true };
    } catch (err) {
      this.logger.error({ err, warehouseId, day }, 'anchor failed');
      return { ok: false, error: errText(err) };
    }
  }

  /**
   * Closes `day` for the warehouse: the tree over every entry recorded
   * before its cutoff and not in an earlier day, plus a balance leaf per lot
   * holding stock at the cutoff; or, when there is none of either, one
   * sentinel leaf. Refuses (and pages) on any INV-3 / INV-4 problem;
   * nothing is written then.
   */
  async closeDay(
    warehouseId: string,
    day: number,
  ): Promise<{ status: 'built'; leaves: number; root: Buffer; sentinel: boolean }> {
    const cutoff = cutoffOf(day);
    if (cutoff.getTime() > this.clock().getTime()) {
      throw new Error(`day ${day} has not reached its cutoff ${cutoff.toISOString()}`);
    }
    try {
      return await withTransaction(this.pool, async (client) => {
        await lockBookExclusive(client, warehouseId);
        const last = await client.query<{ day: number | null }>(
          'SELECT max(day) AS day FROM book_days WHERE warehouse_id = $1',
          [warehouseId],
        );
        const lastDay = last.rows[0]?.day ?? null;
        if (lastDay !== null && day !== lastDay + 1) {
          throw new Error(`INV-5: day ${lastDay + 1} closes before day ${day}`);
        }

        // Every lot movement recorded before the cutoff has its entry
        // (rows written before the book existed get theirs now).
        await writeBookEntries(
          client,
          this.keys,
          await unbookedLotMovements(client, warehouseId, cutoff),
        );
        const movements = await client.query<EntryRow>(
          `SELECT b.id, b.entry_type, b.kind, b.record_kind, b.deposit_no, b.content, b.salt,
                  COALESCE(sm.dispatch_id::text, b.deposit_id) AS source
             FROM book_entries b
             JOIN lot_movements lm ON lm.id = b.lot_movement_id
             JOIN stock_movements sm ON sm.id = lm.stock_movement_id
            WHERE b.warehouse_id = $1 AND b.day IS NULL AND b.recorded_at < $2`,
          [warehouseId, cutoff],
        );
        const balances = await this.balanceEntries(client, warehouseId, day, cutoff);
        let entries = [...movements.rows, ...balances];
        const sentinel = entries.length === 0;
        if (sentinel) entries = [await this.sentinelEntry(client, warehouseId, cutoff)];

        // A record's source id is the one it commits to (protocol #8).
        const ordered = entries
          .map((row) => ({
            row,
            entry: row.content,
            sourceId: 'record' in row.content ? row.content.source_id : row.source,
          }))
          .sort(compareEntries);
        const placed = ordered.map(({ row }, index) => {
          const json = {
            ...row.content,
            day,
            index,
            salt: row.salt.toString('hex'),
          } as BookEntryJson;
          return { row, json, hash: entryHash(json) };
        });
        const tree = buildTree(placed.map((p) => p.hash));

        const problems = checkDay(await this.dayCheckInput(client, warehouseId, lastDay, placed));
        if (problems.length > 0) throw new BookCheckError(problems);

        await client.query(
          `INSERT INTO book_days (warehouse_id, day, status, leaves, root, built_at)
           VALUES ($1, $2, 'built', $3, $4, $5)`,
          [warehouseId, day, placed.length, tree.root, this.clock()],
        );
        for (const [index, p] of placed.entries()) {
          const proof = JSON.stringify((tree.proofs[index] ?? []).map((s) => s.toString('hex')));
          if (p.row.kind === 3) {
            await client.query(
              `INSERT INTO book_entries (id, warehouse_id, entry_type, kind, deposit_id, deposit_no,
                                         farmer_id, content, salt, recorded_at, day, idx,
                                         leaf_hash, proof)
               VALUES ($1, $2, 'leaf', 3, NULL, 0, NULL, $3, $4, $5, $6, $7, $8, $9)`,
              [
                p.row.id,
                warehouseId,
                JSON.stringify(p.row.content),
                p.row.salt,
                new Date(endOfDaySeconds(day) * 1000),
                day,
                index,
                p.hash,
                proof,
              ],
            );
          } else if (p.row.kind === 2) {
            await client.query(
              `INSERT INTO book_entries (id, warehouse_id, entry_type, kind, deposit_id, deposit_no,
                                         farmer_id, content, salt, recorded_at, day, idx,
                                         leaf_hash, proof)
               SELECT $1, $2, 'leaf', 2, deposit_id, deposit_no, farmer_id, $3, $4, $5, $6, $7,
                      $8, $9
                 FROM deposits WHERE deposit_no = $10 AND warehouse_id = $2`,
              [
                p.row.id,
                warehouseId,
                JSON.stringify(p.row.content),
                p.row.salt,
                new Date(endOfDaySeconds(day) * 1000),
                day,
                index,
                p.hash,
                proof,
                p.row.deposit_no,
              ],
            );
          } else {
            await client.query(
              `UPDATE book_entries SET day = $2, idx = $3, leaf_hash = $4, proof = $5
                WHERE id = $1 AND day IS NULL`,
              [p.row.id, day, index, p.hash, proof],
            );
          }
        }
        await this.alerts.resolve(`book_check_failed:${warehouseId}:${day}`);
        return { status: 'built' as const, leaves: placed.length, root: tree.root, sentinel };
      });
    } catch (err) {
      if (err instanceof BookCheckError) {
        await this.alerts.raise({
          key: `book_check_failed:${warehouseId}:${day}`,
          severity: 'page',
          category: 'anchoring',
          message: `Day ${day} of warehouse ${warehouseId} was not closed: its books fail INV-3/INV-4`,
          details: { problems: err.problems },
        });
      }
      throw err;
    }
  }

  /**
   * The empty-day sentinel (kind 3, protocol #7): the day's only leaf. Its
   * owner, custodian and verifier are the custodian who will submit the
   * anchor, so someone is accountable for declaring the day empty. It
   * belongs to no lot, so it can never mint (`WrongLeafKind`).
   */
  private async sentinelEntry(
    client: pg.ClientBase,
    warehouseId: string,
    cutoff: Date,
  ): Promise<EntryRow> {
    const { rows } = await client.query<{ code: string }>(
      'SELECT code FROM warehouses WHERE id = $1',
      [warehouseId],
    );
    const symbol = warehouseSymbol(rows[0]?.code ?? '');
    const custodian = await addressFor(
      this.keys,
      await this.anchoringCustodian(warehouseId, symbol),
    );
    const content: Omit<LeafJson, 'day' | 'index' | 'salt'> = {
      version: 1,
      kind: 3,
      warehouse_id: symbol,
      deposit_no: 0,
      deposit_id: '',
      receipt_id: 0,
      receipt_version: 0,
      owner: custodian,
      commodity: 'NONE',
      grade: 'NONE',
      kg: 0,
      weight_source: 'BagEstimate',
      bags: 0,
      moisture_bps: 0,
      custodian,
      verifier: custodian,
      deposited_at: unixSeconds(cutoff),
      at: unixSeconds(cutoff),
    };
    return {
      id: crypto.randomUUID(),
      entry_type: 'leaf',
      kind: 3,
      record_kind: null,
      deposit_no: '0',
      content,
      salt: randomBytes(32),
      source: '',
    };
  }

  /** A balance leaf (kind 2) for every lot holding stock at the cutoff, salted now. */
  private async balanceEntries(
    client: pg.ClientBase,
    warehouseId: string,
    day: number,
    cutoff: Date,
  ): Promise<EntryRow[]> {
    const { rows } = await client.query<{
      deposit_id: string;
      deposit_no: string;
      warehouse_code: string;
      farmer_id: string;
      custodian_id: string;
      verifier_id: string;
      commodity: string;
      grade: string;
      moisture_bps: number;
      intake_at: Date;
      chain_receipt_id: string | null;
      scale_weighed: boolean;
      bags: string;
      book_kg: string;
      kg: string;
    }>(
      `SELECT d.deposit_id, d.deposit_no, w.code AS warehouse_code, d.farmer_id, d.custodian_id,
              d.verifier_id, d.commodity, d.grade, d.moisture_bps, d.intake_at,
              CASE WHEN d.status = 'minted' THEN d.chain_receipt_id END AS chain_receipt_id,
              ${SCALE_WEIGHED_SQL('d')} AS scale_weighed,
              sum(lm.bags_delta) AS bags, sum(lm.book_kg_delta) AS book_kg, sum(lm.kg_delta) AS kg
         FROM lot_movements lm
         JOIN deposits d ON d.deposit_id = lm.deposit_id
         JOIN warehouses w ON w.id = d.warehouse_id
        WHERE d.warehouse_id = $1 AND lm.recorded_at < $2
        GROUP BY d.id, w.code
       HAVING sum(lm.bags_delta) > 0 OR sum(lm.kg_delta) > 0
        ORDER BY d.deposit_no`,
      [warehouseId, cutoff],
    );
    const out: EntryRow[] = [];
    for (const row of rows) {
      const id = await lotIdentity(this.keys, row);
      const receiptId = row.chain_receipt_id === null ? 0 : Number(row.chain_receipt_id);
      const content: Omit<LeafJson, 'day' | 'index' | 'salt'> = {
        version: 1,
        kind: 2,
        warehouse_id: id.warehouseSymbol,
        deposit_no: Number(row.deposit_no),
        deposit_id: row.deposit_id,
        receipt_id: receiptId,
        receipt_version: receiptId === 0 ? 0 : 3,
        owner: id.owner,
        commodity: chainSymbol(row.commodity, 'commodity'),
        grade: chainSymbol(row.grade, 'grade'),
        kg: Number(row.book_kg),
        weight_source: row.scale_weighed ? 'Scale' : 'BagEstimate',
        bags: Number(row.bags),
        moisture_bps: row.moisture_bps,
        custodian: id.custodian,
        verifier: id.verifier,
        deposited_at: Math.floor(row.intake_at.getTime() / 1000),
        at: endOfDaySeconds(day),
      };
      out.push({
        id: crypto.randomUUID(),
        entry_type: 'leaf',
        kind: 2,
        record_kind: null,
        deposit_no: row.deposit_no,
        content,
        salt: randomBytes(32),
        source: row.deposit_id,
      });
    }
    return out;
  }

  private async dayCheckInput(
    client: pg.ClientBase,
    warehouseId: string,
    lastDay: number | null,
    placed: readonly { row: EntryRow; json: BookEntryJson }[],
  ) {
    const previous = new Map<number, LotTotals>();
    let lastDepositNo = 0;
    if (lastDay !== null) {
      const prev = await client.query<{ deposit_no: string; bags: number; kg: string }>(
        `SELECT deposit_no, (content->>'bags')::int AS bags, (content->>'kg')::bigint AS kg
           FROM book_entries
          WHERE warehouse_id = $1 AND kind = 2
            AND day = (SELECT max(day) FROM book_days WHERE warehouse_id = $1 AND status = 'built')`,
        [warehouseId],
      );
      for (const row of prev.rows) {
        previous.set(Number(row.deposit_no), { bags: row.bags, kg: Number(row.kg) });
      }
      const maxNo = await client.query<{ n: string | null }>(
        `SELECT max(deposit_no) AS n FROM book_entries
          WHERE warehouse_id = $1 AND kind = 0 AND day IS NOT NULL`,
        [warehouseId],
      );
      lastDepositNo = Number(maxNo.rows[0]?.n ?? 0);
    }
    const movements: DayMovement[] = [];
    const balances = new Map<number, LotTotals>();
    let sentinels = 0;
    for (const { row, json } of placed) {
      const depositNo = Number(row.deposit_no);
      if (!('record' in json) && json.kind === 3) {
        sentinels++;
      } else if ('record' in json) {
        movements.push({
          depositNo,
          isDeposit: false,
          bagsDelta: json.bags_delta,
          kgDelta: json.kg_delta,
        });
      } else if (json.kind === 2) {
        balances.set(depositNo, { bags: json.bags, kg: json.kg });
      } else {
        const sign = json.kind === 0 ? 1 : -1;
        movements.push({
          depositNo,
          isDeposit: json.kind === 0,
          bagsDelta: sign * json.bags,
          kgDelta: sign * json.kg,
        });
      }
    }
    return { previous, movements, balances, lastDepositNo, sentinels, entries: placed.length };
  }

  /**
   * Anchors a closed day on the current contract. The contract's head must
   * equal the head of our last anchored day first; afterwards the day counts
   * as anchored only once `get_anchor` returns the head computed here.
   */
  async anchorDay(warehouseId: string, day: number): Promise<{ head: Buffer; ledger: number }> {
    if (await chainHalted(this.pool)) {
      throw new Error('chain writers are halted: a Testnet reset is unresolved');
    }
    const contractId = this.chain.contractId;
    const { rows } = await this.pool.query<{ leaves: number; root: Buffer; code: string }>(
      `SELECT b.leaves, b.root, w.code FROM book_days b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.warehouse_id = $1 AND b.day = $2 AND b.status = 'built'`,
      [warehouseId, day],
    );
    const book = rows[0];
    if (book === undefined) throw new Error(`day ${day} has no built tree`);
    const symbol = warehouseSymbol(book.code);

    const prior = await this.pool.query<{ day: number; head: Buffer }>(
      `SELECT day, head FROM book_anchors WHERE contract_id = $1 AND warehouse_id = $2
        ORDER BY day DESC LIMIT 1`,
      [contractId, warehouseId],
    );
    const prevHead = prior.rows[0]?.head ?? ZERO_HEAD;
    const head = nextHead(prevHead, day, book.leaves, book.root);
    const subject = `anchor:${warehouseId}:${day}`;

    const onChain = await this.chain.getAnchor(symbol);
    if (onChain !== null && onChain.day === day && onChain.head.equals(head)) {
      // Landed earlier (e.g. a crash after submission): record it now.
      return this.recordAnchor(warehouseId, day, prevHead, head, subject);
    }
    const expectedPrev = prior.rows[0] === undefined ? null : prior.rows[0];
    const consistent =
      (onChain === null && expectedPrev === null) ||
      (onChain !== null && expectedPrev !== null && onChain.head.equals(expectedPrev.head));
    if (!consistent) {
      await this.alerts.raise({
        key: `anchor_head_mismatch:${warehouseId}`,
        severity: 'urgent',
        category: 'anchoring',
        message: `The contract's head for ${symbol} is not the head of our last anchored day; anchoring stopped`,
        details: {
          on_chain_day: onChain?.day ?? null,
          on_chain_head: onChain?.head.toString('hex') ?? null,
          our_day: expectedPrev?.day ?? null,
          our_head: expectedPrev?.head.toString('hex') ?? null,
        },
      });
      throw new Error(`head mismatch for ${symbol}; anchoring stopped`);
    }

    // A transaction recorded for this day but unresolved is looked up, never resent blindly.
    const pending = await this.pool.query<{ id: string }>(
      `SELECT id FROM chain_transactions WHERE subject = $1 AND contract_id = $2
          AND status IN ('signed', 'submitted') ORDER BY created_at DESC LIMIT 1`,
      [subject, contractId],
    );
    let outcome;
    if (pending.rows[0] !== undefined) {
      outcome = await this.chain.resolve(this.pool, pending.rows[0].id);
    } else {
      const custodianSubject = await this.anchoringCustodian(
        warehouseId,
        symbol,
        await this.sentinelCustodian(warehouseId, day),
      );
      try {
        outcome = await this.chain.anchor(this.pool, {
          custodianSubject,
          warehouseSymbol: symbol,
          day,
          root: book.root,
          leaves: book.leaves,
          subject,
        });
      } catch (err) {
        if (err instanceof ContractCallError) {
          await this.alerts.raise({
            key: `anchor_refused:${warehouseId}:${day}`,
            severity: err.contractError === ContractError.AnchorOutOfOrder ? 'urgent' : 'page',
            category: 'anchoring',
            message: `The contract refused the anchor for ${symbol} day ${day}: ${err.message}`,
            details: { contract_error: err.contractError },
          });
        }
        throw err;
      }
    }
    if (outcome.status !== 'success') {
      throw new Error(
        `anchor for ${symbol} day ${day} is ${outcome.status}: ${outcome.error ?? ''}`,
      );
    }
    const after = await this.chain.getAnchor(symbol);
    if (after === null || after.day !== day || !after.head.equals(head)) {
      await this.alerts.raise({
        key: `anchor_head_mismatch:${warehouseId}`,
        severity: 'urgent',
        category: 'anchoring',
        message: `After anchoring ${symbol} day ${day}, get_anchor does not return the head computed here`,
        details: { expected: head.toString('hex'), got: after?.head.toString('hex') ?? null },
      });
      throw new Error(`get_anchor disagrees after anchoring ${symbol} day ${day}`);
    }
    return this.recordAnchor(warehouseId, day, prevHead, head, subject);
  }

  private async recordAnchor(
    warehouseId: string,
    day: number,
    prevHead: Buffer,
    head: Buffer,
    subject: string,
  ): Promise<{ head: Buffer; ledger: number }> {
    const tx = await this.pool.query<{ id: string; ledger: string | null }>(
      `SELECT id, ledger FROM chain_transactions WHERE subject = $1 AND contract_id = $2
          AND status = 'success' ORDER BY created_at DESC LIMIT 1`,
      [subject, this.chain.contractId],
    );
    const ledger =
      tx.rows[0]?.ledger === null || tx.rows[0] === undefined
        ? (await this.chain.latestLedger()).sequence
        : Number(tx.rows[0].ledger);
    await this.pool.query(
      `INSERT INTO book_anchors (contract_id, warehouse_id, day, prev_head, head,
                                 chain_transaction_id, anchored_ledger, anchored_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        this.chain.contractId,
        warehouseId,
        day,
        prevHead,
        head,
        tx.rows[0]?.id ?? null,
        ledger,
        this.clock(),
      ],
    );
    for (const key of [
      `anchor_missed:${warehouseId}:${day}`,
      `anchor_missed_escalated:${warehouseId}:${day}`,
      `anchor_refused:${warehouseId}:${day}`,
      `no_anchor_7d:${warehouseId}`,
    ]) {
      await this.alerts.resolve(key);
    }
    this.logger.info({ warehouseId, day, head: head.toString('hex'), ledger }, 'day anchored');
    return { head, ledger };
  }

  /** The custodian address a sentinel day declared empty, if the day is one. */
  private async sentinelCustodian(warehouseId: string, day: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ custodian: string }>(
      `SELECT content->>'custodian' AS custodian FROM book_entries
        WHERE warehouse_id = $1 AND day = $2 AND kind = 3`,
      [warehouseId, day],
    );
    return rows[0]?.custodian ?? null;
  }

  /**
   * The custodian who signs the warehouse's anchor: for a sentinel day, the
   * one the sentinel names, while still active; otherwise a custodian
   * registered on-chain (per the indexer), else the first active one.
   */
  private async anchoringCustodian(
    warehouseId: string,
    symbol: string,
    sentinelAddress: string | null = null,
  ): Promise<string> {
    const custodians = await this.pool.query<{ id: string }>(
      `SELECT id FROM custodians WHERE warehouse_id = $1 AND status = 'active' ORDER BY created_at, id`,
      [warehouseId],
    );
    if (custodians.rows.length === 0)
      throw new Error(`warehouse ${warehouseId} has no active custodian`);
    const registered = await this.pool.query<{ address: string }>(
      `SELECT address FROM chain_registry WHERE contract_id = $1 AND role = 'custodian'
          AND warehouse_symbol = $2 AND active`,
      [this.chain.contractId, symbol],
    );
    const onChain = new Set(registered.rows.map((row) => row.address));
    if (sentinelAddress !== null) {
      for (const { id } of custodians.rows) {
        if ((await addressFor(this.keys, subjectOf.custodian(id))) === sentinelAddress) {
          return subjectOf.custodian(id);
        }
      }
      // The day is already closed; it must still be anchored, by someone else.
      await this.alerts.raise({
        key: `sentinel_custodian_gone:${warehouseId}`,
        severity: 'warning',
        category: 'anchoring',
        message: `The custodian who declared a day of ${symbol} empty is no longer active; another custodian signs its anchor`,
        details: { sentinel_custodian: sentinelAddress },
      });
    }
    for (const { id } of custodians.rows) {
      if (onChain.has(await addressFor(this.keys, subjectOf.custodian(id)))) {
        return subjectOf.custodian(id);
      }
    }
    return subjectOf.custodian(custodians.rows[0]?.id ?? '');
  }

  /**
   * INV-5 alerts, run from the 5-minute index job as well as the daily
   * anchor run: urgent when a warehouse's day is not anchored 2 h after its
   * cutoff, a separate escalation at 24 h, and urgent when a warehouse has
   * gone 7 days without an anchor.
   */
  async checkMissedAnchors(): Promise<void> {
    if (!this.chain.enabled) return;
    const now = this.clock();
    // A warehouse's chain starts at its first closed day, else the day the
    // contract registered it. Books started before D53 began at the first
    // movement; the days before cannot be anchored any more and are not
    // reported as missed.
    const { rows } = await this.pool.query<{
      warehouse_id: string;
      code: string;
      created_at: Date;
      first_day: number | null;
    }>(
      `SELECT w.id AS warehouse_id, w.code, w.created_at,
              COALESCE((SELECT min(day) FROM book_days b WHERE b.warehouse_id = w.id),
                       ${ONCHAIN_START_DAY('w.code')}) AS first_day
         FROM warehouses w ORDER BY w.id`,
      [this.chain.contractId],
    );
    let coverage: Promise<boolean> | null = null;
    for (const {
      warehouse_id: warehouseId,
      code,
      created_at: createdAt,
      first_day: firstDay,
    } of rows) {
      if (firstDay === null) {
        coverage ??= this.archiveComplete();
        await this.unregisteredWarehouse(warehouseId, code, createdAt, now, await coverage);
        continue;
      }
      await this.alerts.resolve(`warehouse_not_on_contract:${warehouseId}`);
      await this.alerts.resolve(`warehouse_registration_unknown:${warehouseId}`);
      const anchoredDays = await this.anchoredDays(this.pool, warehouseId);
      const empty = await this.pool.query<{ day: number }>(
        `SELECT day FROM book_days WHERE warehouse_id = $1 AND status = 'empty'`,
        [warehouseId],
      );
      const settled = new Set([...anchoredDays, ...empty.rows.map((r) => r.day)]);
      const lastDue = utcDay(now) - 1;
      for (let day = Math.max(firstDay, lastDue - 30); day <= lastDue; day++) {
        if (settled.has(day)) continue;
        const late = now.getTime() - cutoffOf(day).getTime();
        if (late < ANCHOR_URGENT_AFTER_MS) continue;
        await this.alerts.raise({
          key: `anchor_missed:${warehouseId}:${day}`,
          severity: 'urgent',
          category: 'anchoring',
          message:
            `Warehouse ${warehouseId} day ${day} is not anchored ${Math.floor(late / HOUR_MS)} h after its cutoff; ` +
            'nothing in the warehouse can mint until it is',
          details: { day, hours_late: Math.floor(late / HOUR_MS) },
        });
        if (late >= ANCHOR_ESCALATE_AFTER_MS) {
          // A separate alert, so an on-call integration sees a new event, not an update.
          await this.alerts.raise({
            key: `anchor_missed_escalated:${warehouseId}:${day}`,
            severity: 'urgent',
            category: 'anchoring',
            message: `ESCALATED: warehouse ${warehouseId} day ${day} still not anchored ${Math.floor(late / HOUR_MS)} h after its cutoff`,
            details: { day, hours_late: Math.floor(late / HOUR_MS) },
          });
        }
      }
      const lastAnchored = Math.max(0, ...anchoredDays);
      if (utcDay(now) - (lastAnchored || firstDay) >= NO_ANCHOR_URGENT_DAYS) {
        await this.alerts.raise({
          key: `no_anchor_7d:${warehouseId}`,
          severity: 'urgent',
          category: 'anchoring',
          message: `Warehouse ${warehouseId} has had no anchor for ${NO_ANCHOR_URGENT_DAYS} days or more; its last root expires at 30`,
          details: { last_anchored_day: lastAnchored || null },
        });
      }
    }
  }

  /**
   * A warehouse registered here that the archive shows no warehouse_added
   * for: none of its days is closed, so this is the only signal. Urgent
   * once its first day would have been missed (2 h after the cutoff of the
   * day its row was created). With a complete archive the contract has not
   * registered it; with holes, or an archive behind the network, nobody
   * can tell, and that is urgent too.
   */
  private async unregisteredWarehouse(
    warehouseId: string,
    code: string,
    createdAt: Date,
    now: Date,
    archiveComplete: boolean,
  ): Promise<void> {
    const late = now.getTime() - cutoffOf(utcDay(createdAt)).getTime();
    if (late < ANCHOR_URGENT_AFTER_MS) return;
    const symbol = warehouseSymbol(code);
    if (archiveComplete) {
      await this.alerts.resolve(`warehouse_registration_unknown:${warehouseId}`);
      await this.alerts.raise({
        key: `warehouse_not_on_contract:${warehouseId}`,
        severity: 'urgent',
        category: 'anchoring',
        message:
          `Warehouse ${symbol} is registered here but not on contract ${this.chain.contractId}: ` +
          'its books cannot start until add_warehouse is called',
        details: { symbol, registered_here_at: createdAt.toISOString() },
      });
    } else {
      await this.alerts.resolve(`warehouse_not_on_contract:${warehouseId}`);
      await this.alerts.raise({
        key: `warehouse_registration_unknown:${warehouseId}`,
        severity: 'urgent',
        category: 'anchoring',
        message:
          `Warehouse ${symbol} has no warehouse_added in the event archive, which has holes or is behind: ` +
          'whether and when the contract registered it is unknown, so its books cannot start',
        details: { symbol, registered_here_at: createdAt.toISOString() },
      });
    }
  }

  /** Whether the event archive is gap-free and current; false if the network cannot be read. */
  private async archiveComplete(): Promise<boolean> {
    try {
      const latest = await this.chain.latestLedger();
      return (await archiveCoverage(this.pool, this.chain.contractId, latest.sequence)).complete;
    } catch (err) {
      this.logger.warn({ err }, 'could not read the network to check archive coverage');
      return false;
    }
  }

  private async anchoredDays(db: Queryable, warehouseId: string): Promise<number[]> {
    const { rows } = await db.query<{ day: number }>(
      'SELECT day FROM book_anchors WHERE contract_id = $1 AND warehouse_id = $2',
      [this.chain.contractId, warehouseId],
    );
    return rows.map((row) => row.day);
  }
}

export class BookCheckError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the day's books fail their checks: ${problems.join('; ')}`);
    this.name = 'BookCheckError';
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
