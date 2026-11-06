import { createHash } from 'node:crypto';

import { baseEncode, SignedTransaction } from 'near-api-js';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addressFor, OPERATOR_SUBJECT, subjectOf } from '../../../src/chain/addresses.js';
import { ContractError, DeadlineError, LenderAuthError } from '../../../src/chain/chainClient.js';
import { loanRefToHex, NearChainClient } from '../../../src/chain/nearChainClient.js';
import type { NearAccountView, NearRpc, NearTxStatusResponse } from '../../../src/chain/nearRpc.js';
import type { LeafJson } from '../../../src/domain/merkle.js';
import { LocalDevKeyService } from '../../../src/keys/localDevKeyService.js';
import { createLogger } from '../../../src/logger.js';
import { createMigratedDatabase, type TestDatabase } from '../../helpers/testDatabase.js';

const CONTRACT = 'farmledge-receipt.team.testnet';
const BLOCK_HASH = baseEncode(Buffer.alloc(32, 7));
const NOW = 1_791_400_000;
const LENDER = 'lender.testnet';
const LENDER_OFFER_TX_HASH = baseEncode(createHash('sha256').update('lender-offer-1').digest());

function buildLeaf(owner: string, custodian: string, verifier: string): LeafJson {
  return {
    version: 1,
    kind: 2,
    warehouse_id: 'KN_DAWANAU',
    day: 20_733,
    index: 0,
    deposit_no: 1,
    deposit_id: '1fcffeee-3b9a-4c21-9d55-0a7c2e8b6f10',
    receipt_id: 0,
    receipt_version: 0,
    owner,
    commodity: 'MAIZE_WHITE',
    grade: '1',
    kg: 1995,
    weight_source: 'Scale',
    bags: 20,
    moisture_bps: 1250,
    custodian,
    verifier,
    deposited_at: NOW - 86_400,
    at: NOW - 3_600,
    salt: '11'.repeat(32),
  };
}

