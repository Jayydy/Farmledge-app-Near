import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type pg from 'pg';

import { withTransaction } from '../db/transaction.js';
import { buildTree, entryHash, foldProof, type BookEntryJson } from '../domain/merkle.js';

/**
 * Backups of the data that exists nowhere else (events.md requirement 4;
 * INV-8): the event archive, and the daily books (every leaf, salt, proof
 * and root, which backend-requirements §3 puts under the same rules).
 *
 * `backup` writes one gzipped JSON file plus a manifest with its sha256;
 * the directory is where off-site storage is mounted (ARCHIVE_BACKUP_DIR).
 * `verifyBackup` proves a restore works from the file alone: hash, counts,
 * every leaf hash and proof re-derived, every day's root rebuilt.
 * `restoreEvents` loads the archive into an empty database.
 */
export interface BackupFile {
  version: 1;
  environment: string;
  created_at: string;
  events: Record<string, unknown>[];
  book_days: Record<string, unknown>[];
  book_entries: Record<string, unknown>[];
  book_anchors: Record<string, unknown>[];
}

export interface BackupManifest {
  file: string;
  sha256: string;
  events: number;
  book_entries: number;
  book_days: number;
}

const TABLE_ORDER = {
  events_archive: 'ledger, tx_index, op_index, event_index',
  book_days: 'warehouse_id, day',
  book_entries: 'warehouse_id, day NULLS LAST, idx, id',
  book_anchors: 'contract_id, warehouse_id, day',
} as const;

const bytesToHex = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : v]),
  );

export async function backup(pool: pg.Pool, dir: string, now: Date): Promise<BackupManifest> {
  const data = await withTransaction(pool, async (client) => {
    // One consistent snapshot of every table.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const env = await client.query<{ environment: string }>(
      'SELECT environment FROM db_environment',
    );
    const read = async (table: keyof typeof TABLE_ORDER) =>
      (
        await client.query<Record<string, unknown>>(
          `SELECT * FROM ${table} ORDER BY ${TABLE_ORDER[table]}`,
        )
      ).rows.map(bytesToHex);
    const file: BackupFile = {
      version: 1,
      environment: env.rows[0]?.environment ?? 'unknown',
      created_at: now.toISOString(),
      events: await read('events_archive'),
      book_days: await read('book_days'),
      book_entries: await read('book_entries'),
      book_anchors: await read('book_anchors'),
    };
    return file;
  });
  const body = gzipSync(Buffer.from(JSON.stringify(data)));
  const sha256 = createHash('sha256').update(body).digest('hex');
  await mkdir(dir, { recursive: true });
  const name = `farmledge-archive-${data.environment}-${now.toISOString().replaceAll(':', '-')}.json.gz`;
  await writeFile(path.join(dir, name), body);
  const manifest: BackupManifest = {
    file: name,
    sha256,
    events: data.events.length,
    book_entries: data.book_entries.length,
    book_days: data.book_days.length,
  };
  await writeFile(path.join(dir, `${name}.manifest.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function readBackup(dir: string, manifest: BackupManifest): Promise<BackupFile> {
  const body = await readFile(path.join(dir, manifest.file));
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (sha256 !== manifest.sha256)
    throw new Error(`backup ${manifest.file} is corrupt (sha256 differs)`);
  return JSON.parse(gunzipSync(body).toString('utf8')) as BackupFile;
}

const hex = (v: unknown) => String(v).replace(/^\\x/, '');

/**
 * Proves the backup is complete and usable without the database: counts
 * match the manifest, every placed entry's hash is re-derived from its
 * fields and salt, every proof folds to its day's root, and every day's root
 * is rebuilt from its entries.
 */
export async function verifyBackup(dir: string, manifest: BackupManifest): Promise<string[]> {
  const data = await readBackup(dir, manifest);
  const problems: string[] = [];
  if (data.events.length !== manifest.events)
    problems.push('event count differs from the manifest');
  if (data.book_entries.length !== manifest.book_entries) problems.push('book entry count differs');
  const byDay = new Map<string, { idx: number; hash: Buffer }[]>();
  for (const e of data.book_entries) {
    if (e.day === null) continue;
    const json = {
      ...(e.content as object),
      day: Number(e.day),
      index: Number(e.idx),
      salt: hex(e.salt),
    } as BookEntryJson;
    const hash = entryHash(json);
    if (hash.toString('hex') !== hex(e.leaf_hash)) {
      problems.push(`entry ${String(e.id)}: hash does not re-derive from its fields and salt`);
    }
    const key = `${String(e.warehouse_id)}:${JSON.stringify(e.day)}`;
    byDay.set(key, [...(byDay.get(key) ?? []), { idx: Number(e.idx), hash }]);
    const day = data.book_days.find((d) => d.warehouse_id === e.warehouse_id && d.day === e.day);
    const proof = (e.proof as string[]).map((p) => Buffer.from(p, 'hex'));
    if (day && foldProof(hash, Number(e.idx), proof).toString('hex') !== hex(day.root)) {
      problems.push(
        `entry ${String(e.id)}: proof does not fold to day ${JSON.stringify(e.day)}'s root`,
      );
    }
  }
  for (const day of data.book_days) {
    if (day.status !== 'built') continue;
    const entries = (byDay.get(`${String(day.warehouse_id)}:${String(day.day)}`) ?? []).sort(
      (a, b) => a.idx - b.idx,
    );
    if (entries.length !== Number(day.leaves)) {
      problems.push(
        `day ${String(day.day)}: ${entries.length} entries backed up, ${String(day.leaves)} anchored`,
      );
      continue;
    }
    if (buildTree(entries.map((e) => e.hash)).root.toString('hex') !== hex(day.root)) {
      problems.push(`day ${String(day.day)}: the root does not rebuild from its entries`);
    }
  }
  return problems;
}

/** Loads a backup's event archive into an empty, migrated database of the same environment. */
export async function restoreEvents(pool: pg.Pool, data: BackupFile): Promise<number> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM events_archive',
    );
    if ((existing.rows[0]?.n ?? 0) > 0) throw new Error('restore needs an empty events_archive');
    for (const e of data.events) {
      await client.query(
        `INSERT INTO events_archive (id, event_id, contract_id, ledger, ledger_closed_at, tx_hash,
                                     tx_index, op_index, event_index, event_type, topics, value,
                                     topic_xdr, value_xdr, in_successful_contract_call, received_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          e.id,
          e.event_id,
          e.contract_id,
          e.ledger,
          e.ledger_closed_at,
          e.tx_hash,
          e.tx_index,
          e.op_index,
          e.event_index,
          e.event_type,
          JSON.stringify(e.topics),
          JSON.stringify(e.value),
          e.topic_xdr ?? [],
          e.value_xdr ?? '',
          e.in_successful_contract_call,
          e.received_at,
        ],
      );
    }
    return data.events.length;
  });
}
