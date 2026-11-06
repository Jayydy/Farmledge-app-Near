import { randomBytes } from 'node:crypto';

import type pg from 'pg';

import { addressFor, subjectOf } from '../chain/addresses.js';
import type { Queryable } from '../db/pool.js';
import { chainSymbol, unixSeconds, utcDay, warehouseSymbol } from '../domain/book.js';
import type { BalanceKey } from '../domain/ledger.js';
import { bookKgDelta, type LotBalance, type LotDraw } from '../domain/lots.js';
import type { BookRecordJson, LeafJson } from '../domain/merkle.js';
import { toCentiKg } from '../domain/quantities.js';
import type { KeyService } from '../keys/keyService.js';

/**
 * Writing into the daily book (INV-4). Every transaction that moves stock:
 *
 * 1. calls `openBookWrite` first: a shared lock on the warehouse's book, and
 *    the time it records at. Closing a day takes the same lock exclusively,
 *    so nothing recorded before a cutoff can still be in flight when that
 *    day's tree is built, and everything recorded after it lands in a later
 *    day;
 * 2. splits its stock movement across lots (`postLotMovements`);
 * 3. writes a book entry, with a fresh salt, for each lot movement
 *    (`writeBookEntries`), so the counter slip can carry the leaf and salt.
 */
export async function openBookWrite(
  client: pg.ClientBase,
  warehouseId: string,
  recordedAt: Date,
): Promise<Date> {
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    `book|${warehouseId}`,
  ]);
  await client.query(`SELECT set_config('farmledge.recorded_at', $1, true)`, [
    recordedAt.toISOString(),
  ]);
  return recordedAt;
}

/** Taken exclusively while a day's tree is built. */
export async function lockBookExclusive(client: pg.ClientBase, warehouseId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `book|${warehouseId}`,
  ]);
}

/**
 * The farmer's lots of one grade, with their balances, rows locked so the
 * caller can plan a draw and post it atomically.
 */
export async function lockedLots(
  client: Queryable,
  key: BalanceKey,
  lock = true,
): Promise<LotBalance[]> {
  const { rows } = await client.query<{
    deposit_id: string;
    deposit_no: string;
    intake_at: Date;
    bags: string;
    kg: string;
    governed: boolean;
  }>(
    `WITH lots AS (
       SELECT deposit_id, deposit_no, intake_at,
              (frozen_for_mint IS NOT NULL OR status = 'minted') AS governed
         FROM deposits
        WHERE warehouse_id = $1 AND farmer_id = $2 AND commodity = $3
          AND grading_scheme = $4 AND grade = $5
          AND status NOT IN ('rejected', 'cancelled')
        ORDER BY deposit_no
        ${lock ? 'FOR UPDATE' : ''}
     )
     SELECT l.deposit_id, l.deposit_no, l.intake_at, l.governed,
            COALESCE(sum(m.bags_delta), 0) AS bags, COALESCE(sum(m.kg_delta), 0) AS kg
       FROM lots l LEFT JOIN lot_movements m ON m.deposit_id = l.deposit_id
      GROUP BY l.deposit_id, l.deposit_no, l.intake_at, l.governed`,
    [key.warehouseId, key.farmerId, key.commodity, key.gradingScheme, key.grade],
  );
  return rows.map((row) => ({
    depositId: row.deposit_id,
    depositNo: Number(row.deposit_no),
    intakeAt: row.intake_at,
    bags: Number(row.bags),
    centiKg: toCentiKg(row.kg),
    governedOnChain: row.governed,
  }));
}

