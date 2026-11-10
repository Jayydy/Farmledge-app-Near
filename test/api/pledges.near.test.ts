import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addressFor, OPERATOR_SUBJECT, subjectOf } from '../../src/chain/addresses.js';
import type { NearOfferTxRequest } from '../../src/chain/chainClient.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeNearChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY, pledge } from '../invariants/helpers.js';

interface NearPledgeResponse {
  pledge: {
    pledge_id: string;
    deposit_id: string;
    deposit_no: number;
    status: string;
    lender: string;
    kg: number;
    loan_ref: string;
    due_date: string;
    grace_period_seconds: number;
    receipt_id: string | null;
    locked_receipt_id: string | null;
    lender_authorization: null;
    lender_tx_request: NearOfferTxRequest | null;
    failure: string | null;
    failure_code: string | null;
  };
}

describe('NEAR pledge API flow (POST /pledges -> POST /pledges/:id/lender-offer)', () => {
  let h: ChainHarness;
  let fake: FakeNearChain;

  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY), backend: 'near' });
    fake = h.chain as FakeNearChain;
  });

  afterEach(async () => {
    await h.close();
  });

  it('freezes the lot, mints on NEAR, returns awaiting_lender_offer + lender_tx_request, verifies offer_lock, and locks via accept_lock', async () => {
    const lot = await anchoredLot(h);
    const lender = 'lender-bank.testnet';

    const step1 = await pledge(h, lot.depositId, { lender, kg: 1000, loan_ref: 'LOAN-NEAR-1' });
    expect(step1.status).toBe(201);
    const { pledge: p1 } = step1.body as NearPledgeResponse;
    expect(p1).toMatchObject({
      deposit_id: lot.depositId,
      status: 'awaiting_lender_offer',
      lender,
      kg: 1000,
      loan_ref: 'LOAN-NEAR-1',
      receipt_id: '1',
      locked_receipt_id: null,
      lender_authorization: null,
    });
    expect(p1.lender_tx_request).toMatchObject({
      receiverId: fake.contractId,
      methodName: 'lock_offer',
      args: {
        receipt_id: '1',
        amount_kg: '1000',
        loan_ref: 'LOAN-NEAR-1',
        grace_period_seconds: 86_400,
      },
      gas: '30000000000000',
      deposit: '1',
    });

    const reqArgs = p1.lender_tx_request?.args;
    if (reqArgs === undefined) throw new Error('missing lender_tx_request.args');

    // Lender submits offer_lock from their own wallet
    const offerTxHash = fake.recordOfferLock({
      signerId: lender,
      args: { ...reqArgs },
    });

    const step2 = await request(h.app)
      .post(`/pledges/${p1.pledge_id}/lender-offer`)
      .send({ txHash: offerTxHash });
    expect(step2.status).toBe(200);
    expect(step2.body).toMatchObject({
      pledge: {
        pledge_id: p1.pledge_id,
        status: 'locked',
        receipt_id: '1',
        locked_receipt_id: '1',
        failure: null,
      },
    });

    // Only the farmer signed accept_lock; never the lender
    expect(fake.signedFor.filter((s) => s.method === 'lock')).toEqual([
      { method: 'lock', subject: subjectOf.farmer(h.fixtures.farmerId) },
    ]);

    // Persisted lender_offer_tx_hash in DB
    const dbRow = await h.pool.query<{ lender_offer_tx_hash: string | null }>(
      'SELECT lender_offer_tx_hash FROM pledges WHERE id = $1',
      [p1.pledge_id],
    );
    expect(dbRow.rows[0]?.lender_offer_tx_hash).toBe(offerTxHash);
  });

  it('rejects invalid NEAR lender account IDs and any key managed by Farmledge (D31)', async () => {
    const lot = await anchoredLot(h);

    for (const invalidLender of ['INVALID_UPPERCASE.testnet', 'a', 'bad..account.testnet']) {
      const res = await pledge(h, lot.depositId, { lender: invalidLender });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: { details: [expect.objectContaining({ code: 'invalid_lender' })] },
      });
    }

    for (const subject of [
      OPERATOR_SUBJECT,
      subjectOf.farmer(h.fixtures.farmerId),
      subjectOf.custodian(h.fixtures.custodianId),
      subjectOf.verifier(h.fixtures.verifierId),
    ]) {
      const managedImplicit = await addressFor(h.adapters.keys, subject, 'near');
      const res = await pledge(h, lot.depositId, { lender: managedImplicit });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: { details: [expect.objectContaining({ code: 'invalid_lender' })] },
      });
    }

    expect(fake.receipts.size).toBe(0);
  });

  it('rejects unknown, failed, impostor-signed, wrong-contract, wrong-method, or tampered offer_lock txs and keeps the pledge in awaiting_lender_offer', async () => {
    const lot = await anchoredLot(h);
    const lender = 'lender-bank.testnet';
    const step1 = await pledge(h, lot.depositId, { lender, kg: 1000, loan_ref: 'LOAN-NEAR-2' });
    const { pledge: p1 } = step1.body as NearPledgeResponse;
    const reqArgs = p1.lender_tx_request?.args;
    if (reqArgs === undefined) throw new Error('missing lender_tx_request.args');

    // 1. Unknown tx hash
    const resUnknown = await request(h.app)
      .post(`/pledges/${p1.pledge_id}/lender-offer`)
      .send({ txHash: '11111111111111111111111111111111111111111111' });
    expect(resUnknown.status).toBe(400);

    // 2. Failed on-chain offer_lock tx
    const failedHash = fake.recordOfferLock({
      signerId: lender,
      args: { ...reqArgs },
      failed: true,
    });
    const resFailed = await request(h.app)
      .post(`/pledges/${p1.pledge_id}/lender-offer`)
      .send({ txHash: failedHash });
    expect(resFailed.status).toBe(400);

    // 3. Impostor signer (signed by someone other than lender)
    const impostorHash = fake.recordOfferLock({
      signerId: 'impostor.testnet',
      args: { ...reqArgs },
    });
    const resImpostor = await request(h.app)
      .post(`/pledges/${p1.pledge_id}/lender-offer`)
      .send({ txHash: impostorHash });
    expect(resImpostor.status).toBe(400);

    // 4. Wrong contract receiver
    const wrongContractHash = fake.recordOfferLock({
      signerId: lender,
      receiverId: 'evil.farmledge.testnet',
      args: { ...reqArgs },
    });
    const resWrongContract = await request(h.app)
      .post(`/pledges/${p1.pledge_id}/lender-offer`)
      .send({ txHash: wrongContractHash });
    expect(resWrongContract.status).toBe(400);

    // 5. Tampered amount_kg argument
    const tamperedKgHash = fake.recordOfferLock({
      signerId: lender,
      args: { ...reqArgs, amount_kg: '1995' },
    });
    const resTampered = await request(h.app)
      .post(`/pledges/${p1.pledge_id}/lender-offer`)
      .send({ txHash: tamperedKgHash });
    expect(resTampered.status).toBe(400);

    // Still awaiting_lender_offer and no accept_lock transaction was signed
    const current = await request(h.app).get(`/pledges/${p1.pledge_id}`).expect(200);
    expect((current.body as NearPledgeResponse).pledge.status).toBe('awaiting_lender_offer');
    expect(fake.signedFor.filter((s) => s.method === 'lock')).toEqual([]);

    // 6. Valid offer_lock using snake_case `lender_offer_tx_hash` succeeds
    const validHash = fake.recordOfferLock({
      signerId: lender,
      args: { ...reqArgs },
    });
    const resOk = await request(h.app)
      .post(`/pledges/${p1.pledge_id}/lender-offer`)
      .send({ lender_offer_tx_hash: validHash });
    expect(resOk.status).toBe(200);
    expect((resOk.body as NearPledgeResponse).pledge.status).toBe('locked');
  });
});