describe('NearChainClient (test/chain/near/client.test.ts)', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keys: LocalDevKeyService;
  let now: number;
  let nonces: Map<string, bigint>;
  let accounts: Map<string, NearAccountView>;
  let sentEnvelopes: string[];
  let txStatuses: Map<string, NearTxStatusResponse | null>;
  let earliestBlockTime: string | null;
  let viewHandler: (method: string, args: Record<string, unknown>) => unknown;
  let onSendTx: ((envelopeB64: string, decoded: SignedTransaction) => Promise<void>) | null;

  const rpc: NearRpc = {
    status: () =>
      Promise.resolve({
        sync_info: {
          latest_block_hash: BLOCK_HASH,
          latest_block_height: 185_000_000,
          latest_block_time: new Date(now * 1000).toISOString(),
          earliest_block_height: 180_000_000,
          earliest_block_time: earliestBlockTime,
        },
      }),
    block: () =>
      Promise.resolve({
        header: {
          height: 185_000_001,
          hash: BLOCK_HASH,
          timestamp: now * 1_000_000_000,
          timestamp_nanosec: String(BigInt(now) * 1_000_000_000n),
        },
      }),
    viewAccount: (accountId) => Promise.resolve(accounts.get(accountId) ?? null),
    viewAccessKey: (accountId) => {
      const current = nonces.get(accountId) ?? 0n;
      nonces.set(accountId, current + 1n);
      return Promise.resolve({
        nonce: current,
        permission: 'FullAccess',
        block_height: 185_000_000,
        block_hash: BLOCK_HASH,
      });
    },
    callFunction: <T = unknown>(_contractId: string, method: string, args: Record<string, unknown>) =>
      Promise.resolve(viewHandler(method, args) as T),
    sendTxAsync: async (envelopeB64) => {
      sentEnvelopes.push(envelopeB64);
      const decoded = SignedTransaction.decode(Buffer.from(envelopeB64, 'base64'));
      const txHash = baseEncode(
        createHash('sha256').update(decoded.transaction.encode()).digest(),
      );
      if (onSendTx !== null) {
        await onSendTx(envelopeB64, decoded);
      } else if (!txStatuses.has(txHash)) {
        txStatuses.set(txHash, {
          status: { SuccessValue: Buffer.from(JSON.stringify('1')).toString('base64') },
          transaction: {
            hash: txHash,
            signer_id: decoded.transaction.signerId,
            public_key: decoded.transaction.publicKey.toString(),
            nonce: Number(decoded.transaction.nonce),
            receiver_id: decoded.transaction.receiverId,
            actions: [],
          },
          transaction_outcome: {
            id: txHash,
            block_hash: BLOCK_HASH,
            outcome: {
              executor_id: decoded.transaction.signerId,
              logs: [],
              receipt_ids: [],
              status: { SuccessValue: '' },
            },
          },
          receipts_outcome: [],
        });
      }
      return txHash;
    },
    txStatus: (txHash) => Promise.resolve(txStatuses.get(txHash) ?? null),
  };

  const makeClient = (fundYocto = 0n) =>
    new NearChainClient(
      {
        rpcUrl: 'https://rpc.testnet.near.org',
        networkId: 'testnet',
        contractId: CONTRACT,
        operatorSubject: OPERATOR_SUBJECT,
        operatorFundYocto: fundYocto,
        pollIntervalMs: 5,
        pollTimeoutMs: 50,
      },
      keys,
      createLogger('silent'),
      () => new Date(now * 1000),
      rpc,
    );

  beforeAll(async () => {
    db = await createMigratedDatabase('test');
    pool = new pg.Pool({ connectionString: db.url });
    keys = new LocalDevKeyService('a-test-secret-that-is-long-enough-123456', 'test', pool);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  beforeEach(() => {
    now = NOW;
    nonces = new Map();
    accounts = new Map([
      [
        CONTRACT,
        {
          amount: '10000000000000000000000000',
          locked: '0',
          code_hash: 'ContractCodeHash111111111111111111111111111',
          storage_usage: 1000,
          block_height: 185_000_000,
          block_hash: BLOCK_HASH,
        },
      ],
    ]);
    sentEnvelopes = [];
    txStatuses = new Map();
    earliestBlockTime = new Date((NOW - 86_400) * 1000).toISOString();
    onSendTx = null;
    viewHandler = (method) => {
      if (method === 'last_receipt_id') return '7';
      if (method === 'is_claimed') return true;
      if (method === 'get_anchor') return { day: 20_733, head: 'aa'.repeat(32) };
      if (method === 'get_receipt') {
        return {
          receipt_id: '1',
          parent_id: null,
          status: 'Active',
          weight_kg: '1995',
          bag_count: 20,
          owner: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          warehouse_id: 'KN_DAWANAU',
          deposit_no: '1',
          deposit_id: '1fcffeee-3b9a-4c21-9d55-0a7c2e8b6f10',
          weight_source: 'Scale',
          lender: null,
        };
      }
      return null;
    };
  });

  afterEach(async () => {
    await pool.query('DELETE FROM chain_transactions');
  });

  describe('reads & capabilities', () => {
    it('exposes backend=near, capabilities.ttl=false, and reads contract state via JSON-RPC views', async () => {
      const c = makeClient();
      expect(c.backend).toBe('near');
      expect(c.capabilities.ttl).toBe(false);
      expect(c.validateAccount('lender.testnet')).toBe(true);
      expect(c.validateAccount('GBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN')).toBe(
        false,
      );

      expect(await c.instanceExists()).toBe(true);
      expect(await c.lastReceiptId()).toBe(7n);
      expect(await c.isClaimed('KN_DAWANAU', 1)).toBe(true);
      const anchor = await c.getAnchor('KN_DAWANAU');
      expect(anchor?.day).toBe(20_733);
      expect(anchor?.head.toString('hex')).toBe('aa'.repeat(32));

      const receipt = await c.getReceipt(1n);
      expect(receipt?.receiptId).toBe(1n);
      expect(receipt?.weightKg).toBe(1995n);
      expect(receipt?.status).toBe('Active');

      const ttl = await c.receiptLiveUntil([1n, 2n]);
      expect(ttl.get('1')).toBeNull();
      expect(ttl.get('2')).toBeNull();
    });
  });

  describe('D30: record before submit & auto-funding', () => {
    it('auto-funds an unseen implicit account from platform:operator and records the anchor tx BEFORE sendTxAsync', async () => {
      const custodianSubject = subjectOf.custodian('c-1');
      const custodianId = await addressFor(keys, custodianSubject, 'near');
      const operatorId = await addressFor(keys, OPERATOR_SUBJECT, 'near');

      let dbRowsDuringSend = 0;
      onSendTx = async (_b64, decoded) => {
        if (decoded.transaction.receiverId === CONTRACT) {
          const { rowCount } = await pool.query(
            `SELECT 1 FROM chain_transactions WHERE chain = 'near' AND envelope_encoding = 'borsh_b64'`,
          );
          dbRowsDuringSend = rowCount ?? 0;
        }
        const txHash = baseEncode(
          createHash('sha256').update(decoded.transaction.encode()).digest(),
        );
        txStatuses.set(txHash, {
          status: { SuccessValue: '' },
          transaction: {
            hash: txHash,
            signer_id: decoded.transaction.signerId,
            public_key: decoded.transaction.publicKey.toString(),
            nonce: Number(decoded.transaction.nonce),
            receiver_id: decoded.transaction.receiverId,
            actions: [],
          },
          transaction_outcome: {
            id: txHash,
            block_hash: BLOCK_HASH,
            outcome: {
              executor_id: decoded.transaction.signerId,
              logs: [],
              receipt_ids: [],
              status: { SuccessValue: '' },
            },
          },
          receipts_outcome: [],
        });
      };

      const c = makeClient(100_000_000_000_000_000_000_000n);
      const outcome = await c.anchor(pool, {
        custodianSubject,
        warehouseSymbol: 'KN_DAWANAU',
        day: 20_733,
        root: Buffer.alloc(32, 9),
        leaves: 3,
        subject: 'anchor:KN_DAWANAU:20733',
      });

      expect(outcome.status).toBe('success');
      expect(dbRowsDuringSend).toBe(1);
      // 1st envelope: operator funding transfer to custodianId; 2nd envelope: custodian calling anchor
      expect(sentEnvelopes).toHaveLength(2);
      const firstTx = SignedTransaction.decode(Buffer.from(sentEnvelopes[0] ?? '', 'base64'));
      expect(firstTx.transaction.signerId).toBe(operatorId);
      expect(firstTx.transaction.receiverId).toBe(custodianId);

      const secondTx = SignedTransaction.decode(Buffer.from(sentEnvelopes[1] ?? '', 'base64'));
      expect(secondTx.transaction.signerId).toBe(custodianId);
      expect(secondTx.transaction.receiverId).toBe(CONTRACT);
    });
  });

  describe('INV-1: two-step mintFromAnchor (mint_propose + mint_approve)', () => {
    it('refuses before anything is signed or recorded once notAfter has passed', async () => {
      const c = makeClient();
      const owner = await addressFor(keys, subjectOf.farmer('f-1'), 'near');
      const custodian = await addressFor(keys, subjectOf.custodian('c-1'), 'near');
      const verifier = await addressFor(keys, subjectOf.verifier('v-1'), 'near');

      await expect(
        c.mintFromAnchor(pool, {
          custodianSubject: subjectOf.custodian('c-1'),
          verifierSubject: subjectOf.verifier('v-1'),
          leaf: buildLeaf(owner, custodian, verifier),
          proof: [],
          subject: 'mint:expired',
          maxTimeSeconds: 300,
          notAfter: NOW,
        }),
      ).rejects.toBeInstanceOf(DeadlineError);

      expect(sentEnvelopes).toHaveLength(0);
      expect((await pool.query('SELECT 1 FROM chain_transactions')).rowCount).toBe(0);
    });

    it('executes mint_propose (custodian) then mint_approve (verifier) and caps max_time at notAfter', async () => {
      const c = makeClient();
      const custodianSubject = subjectOf.custodian('c-1');
      const verifierSubject = subjectOf.verifier('v-1');
      const owner = await addressFor(keys, subjectOf.farmer('f-1'), 'near');
      const custodian = await addressFor(keys, custodianSubject, 'near');
      const verifier = await addressFor(keys, verifierSubject, 'near');

      const outcome = await c.mintFromAnchor(pool, {
        custodianSubject,
        verifierSubject,
        leaf: buildLeaf(owner, custodian, verifier),
        proof: [Buffer.alloc(32, 3)],
        subject: 'mint:1',
        maxTimeSeconds: 300,
        notAfter: NOW + 60,
      });

      expect(outcome.status).toBe('success');
      expect(outcome.returnValue).toBe('1');

      const { rows } = await pool.query<{
        purpose: string;
        subject: string;
        max_time: Date;
        chain: string;
        envelope_encoding: string;
      }>(
        `SELECT purpose, subject, max_time, chain, envelope_encoding
           FROM chain_transactions ORDER BY created_at`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.purpose)).toEqual(['mint_propose', 'mint_approve']);
      expect(rows.map((r) => r.subject)).toEqual(['mint:1:propose', 'mint:1']);
      expect(rows.every((r) => r.chain === 'near' && r.envelope_encoding === 'borsh_b64')).toBe(
        true,
      );
      expect(rows.map((r) => r.max_time.getTime() / 1000)).toEqual([NOW + 60, NOW + 60]);
    });

    it('stops after mint_propose and surfaces ContractError when Step 1 fails on-chain', async () => {
      onSendTx = (_b64, decoded) => {
        const txHash = baseEncode(
          createHash('sha256').update(decoded.transaction.encode()).digest(),
        );
        txStatuses.set(txHash, {
          status: {
            Failure: {
              ActionError: {
                kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E51:StaleLeaf' } },
              },
            },
          },
          transaction: {
            hash: txHash,
            signer_id: decoded.transaction.signerId,
            public_key: decoded.transaction.publicKey.toString(),
            nonce: 1,
            receiver_id: CONTRACT,
            actions: [],
          },
          transaction_outcome: {
            id: txHash,
            outcome: { executor_id: CONTRACT, logs: [], receipt_ids: [], status: {} },
          },
          receipts_outcome: [],
        });
        return Promise.resolve();
      };

      const c = makeClient();
      const custodianSubject = subjectOf.custodian('c-1');
      const verifierSubject = subjectOf.verifier('v-1');
      const owner = await addressFor(keys, subjectOf.farmer('f-1'), 'near');
      const custodian = await addressFor(keys, custodianSubject, 'near');
      const verifier = await addressFor(keys, verifierSubject, 'near');

      const outcome = await c.mintFromAnchor(pool, {
        custodianSubject,
        verifierSubject,
        leaf: buildLeaf(owner, custodian, verifier),
        proof: [],
        subject: 'mint:stale',
        maxTimeSeconds: 300,
        notAfter: NOW + 120,
      });

      expect(outcome.status).toBe('failed');
      expect(outcome.contractError).toBe(ContractError.StaleLeaf);
      expect(sentEnvelopes).toHaveLength(1);
    });
  });

  describe('D31: prepareLock & submitLock', () => {
    const lockCall = {
      receiptId: 1n,
      lender: LENDER,
      kg: 1995n,
      loanRef: 'LOAN-0001',
      dueDate: NOW + 90 * 86_400,
      gracePeriodSeconds: 86_400,
    };

    function seedValidLenderOfferTx(overrides: Partial<Record<string, unknown>> = {}): void {
      const args = {
        receipt_id: '1',
        amount_kg: '1995',
        loan_ref: loanRefToHex('LOAN-0001'),
        due_date: lockCall.dueDate,
        grace_period_seconds: lockCall.gracePeriodSeconds,
        expires_at: NOW + 86_400,
        ...overrides,
      };
      txStatuses.set(LENDER_OFFER_TX_HASH, {
        status: { SuccessValue: '' },
        transaction: {
          hash: LENDER_OFFER_TX_HASH,
          signer_id: (overrides.__signer_id as string | undefined) ?? LENDER,
          public_key: 'ed25519:11111111111111111111111111111111',
          nonce: 1,
          receiver_id: (overrides.__receiver_id as string | undefined) ?? CONTRACT,
          actions: [
            {
              FunctionCall: {
                method_name: (overrides.__method as string | undefined) ?? 'lock_offer',
                args: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
                gas: 30_000_000_000_000,
                deposit: '1',
              },
            },
          ],
        },
        transaction_outcome: {
          id: LENDER_OFFER_TX_HASH,
          outcome: { executor_id: LENDER, logs: [], receipt_ids: [], status: { SuccessValue: '' } },
        },
        receipts_outcome: [],
      });
    }

    it('returns a near_offer txRequest from prepareLock and verifies the lender offer before signing lock_accept as owner', async () => {
      const c = makeClient();
      const prepared = await c.prepareLock(lockCall);
      expect(prepared.kind).toBe('near_offer');
      if (prepared.kind === 'near_offer') {
        expect(prepared.txRequest).toEqual({
          receiverId: CONTRACT,
          methodName: 'lock_offer',
          args: {
            receipt_id: '1',
            amount_kg: '1995',
            loan_ref: loanRefToHex('LOAN-0001'),
            due_date: lockCall.dueDate,
            grace_period_seconds: lockCall.gracePeriodSeconds,
            expires_at: NOW + 86_400,
          },
          gas: '30000000000000',
          deposit: '1',
        });
      }

      seedValidLenderOfferTx();
      const farmerSubject = subjectOf.farmer('f-1');
      const farmerId = await addressFor(keys, farmerSubject, 'near');
      const outcome = await c.submitLock(
        pool,
        lockCall,
        LENDER_OFFER_TX_HASH,
        farmerSubject,
        'lock:pledge-1',
      );
      expect(outcome.status).toBe('success');
      expect(outcome.returnValue).toBe('1');
      expect(sentEnvelopes).toHaveLength(1);
      const acceptTx = SignedTransaction.decode(Buffer.from(sentEnvelopes[0] ?? '', 'base64'));
      expect(acceptTx.transaction.signerId).toBe(farmerId);
    });

    it.each([
      ['invalid Base58 hash', 'not-a-valid-base58-tx-hash', {}],
      ['wrong signer account', LENDER_OFFER_TX_HASH, { __signer_id: 'impostor.testnet' }],
      ['wrong target contract', LENDER_OFFER_TX_HASH, { __receiver_id: 'other.testnet' }],
      ['wrong method name', LENDER_OFFER_TX_HASH, { __method: 'transfer' }],
      ['mismatched receipt_id', LENDER_OFFER_TX_HASH, { receipt_id: '999' }],
      ['mismatched amount_kg', LENDER_OFFER_TX_HASH, { amount_kg: '1000' }],
      ['mismatched loan_ref', LENDER_OFFER_TX_HASH, { loan_ref: 'ff'.repeat(32) }],
      ['mismatched due_date', LENDER_OFFER_TX_HASH, { due_date: NOW + 100 }],
      ['mismatched grace_period_seconds', LENDER_OFFER_TX_HASH, { grace_period_seconds: 10 }],
    ])('refuses submitLock with LenderAuthError on %s', async (_label, txHash, overrides) => {
      seedValidLenderOfferTx(overrides);
      const c = makeClient();
      await expect(
        c.submitLock(pool, lockCall, txHash, subjectOf.farmer('f-1'), 'lock:bad'),
      ).rejects.toBeInstanceOf(LenderAuthError);
      expect(sentEnvelopes).toHaveLength(0);
    });
  });

  describe('resolve() (D30 & INV-1)', () => {
    it('re-broadcasts the identical signed envelope before max_time without incrementing nonce, and expires after max_time', async () => {
      onSendTx = () => Promise.resolve();
      const c = makeClient();
      const custodianSubject = subjectOf.custodian('c-1');
      const custodianId = await addressFor(keys, custodianSubject, 'near');

      const initial = await c.anchor(pool, {
        custodianSubject,
        warehouseSymbol: 'KN_DAWANAU',
        day: 20_733,
        root: Buffer.alloc(32, 5),
        leaves: 1,
        subject: 'anchor:pending',
      });
      expect(initial.status).toBe('submitted');
      expect(sentEnvelopes).toHaveLength(1);
      expect(nonces.get(custodianId)).toBe(1n);

      // Before max_time: resolve() re-broadcasts the exact same envelope without fetching a new nonce.
      now = NOW + 60;
      const stillPending = await c.resolve(pool, initial.id);
      expect(stillPending.status).toBe('submitted');
      expect(sentEnvelopes).toHaveLength(2);
      expect(sentEnvelopes[1]).toBe(sentEnvelopes[0]);
      expect(nonces.get(custodianId)).toBe(1n);

      // After max_time with retention intact: resolve() settles as expired.
      now = NOW + 600;
      const expired = await c.resolve(pool, initial.id);
      expect(expired.status).toBe('expired');
      expect(expired.undetermined).toBeUndefined();
    });

    it('reports undetermined (outside_rpc_retention) and does not expire when RPC retention starts after signing', async () => {
      onSendTx = () => Promise.resolve();
      const c = makeClient();
      const initial = await c.anchor(pool, {
        custodianSubject: subjectOf.custodian('c-1'),
        warehouseSymbol: 'KN_DAWANAU',
        day: 20_733,
        root: Buffer.alloc(32, 5),
        leaves: 1,
        subject: 'anchor:retention',
      });

      now = NOW + 3 * 86_400;
      earliestBlockTime = new Date((NOW + 86_400) * 1000).toISOString();
      const outcome = await c.resolve(pool, initial.id);
      expect(outcome.status).toBe('submitted');
      expect(outcome.undetermined).toEqual({
        reason: 'outside_rpc_retention',
        closedAfterMaxTimeLedger: 185_000_000,
      });
    });
  });
});
