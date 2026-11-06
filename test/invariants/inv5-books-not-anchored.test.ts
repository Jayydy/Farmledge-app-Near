import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MINT_MAX_TIME_SECONDS } from '../../src/services/pledges.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY, lotState, pledge } from './helpers.js';

interface PledgeBody {
  pledge: {
    pledge_id: string;
    status: string;
    failure: string | null;
    failure_code: string | null;
  };
}

/**
 * backend-requirements §3: a mint refused because the warehouse's anchor is
 * missing or stale is reported as "the warehouse's books are not anchored
 * for today", naming the warehouse and its last anchored day, whether the
 * contract refuses it in simulation, on-ledger, or resolve-pending finds it
 * later. Never a generic failure.
 */
describe('a mint blocked by a missing or stale anchor reports that cause', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
    fake = h.chain as FakeChain;
  });
  afterEach(async () => {
    await h.close();
  });

  const expectBooksNotAnchored = (body: unknown, cause: string) => {
    const { error } = body as { error: { code: string; message: string; details: unknown } };
    expect(error.code).toBe('books_not_anchored');
    expect(error.message).toMatch(/^The warehouse's books are not anchored for today: /);
    expect(error.details).toMatchObject({
      warehouse_id: 'KN_DAWANAU',
      last_anchored_day: DAY,
      cause,
    });
  };

  it('in simulation: the chain moved to a newer anchor while the pledge was being built', async () => {
    const lot = await anchoredLot(h);
    fake.beforeMint = () => {
      const head = fake.heads.get('KN_DAWANAU');
      if (head !== undefined) fake.heads.set('KN_DAWANAU', { day: DAY + 1, head: head.head });
      return Promise.resolve();
    };
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(409);
    expectBooksNotAnchored(res.body, 'stale');
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
  });

  it('on-ledger StaleLeaf: the same 409, and the pledge records the code', async () => {
    const lot = await anchoredLot(h);
    fake.failNextCall('mint_from_anchor', 'ledger_stale');
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(409);
    expectBooksNotAnchored(res.body, 'stale');
    const pledged = await h.pool.query<{ failure_code: string; failure: string }>(
      'SELECT failure_code, failure FROM pledges',
    );
    expect(pledged.rows.map((r) => r.failure_code)).toEqual(['books_not_anchored']);
    expect(pledged.rows[0]?.failure).toContain('KN_DAWANAU');
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
  });

  it('on-ledger NoAnchor: reported as a missing anchor', async () => {
    const lot = await anchoredLot(h);
    fake.failNextCall('mint_from_anchor', 'ledger_noanchor');
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(409);
    expectBooksNotAnchored(res.body, 'missing');
  });

  it('found later by resolve-pending: the pledge fails with the specific cause, not a generic one', async () => {
    const lot = await anchoredLot(h);
    fake.failNextCall('mint_from_anchor', 'timeout');
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(202);
    const pledgeId = (res.body as PledgeBody).pledge.pledge_id;
    // RPC now reports the transaction failed on-ledger with StaleLeaf.
    await h.pool.query(
      `UPDATE chain_transactions SET status = 'failed', resolved_at = now(),
              error = 'failed on-ledger: Error(Contract, #51) (3 diagnostic events)'
        WHERE purpose = 'mint'`,
    );
    h.clock.advance((MINT_MAX_TIME_SECONDS - 60) * 1000);
    await h.pledges.resolvePending();

    const view = await h.pledges.get(pledgeId);
    expect(view).toMatchObject({ status: 'failed', failure_code: 'books_not_anchored' });
    expect(view.failure).toMatch(
      new RegExp(
        `^The warehouse's books are not anchored for today: KN_DAWANAU's last anchored day is ${DAY}`,
      ),
    );
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
  });
});
