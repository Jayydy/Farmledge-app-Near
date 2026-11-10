import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Keypair } from '@stellar/stellar-sdk';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nextHead, ZERO_HEAD } from '../../src/domain/merkle.js';
import {
  backup,
  readBackup,
  restoreEvents,
  verifyBackup,
} from '../../src/services/archiveBackup.js';
import { MAX_LAG_LEDGERS } from '../../src/services/indexer.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import { encodeEvent, sv, type FakeChain } from '../helpers/fakeChain.js';
import { createMigratedDatabase } from '../helpers/testDatabase.js';
import { anchoredLot, DAY, sqlError } from './helpers.js';

const START = 4_917_586;
const owner = Keypair.random().publicKey();
const custodian = Keypair.random().publicKey();
const verifier = Keypair.random().publicKey();
const root = Buffer.alloc(32, 9);
const head = nextHead(ZERO_HEAD, DAY, 3, root);

/** A small history: registry, an anchor, a mint, a partial exit (split, then exited). */
function history(fake: FakeChain): void {
  fake.events.push(
    encodeEvent(START + 2, 0, 0, 'warehouse_added', [sv.sym('KN_DAWANAU')], {
      added_at: sv.u64(DAY * 86_400), // the warehouse's books start on DAY (D53)
    }),
    encodeEvent(START + 3, 0, 0, 'custodian_added', [sv.sym('KN_DAWANAU')], {
      custodian: sv.addr(custodian),
      added_at: sv.u64(1),
    }),
    encodeEvent(START + 10, 0, 0, 'anchored', [sv.sym('KN_DAWANAU')], {
      day: sv.u32(DAY),
      leaves: sv.u32(3),
      root: sv.bytes(root),
      prev_head: sv.bytes(ZERO_HEAD),
      head: sv.bytes(head),
      custodian: sv.addr(custodian),
      anchored_at: sv.u64(2),
    }),
    encodeEvent(START + 20, 0, 0, 'minted', [sv.u64(1), sv.sym('KN_DAWANAU')], {
      deposit_no: sv.u64(1),
      deposit_id: sv.str('d-1'),
      owner: sv.addr(owner),
      commodity: sv.sym('MAIZE_WHITE'),
      grade: sv.sym('1'),
      weight_kg: sv.u64(2000),
      weight_source: sv.unit('Scale'),
      bag_count: sv.u32(20),
      moisture_pct: sv.u32(1250),
      custodian: sv.addr(custodian),
      verifier: sv.addr(verifier),
      deposit_date: sv.u64(1),
      minted_by_custodian: sv.addr(custodian),
      minted_by_verifier: sv.addr(verifier),
      anchor_day: sv.u32(DAY),
      leaf_hash: sv.bytes(Buffer.alloc(32, 1)),
      minted_at: sv.u64(3),
    }),
    encodeEvent(START + 30, 1, 0, 'split', [sv.u64(1)], {
      owner: sv.addr(owner),
      warehouse_id: sv.sym('KN_DAWANAU'),
      status: sv.unit('Active'),
      lender: sv.none(),
      parent_weight_kg: sv.u64(2000),
      taken_id: sv.u64(2),
      taken_weight_kg: sv.u64(500),
      taken_bag_count: sv.u32(5),
      remainder_id: sv.u64(1),
      remainder_weight_kg: sv.u64(1500),
      remainder_bag_count: sv.u32(15),
      split_at: sv.u64(4),
    }),
    encodeEvent(START + 30, 1, 1, 'exited', [sv.u64(2), sv.sym('KN_DAWANAU')], {
      owner: sv.addr(owner),
      custodian: sv.addr(custodian),
      weight_kg: sv.u64(500),
      bag_count: sv.u32(5),
      exit_weight_kg: sv.u64(495),
      exit_date: sv.u64(4),
    }),
  );
  fake.heads.set('KN_DAWANAU', { day: DAY, head });
  const base = {
    parentId: null,
    owner,
    warehouseSymbol: 'KN_DAWANAU',
    depositNo: 1n,
    depositId: 'd-1',
    weightSource: 'Scale' as const,
    lender: null,
  };
  fake.receipts.set('1', {
    ...base,
    receiptId: 1n,
    status: 'Active',
    weightKg: 1500n,
    bagCount: 15,
  });
  fake.receipts.set('2', {
    ...base,
    receiptId: 2n,
    parentId: 1n,
    status: 'Exited',
    weightKg: 500n,
    bagCount: 5,
  });
  fake.ledger = START + 100;
}

