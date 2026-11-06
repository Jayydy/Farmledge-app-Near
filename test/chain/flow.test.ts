import { Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { utcDay } from '../../src/domain/book.js';
import { startChainHarness, middayOf, type ChainHarness } from '../helpers/chainHarness.js';
import { lenderSigns, type FakeChain } from '../helpers/fakeChain.js';

const DAY = utcDay(new Date('2026-10-01T00:00:00Z'));

describe('anchor, prove, mint, lock (contract double)', () => {
  let h: ChainHarness;
  const lender = Keypair.random();

  beforeAll(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
  });
  afterAll(async () => {
    await h.close();
  });

  it('closes a day into a tree, anchors it, mints from the balance leaf and locks with the lender’s signature', async () => {
    const lot = await h.scaleLot(20);
    h.clock.set(middayOf(DAY + 1));
    const reports = await h.anchoring.runDaily();
    const { warehouseId, otherWarehouseId } = h.fixtures;
    expect(reports.find((r) => r.warehouseId === warehouseId)).toEqual(
      expect.objectContaining({ day: DAY, closed: 'built', anchored: true, leaves: 3 }),
    );
    // The idle warehouse is anchored from its registration day too (D53).
    expect(reports.find((r) => r.warehouseId === otherWarehouseId)).toEqual(
      expect.objectContaining({ day: DAY, closed: 'built', anchored: true, sentinel: true }),
    );
    expect(reports).toHaveLength(2);
    await h.indexer.ingest(); // the 5-minute index job: the pre-claim gate needs it

    const res = await request(h.app)
      .post('/pledges')
      .send({
        deposit_id: lot.depositId,
        lender: lender.publicKey(),
        kg: 1995,
        loan_ref: 'LOAN-0001',
        due_date: new Date(middayOf(DAY + 90)).toISOString(),
        grace_period_seconds: 86_400,
        requested_by: h.fixtures.custodianId,
        verifier_id: h.fixtures.verifierId,
        farmer_confirmed: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const pledge = (
      res.body as {
        pledge: {
          pledge_id: string;
          status: string;
          receipt_id: string;
          lender_authorization: { entry_xdr: string; valid_until_ledger: number };
        };
      }
    ).pledge;
    expect(pledge.status).toBe('awaiting_lender_signature');
    expect(pledge.receipt_id).toBe('1');

    const signed = await lenderSigns(
      pledge.lender_authorization.entry_xdr,
      lender,
      pledge.lender_authorization.valid_until_ledger,
    );
    const locked = await request(h.app)
      .post(`/pledges/${pledge.pledge_id}/lender-signature`)
      .send({ signed_entry_xdr: signed });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body).toMatchObject({ pledge: { status: 'locked', locked_receipt_id: '1' } });
    expect((h.chain as FakeChain).receipts.get('1')?.status).toBe('Locked');
  });
});
