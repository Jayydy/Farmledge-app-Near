import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cutoffOf } from '../../src/domain/book.js';
import { entryHash, foldProof, nextHead } from '../../src/domain/merkle.js';
import type { ProofBundle } from '../../src/services/proofs.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY } from './helpers.js';

/** What a verifier does with a bundle and the chain's head, nothing else. */
function verifies(bundle: ProofBundle, chainHead: Buffer): boolean {
  const root = foldProof(
    entryHash(bundle.leaf),
    bundle.leaf.index,
    bundle.proof.map((p) => Buffer.from(p, 'hex')),
  );
  let head = nextHead(
    Buffer.from(bundle.prev_head, 'hex'),
    bundle.leaf.day,
    bundle.day_leaves,
    root,
  );
  for (const d of bundle.later_days)
    head = nextHead(head, d.day, d.leaves, Buffer.from(d.root, 'hex'));
  return head.equals(chainHead);
}

/**
 * INV-7. Every farmer gets their proofs, automatically, and verification
 * never goes through Farmledge.
 */
describe('INV-7 every farmer gets their proofs', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
    fake = h.chain as FakeChain;
  });
  afterEach(async () => {
    await h.close();
  });

  it('carries the deposit leaf and salt on the counter slip, before any anchor', async () => {
    const lot = await h.scaleLot(10);
    const res = await request(h.app).get(`/deposits/${lot.depositId}/slip`).expect(200);
    const { proofs } = res.body as {
      proofs: { leaf: { kind: number; salt: string; day: number }; qr_payload: string }[];
    };
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.leaf).toMatchObject({ kind: 0, day: DAY });
    expect(proofs[0]?.leaf.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(proofs[0]?.qr_payload ?? '{}')).toEqual(proofs[0]?.leaf);
  });

  it('texts every deposit and dispatch bundle automatically once the day is anchored; each checks against the chain alone', async () => {
    const lot = await h.scaleLot(10);
    await h.dispatch({ bag_count: 2, deposit_id: lot.depositId });
    h.clock.set(middayOf(DAY + 1));
    await h.anchoring.runDaily();
    const before = h.sms.sent.length;
    expect(await h.proofs.deliverAnchored()).toBe(2);
    const texts = h.sms.sent.slice(before);
    expect(texts).toHaveLength(2);
    const tokens = texts.map((t) => /\/([A-Za-z0-9_-]{22,})$/.exec(t.body)?.[1]);
    for (const token of tokens) {
      // Public, no login.
      const bundle = (await request(h.app).get(`/proofs/${token}`).expect(200)).body as ProofBundle;
      expect(bundle.contract_id).toBe(fake.contractId);
      expect(verifies(bundle, fake.heads.get('KN_DAWANAU')?.head ?? Buffer.alloc(0))).toBe(true);
    }
    const receipts = await h.pool.query<{ status: string; provider_message_id: string }>(
      'SELECT status, provider_message_id FROM proof_deliveries',
    );
    expect(
      receipts.rows.every((r) => r.status === 'sent' && r.provider_message_id.startsWith('mock-')),
    ).toBe(true);
    // Never twice.
    expect(await h.proofs.deliverAnchored()).toBe(0);
  });

  it('retries a failed SMS, and pages if a bundle is still undelivered 24 h after the cutoff', async () => {
    await anchoredLot(h);
    const send = h.sms.send.bind(h.sms);
    h.sms.send = () => Promise.reject(new Error('provider down'));
    await h.proofs.deliverAnchored();
    h.clock.set(new Date(cutoffOf(DAY).getTime() + 25 * 3_600_000));
    await h.proofs.checkDeliveries();
    expect((await h.alerts.open('proofs')).map((a) => a.key)).toHaveLength(1);

    h.sms.send = send;
    await h.proofs.sendQueued();
    const row = await h.pool.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM proof_deliveries',
    );
    expect(row.rows).toEqual([{ status: 'sent', attempts: 2 }]);
  });

  it('issues a statement with a fresh balance proof every 28 days, and pages when a holder’s newest proof is 30 days old', async () => {
    await anchoredLot(h);
    expect(await h.proofs.issueStatements()).toBe(1);
    expect(await h.proofs.issueStatements()).toBe(0);
    const statement = await h.pool.query<{ token: string }>('SELECT token FROM farmer_statements');
    const res = await request(h.app)
      .get(`/proofs/statements/${statement.rows[0]?.token}`)
      .expect(200);
    const body = res.body as { bundles: ProofBundle[] };
    expect(body.bundles.map((b) => b.leaf.kind)).toEqual([2]);

    // 31 days on, anchors kept running but no statement went out.
    for (let d = DAY + 1; d <= DAY + 31; d++) {
      h.clock.set(middayOf(d + 1));
      await h.anchoring.runWarehouse(h.fixtures.warehouseId);
    }
    await h.proofs.checkDeliveries();
    expect((await h.alerts.open('proofs')).map((a) => a.key)).toContainEqual(
      expect.stringMatching(/^proof_stale:/),
    );
    expect(await h.proofs.issueStatements()).toBe(1);
  });
});