/** Writes a stock movement's split across lots; returns the lot movement ids. */
export async function postLotMovements(
  client: Queryable,
  stockMovementId: string,
  draws: readonly LotDraw[],
  lots: readonly LotBalance[],
  recordedAt: Date,
): Promise<string[]> {
  const ids: string[] = [];
  for (const draw of draws) {
    const before = lots.find((lot) => lot.depositId === draw.depositId)?.centiKg ?? 0;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO lot_movements (deposit_id, stock_movement_id, bags_delta, kg_delta,
                                  book_kg_delta, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        draw.depositId,
        stockMovementId,
        draw.bagsDelta,
        (draw.centiKgDelta / 100).toFixed(2),
        bookKgDelta(before, draw.centiKgDelta),
        recordedAt,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('lot movement insert returned no id');
    ids.push(id);
  }
  return ids;
}

interface MovementContext {
  lot_movement_id: string;
  bags_delta: number;
  book_kg_delta: string;
  recorded_at: Date;
  kind: 'deposit_in' | 'deposit_void' | 'dispatch_out' | 'adjustment';
  occurred_at: Date;
  dispatch_id: string | null;
  dispatched_at: Date | null;
  adjustment_id: string | null;
  reason_code: string | null;
  cancellation_id: string | null;
  cancelled_at: Date | null;
  deposit_id: string;
  deposit_no: string;
  warehouse_id: string;
  warehouse_code: string;
  farmer_id: string;
  custodian_id: string;
  verifier_id: string;
  commodity: string;
  grade: string;
  moisture_bps: number;
  intake_at: Date;
  scale_weighed: boolean;
}

const MOVEMENT_CONTEXT = `
  SELECT lm.id AS lot_movement_id, lm.bags_delta, lm.book_kg_delta, lm.recorded_at,
         sm.kind, sm.occurred_at, sm.dispatch_id, dp.dispatched_at, sm.adjustment_id,
         a.reason_code, c.id AS cancellation_id, c.cancelled_at,
         d.deposit_id, d.deposit_no, d.warehouse_id, w.code AS warehouse_code, d.farmer_id,
         d.custodian_id, d.verifier_id, d.commodity, d.grade, d.moisture_bps, d.intake_at,
         ${SCALE_WEIGHED_SQL('d')} AS scale_weighed
    FROM lot_movements lm
    JOIN stock_movements sm ON sm.id = lm.stock_movement_id
    JOIN deposits d ON d.deposit_id = lm.deposit_id
    JOIN warehouses w ON w.id = d.warehouse_id
    LEFT JOIN dispatches dp ON dp.id = sm.dispatch_id
    LEFT JOIN stock_adjustments a ON a.id = sm.adjustment_id
    LEFT JOIN deposit_cancellations c ON c.deposit_id = d.deposit_id AND sm.kind = 'deposit_void'`;

/**
 * A lot counts as scale-weighed (leaf `weight_source = Scale`) only once
 * every bag has been weighed (`deposit_weights.weight_kg` is set). Until
 * then its kg is a bag estimate, whatever mode it was taken in.
 */
export function SCALE_WEIGHED_SQL(alias: string): string {
  return `(${alias}.weight_source = 'scale' AND EXISTS (
            SELECT 1 FROM deposit_weights dw
             WHERE dw.deposit_id = ${alias}.deposit_id AND dw.weight_kg IS NOT NULL))`;
}

export interface LotIdentity {
  warehouseSymbol: string;
  owner: string;
  custodian: string;
  verifier: string;
}

export async function lotIdentity(
  keys: KeyService,
  row: { warehouse_code: string; farmer_id: string; custodian_id: string; verifier_id: string },
): Promise<LotIdentity> {
  return {
    warehouseSymbol: warehouseSymbol(row.warehouse_code),
    owner: await addressFor(keys, subjectOf.farmer(row.farmer_id)),
    custodian: await addressFor(keys, subjectOf.custodian(row.custodian_id)),
    verifier: await addressFor(keys, subjectOf.verifier(row.verifier_id)),
  };
}

type EntryContent =
  | { entryType: 'leaf'; kind: 0 | 1; content: Omit<LeafJson, 'day' | 'index' | 'salt'> }
  | {
      entryType: 'record';
      recordKind: 'adjustment' | 'cancellation';
      content: Omit<BookRecordJson, 'day' | 'index' | 'salt'>;
    };

async function contentFor(keys: KeyService, row: MovementContext): Promise<EntryContent> {
  const id = await lotIdentity(keys, row);
  const base = {
    warehouse_id: id.warehouseSymbol,
    deposit_no: Number(row.deposit_no),
    deposit_id: row.deposit_id,
  };
  const bookKg = Number(row.book_kg_delta);
  if (row.kind === 'deposit_in' || row.kind === 'dispatch_out') {
    const isDeposit = row.kind === 'deposit_in';
    const at = isDeposit ? row.intake_at : (row.dispatched_at ?? row.occurred_at);
    return {
      entryType: 'leaf',
      kind: isDeposit ? 0 : 1,
      content: {
        version: 1,
        kind: isDeposit ? 0 : 1,
        ...base,
        receipt_id: 0,
        receipt_version: 0,
        owner: id.owner,
        commodity: chainSymbol(row.commodity, 'commodity'),
        grade: chainSymbol(row.grade, 'grade'),
        kg: Math.abs(bookKg),
        weight_source: row.scale_weighed ? 'Scale' : 'BagEstimate',
        bags: Math.abs(row.bags_delta),
        moisture_bps: row.moisture_bps,
        custodian: id.custodian,
        verifier: id.verifier,
        deposited_at: unixSeconds(row.intake_at),
        at: unixSeconds(at),
      },
    };
  }
  const isCancellation = row.kind === 'deposit_void';
  return {
    entryType: 'record',
    recordKind: isCancellation ? 'cancellation' : 'adjustment',
    content: {
      record: isCancellation ? 'cancellation' : 'adjustment',
      version: 1,
      ...base,
      source_id: (isCancellation ? row.cancellation_id : row.adjustment_id) ?? row.lot_movement_id,
      reason: isCancellation ? 'cancellation' : (row.reason_code ?? 'other'),
      owner: id.owner,
      bags_delta: row.bags_delta,
      kg_delta: bookKg,
      at: unixSeconds(isCancellation ? (row.cancelled_at ?? row.recorded_at) : row.occurred_at),
    },
  };
}

/**
 * Writes a book entry, with a fresh 32-byte salt, for each lot movement
 * that has none yet. Idempotent: an existing entry is never rewritten.
 * Returns the entries' ids, in the order of `lotMovementIds`.
 */
export async function writeBookEntries(
  client: Queryable,
  keys: KeyService,
  lotMovementIds: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const lotMovementId of lotMovementIds) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM book_entries WHERE lot_movement_id = $1',
      [lotMovementId],
    );
    if (existing.rows[0] !== undefined) {
      ids.push(existing.rows[0].id);
      continue;
    }
    const { rows } = await client.query<MovementContext>(`${MOVEMENT_CONTEXT} WHERE lm.id = $1`, [
      lotMovementId,
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error(`lot movement ${lotMovementId} not found`);
    const entry = await contentFor(keys, row);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO book_entries (warehouse_id, entry_type, kind, record_kind, deposit_id,
                                 deposit_no, farmer_id, lot_movement_id, content, salt,
                                 recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        row.warehouse_id,
        entry.entryType,
        entry.entryType === 'leaf' ? entry.kind : null,
        entry.entryType === 'record' ? entry.recordKind : null,
        row.deposit_id,
        row.deposit_no,
        row.farmer_id,
        lotMovementId,
        JSON.stringify(entry.content),
        randomBytes(32),
        row.recorded_at,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('book entry insert returned no id');
    ids.push(id);
  }
  return ids;
}

/** Lot movements recorded before `before` that have no book entry yet. */
export async function unbookedLotMovements(
  client: Queryable,
  warehouseId: string,
  before: Date,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT lm.id FROM lot_movements lm
       JOIN deposits d ON d.deposit_id = lm.deposit_id
      WHERE d.warehouse_id = $1 AND lm.recorded_at < $2
        AND NOT EXISTS (SELECT 1 FROM book_entries b WHERE b.lot_movement_id = lm.id)
      ORDER BY lm.recorded_at, lm.id`,
    [warehouseId, before],
  );
  return rows.map((row) => row.id);
}

export interface SlipEntry {
  /** The leaf's data and salt; `index` is unknown until the day's tree is built. */
  leaf: Omit<LeafJson, 'index'> & { index: number | null };
  /** For the slip's QR code: the same leaf as compact JSON. */
  qr_payload: string;
  /** True once the day is anchored and the full bundle exists. */
  anchored: boolean;
}

/** What a counter slip prints for each book entry: the leaf, its salt, a QR payload. */
export async function slipEntries(
  db: Queryable,
  bookEntryIds: readonly string[],
): Promise<SlipEntry[]> {
  if (bookEntryIds.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    content: Omit<LeafJson, 'day' | 'index' | 'salt'>;
    salt: Buffer;
    recorded_at: Date;
    day: number | null;
    idx: number | null;
    anchored: boolean;
  }>(
    `SELECT b.id, b.content, b.salt, b.recorded_at, b.day, b.idx,
            COALESCE(bd.status = 'anchored', false) AS anchored
       FROM book_entries b
       LEFT JOIN book_days bd ON bd.warehouse_id = b.warehouse_id AND bd.day = b.day
      WHERE b.id = ANY($1::uuid[]) AND b.entry_type = 'leaf'`,
    [bookEntryIds],
  );
  const order = new Map(bookEntryIds.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => {
      const leaf = {
        ...row.content,
        // The day it will be anchored in: the UTC day it was recorded.
        day: row.day ?? utcDay(row.recorded_at),
        index: row.idx,
        salt: row.salt.toString('hex'),
      } as SlipEntry['leaf'];
      return { leaf, qr_payload: JSON.stringify(leaf), anchored: row.anchored };
    });
}
