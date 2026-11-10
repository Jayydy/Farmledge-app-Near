import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cutoffOf } from '../../src/domain/book.js';
import { ANCHOR_RETRY_EVERY_MS } from '../../src/services/anchoring.js';
import { indexJob } from '../../src/services/jobs.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { DAY } from './helpers.js';

/**
 * INV-5 alerting outside the daily run. A missed anchor is urgent 2 h after
 * the cutoff, so it is checked from the 5-minute index job, and anchoring
 * is retried there at most hourly while a day is due. A daily-only check
 * would first notice a failed anchor about 24 h later.
 */
describe.each(['stellar', 'near'] as const)(
  'INV-5: missed anchors are caught and retried between daily runs (%s)',
  (backend) => {
    let h: ChainHarness;
    let fake: FakeChain;
    beforeEach(async () => {
      // Only the lot's warehouse is due: the contract registers the other
      // later, so the injected failures hit the anchor under test.
      h = await startChainHarness({
        start: middayOf(DAY),
        backend,
        onChain: { otherWarehouseId: middayOf(DAY + 30) },
      });
      fake = h.chain as FakeChain;
    });
  afterEach(async () => {
    await h.close();
  });

  const anchoredDays = async () =>
    (
      await h.pool.query<{ day: number }>(
        'SELECT day FROM book_anchors WHERE warehouse_id = $1 ORDER BY day',
        [h.fixtures.warehouseId],
      )
    ).rows.map((r) => r.day);

  it('retries a failed anchor at most once an hour, until the day is anchored', async () => {
    await h.scaleLot(5);
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 5 * 60_000));
    fake.failNextCall('anchor', 'simulation'); // the daily run fails
    await h.anchoring.runDaily();
    expect(await anchoredDays()).toEqual([]);

    // The first retry claims the hour, but the contract refuses again.
    fake.failNextCall('anchor', 'simulation');
    expect(await h.anchoring.retryIfDue()).toBe(true);
    expect(await anchoredDays()).toEqual([]);
    // Still due, but within the hour: no second attempt.
    h.clock.advance(30 * 60_000);
    expect(await h.anchoring.retryIfDue()).toBe(false);

    h.clock.advance(ANCHOR_RETRY_EVERY_MS);
    expect(await h.anchoring.retryIfDue()).toBe(true);
    expect(await anchoredDays()).toEqual([DAY]);
    // Nothing due any more: no run at all.
    h.clock.advance(ANCHOR_RETRY_EVERY_MS);
    expect(await h.anchoring.retryIfDue()).toBe(false);
  });

  it('raises the urgent missed-anchor alert from the index job, even when indexing fails', async () => {
    await h.scaleLot(5);
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 3 * 3_600_000)); // 3 h past the cutoff
    fake.failNextCall('anchor', 'simulation'); // the retry inside the job fails too
    const broken = {
      ingest: () => Promise.reject(new Error('RPC unreachable')),
    };

    await expect(
      indexJob({ indexer: broken, reconciliation: h.reconciliation, anchoring: h.anchoring }),
    ).rejects.toThrow(/RPC unreachable/);

    expect(await h.alerts.open('anchoring')).toContainEqual({
      key: `anchor_missed:${h.fixtures.warehouseId}:${DAY}`,
      severity: 'urgent',
    });
  });
  },
);
