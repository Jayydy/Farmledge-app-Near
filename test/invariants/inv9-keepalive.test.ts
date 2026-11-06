import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectLive } from '../../src/services/keepAlive.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { ReceiptStatus } from '../../src/chain/chainClient.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { DAY } from './helpers.js';

const STATUSES = ['Active', 'Locked', 'Recovery', 'Exited', 'Revoked'];

/**
 * INV-9. Keep minted receipts alive daily, never sending Exited or Revoked
 * ids; at most 25 per call; alert at 14 days of TTL left.
 */
describe('INV-9 keep-alive', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
    fake = h.chain as FakeChain;
    // 60 receipts on-chain, a fifth in each status, as the indexer projected them.
    for (let id = 1; id <= 60; id++) {
      fake.seedReceipt(STATUSES[id % 5] as ReceiptStatus);
      await h.pool.query(
        `INSERT INTO chain_receipts (contract_id, receipt_id, warehouse_symbol, deposit_no, deposit_id, owner,
                                     status, weight_kg, bag_count, initial_weight_kg, weight_source,
                                     last_event_ledger)
         VALUES ($1, $2, 'KN_DAWANAU', $2, 'd', 'G', $3, 100, 1, 100, 'Scale', 1)`,
        [fake.contractId, id, STATUSES[id % 5]],
      );
    }
    await h.pool.query(
      `INSERT INTO indexer_cursors (contract_id, start_ledger, cursor_ledger) VALUES ($1, 1, $2)`,
      [fake.contractId, fake.ledger],
    );
    await h.pool.query(
      `INSERT INTO indexed_ranges (contract_id, from_ledger, to_ledger, event_count)
       VALUES ($1, 1, $2, 60)`,
      [fake.contractId, fake.ledger],
    );
  });
  const sentIds = () => fake.ttlBatches.flat().map(String);
  afterEach(async () => {
    await h.close();
  });

  it('sends only Active, Locked and Recovery receipts, never Exited or Revoked, 25 at most per call', async () => {
    const report = await h.keepAlive.run();
    const sent = fake.ttlBatches.flat().map(String);
    expect(sent).toHaveLength(36);
    expect(report.skippedFinished).toBe(24);
    for (const id of sent)
      expect(['Active', 'Locked', 'Recovery']).toContain(STATUSES[Number(id) % 5]);
    expect(fake.ttlBatches.map((b) => b.length)).toEqual([25, 11]);
    expect(
      selectLive([
        { receipt_id: '1', status: 'Exited' },
        { receipt_id: '2', status: 'Revoked' },
      ]),
    ).toEqual([]);
  });

  it('refuses to run on a receipt list the indexer has not brought up to date', async () => {
    fake.ledger += 10_000;
    await expect(h.keepAlive.run()).rejects.toThrow(/indexer is not up to date/);
    expect(fake.ttlBatches).toEqual([]);
    expect((await h.alerts.open('keepalive')).map((a) => a.key)).toEqual([
      `keepalive_blocked:${fake.contractId}`,
    ]);
  });

  it('keeps alive, and pages urgently for, a live receipt the projection missed (a lost minted event)', async () => {
    const missed = fake.seedReceipt('Active').toString(); // id 61: its minted event never reached the archive
    const finished = fake.seedReceipt('Exited').toString(); // id 62
    const report = await h.keepAlive.run();
    expect(sentIds()).toContain(missed);
    expect(sentIds()).not.toContain(finished);
    expect(report.recovered).toEqual([missed]);
    expect(await h.alerts.open('keepalive')).toEqual([
      { key: `receipts_missing_from_projection:${fake.contractId}`, severity: 'urgent' },
    ]);
  });

  it('reads every status from the chain when the archive has a hole, so a missed exit sends nothing finished', async () => {
    // The cursor moved past 100 ledgers that were never archived: a hole.
    fake.ledger += 100;
    await h.pool.query('UPDATE indexer_cursors SET cursor_ledger = $1', [fake.ledger]);
    // Receipt 3 exited inside the hole: the projection still says Active.
    await h.pool.query(`UPDATE chain_receipts SET status = 'Active' WHERE receipt_id = 3`);
    const report = await h.keepAlive.run();
    expect(report.statusesFromChain).toBe(true);
    expect(sentIds()).not.toContain('3');
    expect(sentIds()).toHaveLength(36);
    expect(await h.alerts.open('keepalive')).toEqual([
      { key: `keepalive_archive_gap:${fake.contractId}`, severity: 'page' },
    ]);
  });

  it('reads TTLs back after the run and pages at 14 days left', async () => {
    fake.liveUntil.set('1', fake.ledger + 13 * 17_280);
    const report = await h.keepAlive.run();
    expect(report.lowTtl).toEqual(['1']);
    expect(await h.alerts.open('keepalive')).toEqual([
      { key: `ttl_low:${fake.contractId}:1`, severity: 'page' },
    ]);
  });
});
