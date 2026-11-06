import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MINT_MAX_TIME_SECONDS } from '../../src/services/pledges.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY, lotState, pledge } from './helpers.js';

/**
 * INV-1, the outcome of a mint. A lot is unfrozen only once its mint can no
 * longer land. Unfreezing a lot whose mint landed lets grain leave the
 * warehouse while an on-chain receipt says it is there.
 *
 * Gap A: RPC keeps transactions only for a while; once a mint's ledgers have
 *   left that window, "not found" proves nothing, and the event archive decides.
 * Gap C: a mint waiting in the submission queue must not outlive the deadline
 *   fixed at freeze time, and an unrecorded mint is unfrozen only once a ledger
 *   has closed after that deadline.
 * (Gap B is pinned at the client: test/chain/settle.test.ts.)
 */
describe('INV-1: a lot is unfrozen only once its mint can no longer land', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
    fake = h.chain as FakeChain;
  });
  afterEach(async () => {
    await h.close();
  });

  async function archiveMinted(depositNo: number, receiptId: string, ledger: number) {
    await h.pool.query(
      `INSERT INTO events_archive (event_id, contract_id, ledger, ledger_closed_at, tx_hash, tx_index,
                                   op_index, event_index, event_type, topics, value, topic_xdr,
                                   value_xdr, in_successful_contract_call)
       VALUES ($1, $2, $3, now(), $4, 0, 0, 0, 'minted', $5, $6, '{}', '', true)`,
      [
        `${ledger}-0`,
        fake.contractId,
        ledger,
        randomBytes(32).toString('hex'),
        JSON.stringify(['minted', receiptId, 'KN_DAWANAU']),
        JSON.stringify({
          receipt_id: receiptId,
          warehouse_id: 'KN_DAWANAU',
          deposit_no: depositNo,
        }),
      ],
    );
  }
  /** As the indexer leaves it: the cursor at `ledger`, every range up to it archived (minus `holes`). */
  async function archiveIndexedThrough(ledger: number, holes: [number, number][] = []) {
    await h.pool.query(
      `INSERT INTO indexer_cursors (contract_id, start_ledger, cursor_ledger) VALUES ($1, 1, $2)
       ON CONFLICT (contract_id) DO UPDATE SET start_ledger = 1, cursor_ledger = $2`,
      [fake.contractId, ledger],
    );
    let from = 1;
    for (const [a, b] of [...holes, [ledger + 1, ledger + 1] as [number, number]]) {
      if (a > from) {
        await h.pool.query(
          `INSERT INTO indexed_ranges (contract_id, from_ledger, to_ledger, event_count)
           VALUES ($1, $2, $3, 0)`,
          [fake.contractId, from, a - 1],
        );
      }
      from = b + 1;
    }
  }
  const signedAfter = async () =>
    Number(
      (
        await h.pool.query<{ l: string }>(
          `SELECT signed_after_ledger AS l FROM chain_transactions WHERE purpose = 'mint'`,
        )
      ).rows[0]?.l,
    );
  const mintStatus = async (depositId: string) =>
    (
      await h.pool.query<{ status: string }>(
        'SELECT status FROM mint_requests WHERE deposit_id = $1 ORDER BY created_at DESC LIMIT 1',
        [depositId],
      )
    ).rows[0]?.status;

  describe('gap A: outside RPC retention, the event archive decides', () => {
    it('settles as minted, and keeps the lot frozen, when the archive has the lot’s minted event', async () => {
      const lot = await anchoredLot(h);
      fake.failNextCall('mint_from_anchor', 'landed_unseen'); // it landed; we never heard
      expect((await pledge(h, lot.depositId)).status).toBe(202);

      fake.retentionLost = true;
      h.clock.advance(3 * 86_400_000); // a long outage
      await archiveMinted(lot.depositNo, '1', fake.ledger);
      await archiveIndexedThrough(fake.ledger);
      await h.pledges.resolvePending();

      expect(await lotState(h, lot.depositId)).toMatchObject({
        status: 'minted',
        chain_receipt_id: '1',
      });
      expect((await lotState(h, lot.depositId))?.frozen_for_mint).not.toBeNull();
      expect(await mintStatus(lot.depositId)).toBe('minted');
    });

    it('unfreezes only when the archive is indexed past max_time and holds no minted event', async () => {
      const lot = await anchoredLot(h);
      fake.failNextCall('mint_from_anchor', 'timeout'); // never lands
      expect((await pledge(h, lot.depositId)).status).toBe(202);

      fake.retentionLost = true;
      h.clock.advance(3 * 86_400_000);
      await archiveIndexedThrough(fake.ledger);
      await h.pledges.resolvePending();

      expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
      expect(await mintStatus(lot.depositId)).toBe('failed');
    });

    it('keeps the lot frozen when the archive has a hole where the mint could be, even with its cursor past max_time', async () => {
      const lot = await anchoredLot(h);
      fake.failNextCall('mint_from_anchor', 'timeout');
      expect((await pledge(h, lot.depositId)).status).toBe(202);

      fake.retentionLost = true;
      h.clock.advance(3 * 86_400_000);
      const signed = await signedAfter();
      // The cursor is past max_time, but ledgers just after the signing were never archived.
      await archiveIndexedThrough(fake.ledger, [[signed, signed + 1]]);
      await h.pledges.resolvePending();

      expect((await lotState(h, lot.depositId))?.frozen_for_mint).not.toBeNull();
      expect(await mintStatus(lot.depositId)).not.toBe('failed');
      const alert = await h.pool.query<{
        severity: string;
        details: { archive_holes: number[][] };
      }>(`SELECT severity, details FROM alerts WHERE alert_key LIKE 'mint_undetermined:%'`);
      expect(alert.rows.map((a) => a.severity)).toEqual(['urgent']);
      // Reported as a hole starting where the mint could first have landed.
      expect(alert.rows[0]?.details.archive_holes[0]?.[0]).toBe(signed);
    });

    it('keeps the lot frozen and pages urgently while the archive cannot yet tell', async () => {
      const lot = await anchoredLot(h);
      fake.failNextCall('mint_from_anchor', 'timeout');
      expect((await pledge(h, lot.depositId)).status).toBe(202);

      fake.retentionLost = true;
      h.clock.advance(3 * 86_400_000);
      await archiveIndexedThrough(fake.ledger - 5); // indexing is behind
      await h.pledges.resolvePending();

      expect((await lotState(h, lot.depositId))?.frozen_for_mint).not.toBeNull();
      expect(await mintStatus(lot.depositId)).not.toBe('failed');
      const open = await h.alerts.open('pledges');
      expect(open.map((a) => a.severity)).toEqual(['urgent']);
      expect(open[0]?.key).toMatch(/^mint_undetermined:/);
    });
  });

  describe('gap C: a queued mint never outlives the deadline fixed at freeze', () => {
    it('keeps an unrecorded mint frozen until a ledger closes after its deadline; the queued call is then refused unsigned', async () => {
      const lot = await anchoredLot(h);
      let release: () => void = () => undefined;
      const queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      fake.beforeMint = () => queue;
      const response = pledge(h, lot.depositId).then((res) => res);
      await expect
        .poll(async () => (await h.pool.query('SELECT 1 FROM mint_requests')).rowCount)
        .toBe(1);

      // Still before the deadline: the queued call could still be signed.
      h.clock.advance((MINT_MAX_TIME_SECONDS - 1) * 1000);
      await h.pledges.resolvePending();
      expect((await lotState(h, lot.depositId))?.frozen_for_mint).not.toBeNull();

      // A ledger has closed after the deadline: nothing built from now on can land.
      h.clock.advance(2_000);
      await h.pledges.resolvePending();
      expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();

      release();
      const res = await response;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: 'mint_deadline_passed' } });
      const recorded = await h.pool.query(
        `SELECT 1 FROM chain_transactions WHERE purpose = 'mint'`,
      );
      expect(recorded.rowCount).toBe(0);
      expect(fake.receipts.size).toBe(0);
    });
  });
});
