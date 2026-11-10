import { randomUUID } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/logger.js';
import { PledgeService, type PledgeInput } from '../../src/services/pledges.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY, lotState, pledge } from './helpers.js';

interface PledgeBody {
  pledge: { pledge_id: string; status: string };
}

/**
 * INV-1 at the API: a mint's outcome may outlive the request. The caller
 * must hear "unknown, still resolving" (202 `minting`) before any client or
 * proxy timeout, never a timeout it would read as failure, and a retry after
 * a lost response must find the same pledge, not a refusal.
 */
describe.each(['stellar', 'near'] as const)(
  'INV-1: the pledge response never turns "unknown" into "failed" (%s)',
  (backend) => {
    let h: ChainHarness;
    let fake: FakeChain;
    beforeEach(async () => {
      h = await startChainHarness({ start: middayOf(DAY), backend });
      fake = h.chain as FakeChain;
    });
    afterEach(async () => {
      await (h as ChainHarness | undefined)?.close();
    });

    const input = (depositId: string): PledgeInput => ({
      depositId,
      lender: backend === 'near' ? 'lender-bank.testnet' : Keypair.random().publicKey(),
      kg: 1000,
      loanRef: 'LOAN-0001',
      dueDate: new Date(h.clock.now().getTime() + 90 * 86_400_000),
      gracePeriodSeconds: 86_400,
      requestedBy: h.fixtures.custodianId,
      verifierId: h.fixtures.verifierId,
      farmerConfirmed: true,
    });
    /** A PledgeService that answers after 50 ms instead of 20 s. */
    const quick = () =>
      new PledgeService(
        h.pool,
        h.chain,
        h.adapters.keys,
        h.adapters.confirmation,
        h.alerts,
        createLogger('silent'),
        h.clock.now,
        50,
      );
    const holdMints = () => {
      let release: () => void = () => undefined;
      const queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      fake.beforeMint = () => queue;
      return () => {
        fake.beforeMint = null;
        release();
      };
    };

    it('answers `minting` within the budget while the mint is still queued, then settles it in the background', async () => {
      const lot = await anchoredLot(h);
      const release = holdMints();
      const svc = quick();

      const started = Date.now();
      const view = await svc.pledge(input(lot.depositId));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(view.status).toBe('minting');
      expect((await lotState(h, lot.depositId))?.frozen_for_mint).not.toBeNull();

      release();
      await expect
        .poll(async () => (await svc.get(view.pledge_id)).status)
        .toBe(backend === 'near' ? 'awaiting_lender_offer' : 'awaiting_lender_signature');
      expect(await lotState(h, lot.depositId)).toMatchObject({ status: 'minted' });
    });

  it('records a refusal that arrives after the response on the pledge, with its cause, never as an unhandled error', async () => {
    const lot = await anchoredLot(h);
    const release = holdMints();
    const svc = quick();
    const view = await svc.pledge(input(lot.depositId));
    expect(view.status).toBe('minting');

    fake.failNextCall('mint_from_anchor', 'ledger_stale');
    release();
    await expect.poll(async () => (await svc.get(view.pledge_id)).status).toBe('failed');
    expect(await svc.get(view.pledge_id)).toMatchObject({ failure_code: 'books_not_anchored' });
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
  });

  it('a retry with the same pledge_id after a lost response returns that pledge, not a refusal', async () => {
    const lot = await anchoredLot(h);
    fake.failNextCall('mint_from_anchor', 'timeout'); // outcome unknown
    const pledgeId = randomUUID();

    const first = await pledge(h, lot.depositId, { pledge_id: pledgeId });
    expect(first.status).toBe(202);
    const retry = await pledge(h, lot.depositId, { pledge_id: pledgeId });
    expect(retry.status).toBe(202);
    expect((retry.body as PledgeBody).pledge).toMatchObject({
      pledge_id: pledgeId,
      status: 'minting',
    });
    expect((await h.pool.query('SELECT 1 FROM pledges')).rowCount).toBe(1);

    // A different pledge for the same lot is refused, naming the live one to follow.
    const other = await pledge(h, lot.depositId, { pledge_id: randomUUID() });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({
      error: { code: 'lot_already_pledged', details: { pledge_id: pledgeId } },
    });
  });

  it('refuses a pledge_id already used for another lot', async () => {
    const lot = await anchoredLot(h);
    const pledgeId = randomUUID();
    expect((await pledge(h, lot.depositId, { pledge_id: pledgeId })).status).toBe(201);
    const reused = await pledge(h, randomUUID(), { pledge_id: pledgeId });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: { code: 'pledge_id_conflict' } });
  });
  },
);
