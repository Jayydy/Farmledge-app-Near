import type { rpc } from '@stellar/stellar-sdk';
import { Account, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addressFor, OPERATOR_SUBJECT, subjectOf } from '../../src/chain/addresses.js';
import type { NearOfferTxRequest } from '../../src/chain/chainClient.js';
import { LenderAuthError, SorobanChainClient } from '../../src/chain/sorobanChainClient.js';
import { LocalDevKeyService } from '../../src/keys/localDevKeyService.js';
import { createLogger } from '../../src/logger.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import {
  FAKE_CONTRACT,
  lenderEntry,
  lenderSigns,
  type FakeChain,
  type FakeNearChain,
} from '../helpers/fakeChain.js';
import { anchoredLot, DAY, pledge } from './helpers.js';

interface PledgeBody {
  pledge: {
    pledge_id: string;
    status: string;
    lender_authorization: { entry_xdr: string; valid_until_ledger: number };
  };
}

/**
 * D31. We never hold a lender's key: the lock is two-step, and no code path
 * can sign on a lender's behalf, as a fallback or otherwise.
 */
describe('D31 no code path signs for a lender', () => {
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY) });
    fake = h.chain as FakeChain;
  });
  afterEach(async () => {
    await (h as ChainHarness | undefined)?.close();
  });

  it('the key service holds no lender key: it refuses any subject that is not ours', async () => {
    const keys = new LocalDevKeyService('a-test-secret-that-is-long-enough-123456', 'test', h.pool);
    await expect(keys.publicKey('lender:bank-1')).rejects.toThrow(/no key is held/);
    await expect(keys.sign('lender:bank-1', Buffer.from('x'), { purpose: 'lock' })).rejects.toThrow(
      /no key is held/,
    );
    await expect(keys.sign('anyone', Buffer.from('x'), { purpose: 'lock' })).rejects.toThrow(
      /no key is held/,
    );
  });

  it('refuses a lender address that is any key Farmledge holds (the operator, the farmer, staff)', async () => {
    const lot = await anchoredLot(h);
    for (const subject of [
      OPERATOR_SUBJECT,
      subjectOf.farmer(h.fixtures.farmerId),
      subjectOf.custodian(h.fixtures.custodianId),
    ]) {
      const res = await pledge(h, lot.depositId, {
        lender: await addressFor(h.adapters.keys, subject),
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: { details: [expect.objectContaining({ code: 'invalid_lender' })] },
      });
    }
    expect(fake.receipts.size).toBe(0);
  });

  it('submits nothing without the lender’s own valid signature over exactly this lock', async () => {
    const lot = await anchoredLot(h);
    const lender = Keypair.random();
    const res = await pledge(h, lot.depositId, { lender: lender.publicKey() });
    const { pledge: p } = res.body as PledgeBody;
    const auth = p.lender_authorization;
    const locks = () => h.pool.query(`SELECT 1 FROM chain_transactions WHERE purpose = 'lock'`);

    // Unsigned, as handed out: refused.
    const unsigned = await request(h.app)
      .post(`/pledges/${p.pledge_id}/lender-signature`)
      .send({ signed_entry_xdr: auth.entry_xdr });
    expect(unsigned.status).toBe(400);
    // Signed by someone else's key: refused.
    const impostor = await lenderSigns(auth.entry_xdr, Keypair.random(), auth.valid_until_ledger);
    expect(
      (
        await request(h.app)
          .post(`/pledges/${p.pledge_id}/lender-signature`)
          .send({ signed_entry_xdr: impostor })
      ).status,
    ).toBe(400);
    // The lender's signature over a different lock (more kg): refused.
    const other = lenderEntry(
      {
        receiptId: 1n,
        lender: lender.publicKey(),
        kg: 1995n,
        loanRef: 'LOAN-0001',
        dueDate: 0,
        gracePeriodSeconds: 86_400,
      },
      FAKE_CONTRACT,
      auth.valid_until_ledger,
    );
    const wrongLock = await lenderSigns(other.toXdr('base64'), lender, auth.valid_until_ledger);
    expect(
      (
        await request(h.app)
          .post(`/pledges/${p.pledge_id}/lender-signature`)
          .send({ signed_entry_xdr: wrongLock })
      ).status,
    ).toBe(400);

    expect((await locks()).rowCount).toBe(0);
    expect(fake.signedFor.filter((s) => s.method === 'lock')).toEqual([]);
    // Only the lender's real signature locks; we sign only the owner's part.
    const good = await lenderSigns(auth.entry_xdr, lender, auth.valid_until_ledger);
    const locked = await request(h.app)
      .post(`/pledges/${p.pledge_id}/lender-signature`)
      .send({ signed_entry_xdr: good });
    expect(locked.body).toMatchObject({ pledge: { status: 'locked' } });
    expect(fake.signedFor.filter((s) => s.method === 'lock')).toEqual([
      { method: 'lock', subject: subjectOf.farmer(h.fixtures.farmerId) },
    ]);
  });

  it('the Soroban client signs only for the subjects a call names: an unexpected signer is refused, not signed for', async () => {
    const keys = new LocalDevKeyService('a-test-secret-that-is-long-enough-123456', 'test', h.pool);
    const client = new SorobanChainClient(
      {
        rpcUrl: 'https://rpc.invalid',
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractId: FAKE_CONTRACT,
        operatorSubject: OPERATOR_SUBJECT,
      },
      keys,
      createLogger('silent'),
    );
    const lender = Keypair.random();
    const signed: string[] = [];
    const realSign = keys.sign.bind(keys);
    keys.sign = (subject, payload, context) => {
      signed.push(subject);
      return realSign(subject, payload, context);
    };
    // A simulation that (for whatever reason) asks the lender to authorise.
    const entry = lenderEntry(
      {
        receiptId: 1n,
        lender: lender.publicKey(),
        kg: 1n,
        loanRef: 'x',
        dueDate: 1,
        gracePeriodSeconds: 0,
      },
      FAKE_CONTRACT,
      100,
    );
    const operator = await addressFor(keys, OPERATOR_SUBJECT);
    (client as unknown as { server: Partial<rpc.Server> }).server = {
      getAccount: () => Promise.resolve(new Account(operator, '1')),
      getLatestLedger: () => Promise.resolve({ sequence: 10 } as rpc.Api.GetLatestLedgerResponse),
      simulateTransaction: () =>
        Promise.resolve({
          result: { auth: [entry], retval: nativeToScVal(1, { type: 'u32' }) },
        } as unknown as rpc.Api.SimulateTransactionResponse),
    };
    await expect(client.extendTtlBatch(h.pool, [1n])).rejects.toThrow(/may not sign for/);
    expect(signed).toEqual([]);
    // And a lock with an unsigned lender entry never gets as far as the network.
    await expect(
      client.submitLock(
        h.pool,
        {
          receiptId: 1n,
          lender: lender.publicKey(),
          kg: 1n,
          loanRef: 'x',
          dueDate: 1,
          gracePeriodSeconds: 0,
        },
        entry.toXdr('base64'),
        subjectOf.farmer(h.fixtures.farmerId),
        'lock:test',
      ),
    ).rejects.toBeInstanceOf(LenderAuthError);
    expect(signed).toEqual([]);
  });

  it('enforces D31 on NEAR: refuses Farmledge-held implicit accounts as lender and signs lock_accept only after a verified lender offer_lock tx', async () => {
    const nearHarness = await startChainHarness({ start: middayOf(DAY), backend: 'near' });
    try {
      const nearFake = nearHarness.chain as FakeNearChain;
      const lot = await anchoredLot(nearHarness);
      for (const subject of [
        OPERATOR_SUBJECT,
        subjectOf.farmer(nearHarness.fixtures.farmerId),
        subjectOf.custodian(nearHarness.fixtures.custodianId),
      ]) {
        const res = await pledge(nearHarness, lot.depositId, {
          lender: await addressFor(nearHarness.adapters.keys, subject, 'near'),
        });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          error: { details: [expect.objectContaining({ code: 'invalid_lender' })] },
        });
      }
      expect(nearFake.receipts.size).toBe(0);

      const lender = 'lender-bank.testnet';
      const pledged = await pledge(nearHarness, lot.depositId, { lender });
      expect(pledged.status).toBe(201);
      const body = pledged.body as {
        pledge: {
          pledge_id: string;
          status: string;
          lender_tx_request: NearOfferTxRequest;
        };
      };
      expect(body.pledge.status).toBe('awaiting_lender_offer');

      // Wrong signer offer_lock: refused before lock_accept is signed.
      const impostorTx = nearFake.recordLenderOffer({
        signerId: 'impostor.testnet',
        txRequest: body.pledge.lender_tx_request,
      });
      const rejected = await request(nearHarness.app)
        .post(`/pledges/${body.pledge.pledge_id}/lender-offer`)
        .send({ txHash: impostorTx });
      expect(rejected.status).toBe(400);
      expect(nearFake.signedFor.filter((s) => s.method === 'lock_accept')).toEqual([]);

      // Valid lender offer_lock: accepted and lock_accept signed only by the farmer.
      const validOfferTx = nearFake.recordLenderOffer({
        signerId: lender,
        txRequest: body.pledge.lender_tx_request,
      });
      const locked = await request(nearHarness.app)
        .post(`/pledges/${body.pledge.pledge_id}/lender-offer`)
        .send({ txHash: validOfferTx });
      expect(locked.status).toBe(200);
      expect(locked.body).toMatchObject({ pledge: { status: 'locked' } });
      expect(nearFake.signedFor.filter((s) => s.method === 'lock')).toEqual([
        { method: 'lock', subject: subjectOf.farmer(nearHarness.fixtures.farmerId) },
      ]);
    } finally {
      await nearHarness.close();
    }
  });
});
