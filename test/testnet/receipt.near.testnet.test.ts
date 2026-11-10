import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OPERATOR_SUBJECT, subjectOf } from '../../src/chain/addresses.js';
import type { NearOfferTxRequest } from '../../src/chain/chainClient.js';
import { NearChainClient } from '../../src/chain/nearChainClient.js';
import { utcDay } from '../../src/domain/book.js';
import type { LeafJson } from '../../src/domain/merkle.js';
import { createLogger } from '../../src/logger.js';
import {
  archiveWarehouseAdded,
  startChainHarness,
  type ChainHarness,
} from '../helpers/chainHarness.js';

/**
 * End-to-end NEAR Testnet suite against a deployed `farmledge_receipt` contract.
 * Opt-in: NEAR_TESTNET_E2E=1 NEAR_CONTRACT_ID=... NEAR_LENDER_ACCOUNT_ID=... npm test -- test/testnet/receipt.near.testnet.test.ts
 */
const DAY_MS = 86_400_000;
const RUN_NEAR_TESTNET =
  process.env.NEAR_TESTNET_E2E === '1' || process.env.NEAR_TESTNET === '1';

describe.skipIf(!RUN_NEAR_TESTNET)('receipt contract on NEAR Testnet', () => {
  let h: ChainHarness;
  let chain: NearChainClient;
  const contractId = process.env.NEAR_CONTRACT_ID ?? 'receipt.farmledge.testnet';
  const rpcUrl = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org';
  const startBlock = Number(process.env.NEAR_CONTRACT_START_BLOCK ?? '1');
  const lenderAccount = process.env.NEAR_LENDER_ACCOUNT_ID ?? 'lender.farmledge.testnet';
  const today = utcDay(new Date());
  let lotA: { depositId: string; depositNo: number };

  beforeAll(async () => {
    h = await startChainHarness({
      start: new Date(Date.now() - 2 * DAY_MS),
      backend: 'near',
      env: {
        CHAIN_BACKEND: 'near',
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: rpcUrl,
        NEAR_CONTRACT_ID: contractId,
        NEAR_CONTRACT_START_BLOCK: String(startBlock),
      },
      chain: ({ adapters }) => {
        chain = new NearChainClient(
          {
            rpcUrl,
            networkId: 'testnet',
            contractId,
            operatorSubject: OPERATOR_SUBJECT,
          },
          adapters.keys,
          createLogger('silent'),
        );
        return chain;
      },
    });
    await archiveWarehouseAdded(h.pool, contractId, h.fixtures.warehouseId, h.clock.now());
  }, 600_000);

  afterAll(async () => {
    await h.close();
  });

  it('verifies contract instance exists on NEAR Testnet and matches borsh leaf_hash', async () => {
    expect(await chain.instanceExists()).toBe(true);
    lotA = await h.scaleLot(20);
    h.clock.set(new Date(Date.now() - DAY_MS));
    await h.anchoring.runWarehouse(h.fixtures.warehouseId);
    h.clock.set(new Date());
    const reports = await h.anchoring.runWarehouse(h.fixtures.warehouseId);
    expect(reports.at(-1)).toMatchObject({ day: today - 1, anchored: true });

    const entry = await h.pool.query<{
      content: object;
      salt: Buffer;
      day: number;
      idx: number;
      leaf_hash: Buffer;
    }>(
      `SELECT content, salt, day, idx, leaf_hash FROM book_entries WHERE kind = 2 AND day = $1 LIMIT 1`,
      [today - 1],
    );
    const e = entry.rows[0];
    const leaf = {
      ...e?.content,
      day: e?.day,
      index: e?.idx,
      salt: e?.salt.toString('hex'),
    } as LeafJson;
    expect((await chain.leafHash(leaf)).equals(e?.leaf_hash ?? Buffer.alloc(0))).toBe(true);
  }, 600_000);

  it('mints via 2-step propose_mint + approve_mint and prepares near_offer lock', async () => {
    const res = await request(h.app)
      .post('/pledges')
      .send({
        deposit_id: lotA.depositId,
        lender: lenderAccount,
        kg: 1995,
        loan_ref: `LOAN-${lotA.depositId.slice(0, 8)}`,
        due_date: new Date(Date.now() + 90 * DAY_MS).toISOString(),
        grace_period_seconds: 86_400,
        requested_by: h.fixtures.custodianId,
        verifier_id: h.fixtures.verifierId,
        farmer_confirmed: true,
      });
    expect(res.status).toBe(201);
    const body = res.body as {
      pledge: {
        pledge_id: string;
        status: string;
        receipt_id: string | null;
        lender_tx_request: NearOfferTxRequest | null;
      };
    };
    expect(body.pledge.status).toBe('awaiting_lender_offer');
    expect(body.pledge.lender_tx_request?.methodName).toBe('lock_offer');
    expect(body.pledge.receipt_id).not.toBeNull();

    const receipt = await chain.getReceipt(BigInt(body.pledge.receipt_id ?? '0'));
    expect(receipt).toMatchObject({
      status: 'Active',
      owner: await chain.addressOf(subjectOf.farmer(h.fixtures.farmerId)),
      weightKg: 1995n,
    });
  }, 600_000);
});