const projections = async (pool: pg.Pool) => ({
  receipts: (
    await pool.query(
      'SELECT receipt_id, parent_id, status, weight_kg, initial_weight_kg, bag_count, owner, lender FROM chain_receipts ORDER BY receipt_id',
    )
  ).rows,
  anchors: (
    await pool.query(
      'SELECT warehouse_symbol, day, leaves, root, prev_head, head FROM chain_anchors ORDER BY day',
    )
  ).rows,
  registry: (
    await pool.query(
      'SELECT role, warehouse_symbol, address, active FROM chain_registry ORDER BY role, address',
    )
  ).rows,
});

/**
 * INV-8. Archive every event before advancing the cursor, split and
 * anchored above all; check for gaps; back up.
 */
describe('INV-8 the event archive', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    // The archive holds only what this file puts there: the contract's own
    // warehouse_added events, not the harness's.
    h = await startChainHarness({
      start: middayOf(DAY),
      onChain: { warehouseId: null, otherWarehouseId: null },
    });
    fake = h.chain as FakeChain;
    history(fake);
  });
  afterEach(async () => {
    await (h as ChainHarness | undefined)?.close();
  });

  it('archives every event, raw XDR and all, in the transaction that moves the cursor; a page that fails moves nothing', async () => {
    await h.indexer.ingest();
    const archived = await h.pool.query<{ event_type: string; value_xdr: string }>(
      'SELECT event_type, value_xdr FROM events_archive ORDER BY ledger, tx_index, event_index',
    );
    expect(archived.rows.map((r) => r.event_type)).toEqual([
      'warehouse_added',
      'custodian_added',
      'anchored',
      'minted',
      'split',
      'exited',
    ]);
    expect(archived.rows[4]?.value_xdr).toBe(fake.events[4]?.valueXdr);
    expect(await h.indexer.cursor()).toBe(START + 100);

    const bad = encodeEvent(START + 150, 0, 0, 'minted', [sv.u64(3)], {});
    bad.valueXdr = 'not-xdr';
    fake.events.push(bad);
    fake.ledger = START + 200;
    await expect(h.indexer.ingest()).rejects.toThrow();
    expect(await h.indexer.cursor()).toBe(START + 100);
    expect((await h.pool.query('SELECT 1 FROM events_archive')).rowCount).toBe(6);
  });

  it('re-ingesting a range is harmless: idempotent on (ledger, tx hash, event index)', async () => {
    await h.indexer.ingest();
    const before = await projections(h.pool);
    await h.pool.query('UPDATE indexer_cursors SET cursor_ledger = $1', [START - 1]);
    await h.indexer.ingest();
    expect((await h.pool.query('SELECT 1 FROM events_archive')).rowCount).toBe(6);
    expect(await projections(h.pool)).toEqual(before);
  });

  it('never prunes or rewrites the archive (database rule)', async () => {
    await h.indexer.ingest();
    expect((await sqlError(h, 'DELETE FROM events_archive')).message).toMatch(/append-only/);
    expect((await sqlError(h, `UPDATE events_archive SET value_xdr = ''`)).message).toMatch(
      /append-only/,
    );
  });

  it('pages when indexing falls more than a day of ledgers behind', async () => {
    await h.indexer.ingest();
    fake.ledger = START + 100 + MAX_LAG_LEDGERS + 10;
    const real = fake.getEvents.bind(fake);
    fake.getEvents = async (range) => ({
      ...(await real(range)),
      coveredThrough: range.startLedger - 1,
    });
    await h.indexer.ingest();
    expect(await h.alerts.open('indexer')).toEqual([
      { key: `indexer_behind:${fake.contractId}`, severity: 'page' },
    ]);
  });

  it('pages urgently when ledgers left RPC retention before they were indexed (ingest)', async () => {
    await h.indexer.ingest();
    const cursor = await h.indexer.cursor();
    // A long outage: RPC's oldest ledger is now far past the cursor.
    fake.ledger = cursor + 200_000;
    await expect(h.indexer.ingest()).rejects.toThrow(/out of RPC retention/);
    // It stops: the cursor never moves past ledgers it could not archive.
    expect(await h.indexer.cursor()).toBe(cursor);
    const open = await h.alerts.open('indexer');
    expect(open).toContainEqual({
      key: `indexer_retention_gap:${fake.contractId}`,
      severity: 'urgent',
    });
  });

  it('finds a hole after an outage, re-fetches it while RPC holds it, and reconciles receipts and heads', async () => {
    // As if the indexer had been down across ledgers START+5 .. START+30.
    await h.pool.query(
      `INSERT INTO indexer_cursors (contract_id, start_ledger, cursor_ledger) VALUES ($1, $2, $3)`,
      [fake.contractId, START, START + 100],
    );
    await h.pool.query(
      `INSERT INTO indexed_ranges (contract_id, from_ledger, to_ledger, event_count)
       VALUES ($1, $2, $3, 0), ($1, $4, $5, 0)`,
      [fake.contractId, START, START + 4, START + 31, START + 100],
    );
    const result = await h.indexer.verifyNoGaps();
    expect(result.holes).toEqual([[START + 5, START + 30]]);
    expect(result.refetched).toBe(4);
    expect(result.problems).toEqual([]);
    expect((await projections(h.pool)).anchors).toHaveLength(1);
  });

  it('pages urgently on a gap outside RPC retention, and when the archived head chain misses an anchored event', async () => {
    await h.indexer.ingest();
    fake.heads.set('KN_DAWANAU', { day: DAY + 1, head: nextHead(head, DAY + 1, 1, root) });
    const problems = await h.indexer.reconcile();
    expect(problems).toEqual([
      "KN_DAWANAU: the archived head chain does not end at get_anchor's head: an anchored event is missing",
    ]);
    fake.ledger = START + 300_000;
    await h.pool.query(
      `INSERT INTO indexed_ranges (contract_id, from_ledger, to_ledger, event_count) VALUES ($1, $2, $2, 0)`,
      [fake.contractId, START + 299_000],
    );
    await h.pool.query('UPDATE indexer_cursors SET cursor_ledger = $1', [START + 299_000]);
    await h.indexer.verifyNoGaps();
    expect((await h.alerts.open('indexer')).map((a) => a.severity)).toContain('urgent');
    expect((await h.alerts.open('indexer')).map((a) => a.key)).toContainEqual(
      expect.stringMatching(/^indexer_gap_unrecoverable:/),
    );
  });

  it('rebuilds every projection from the archive alone, exactly', async () => {
    await h.indexer.ingest();
    const incremental = await projections(h.pool);
    expect(incremental.receipts).toEqual([
      expect.objectContaining({
        receipt_id: '1',
        status: 'Active',
        weight_kg: '1500',
        initial_weight_kg: '2000',
      }),
      expect.objectContaining({
        receipt_id: '2',
        parent_id: '1',
        status: 'Exited',
        weight_kg: '500',
      }),
    ]);
    await h.indexer.rebuild();
    expect(await projections(h.pool)).toEqual(incremental);
  });

  it('backs up the archive and the books, verifies the copy from the file alone, restores it, and detects corruption', async () => {
    await h.indexer.ingest();
    fake.heads.clear();
    await anchoredLot(h);
    const dir = await mkdtemp(path.join(tmpdir(), 'farmledge-backup-'));
    try {
      const manifest = await backup(h.pool, dir, new Date());
      // KN-BICHI is not on the contract here, so only the lot's day is closed.
      expect(manifest).toMatchObject({ events: 6, book_days: 1 });
      expect(await verifyBackup(dir, manifest)).toEqual([]);

      const target = await createMigratedDatabase('test');
      const pool = new pg.Pool({ connectionString: target.url });
      try {
        expect(await restoreEvents(pool, await readBackup(dir, manifest))).toBe(6);
        const restored = await pool.query(
          'SELECT event_id, topic_xdr, value_xdr FROM events_archive ORDER BY id',
        );
        const original = await h.pool.query(
          'SELECT event_id, topic_xdr, value_xdr FROM events_archive ORDER BY id',
        );
        expect(restored.rows).toEqual(original.rows);
      } finally {
        await pool.end();
        await target.drop();
      }

      const file = path.join(dir, manifest.file);
      const bytes = await readFile(file);
      bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff;
      await writeFile(file, bytes);
      await expect(verifyBackup(dir, manifest)).rejects.toThrow(/corrupt/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
