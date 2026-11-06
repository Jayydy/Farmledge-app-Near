import {
  Account,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addressFor, OPERATOR_SUBJECT } from '../../src/chain/addresses.js';
import { DeadlineError } from '../../src/chain/chainClient.js';
import { SorobanChainClient, type RpcServer } from '../../src/chain/sorobanChainClient.js';
import { LocalDevKeyService } from '../../src/keys/localDevKeyService.js';
import { createLogger } from '../../src/logger.js';
import { createMigratedDatabase, type TestDatabase } from '../helpers/testDatabase.js';

/**
 * INV-1 at the chain client: how a recorded transaction is settled. Getting
 * this wrong unfreezes a lot whose mint landed, so grain could leave the
 * warehouse while an on-chain receipt says it is there.
 */
const CONTRACT = 'CBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN';
const PASSPHRASE = Networks.TESTNET;
const NOW = 1_791_400_000; // Unix seconds

interface Script {
  getTransaction?: () => Promise<rpc.Api.GetTransactionResponse>;
  getLatestLedger?: () => Promise<rpc.Api.GetLatestLedgerResponse>;
  sendTransaction?: () => Promise<rpc.Api.SendTransactionResponse>;
}

describe('chain client: settling a recorded transaction (INV-1)', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let keys: LocalDevKeyService;
  let script: Script;
  let calls: string[];
  let now: number;

  const server: RpcServer = {
    getTransaction: () => (calls.push('getTransaction'), script.getTransaction?.() ?? fail()),
    getLatestLedger: () => (calls.push('getLatestLedger'), script.getLatestLedger?.() ?? fail()),
    sendTransaction: () => (calls.push('sendTransaction'), script.sendTransaction?.() ?? fail()),
    simulateTransaction: () => (calls.push('simulateTransaction'), fail()),
    getAccount: () => (calls.push('getAccount'), fail()),
    getLedgerEntries: () => fail(),
    getEvents: () => fail(),
  };
  const client = () =>
    new SorobanChainClient(
      {
        rpcUrl: 'https://rpc.invalid',
        networkPassphrase: PASSPHRASE,
        contractId: CONTRACT,
        operatorSubject: OPERATOR_SUBJECT,
      },
      keys,
      createLogger('silent'),
      () => new Date(now * 1000),
      server,
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
    script = {};
    calls = [];
    now = NOW;
  });
  afterEach(async () => {
    await pool.query('DELETE FROM chain_transactions');
  });

  /** A recorded, submitted mint: signed at `signedAt`, max_time 5 minutes later. */
  async function recordedMint(signedAt = NOW): Promise<string> {
    const source = Keypair.random();
    const tx = new TransactionBuilder(new Account(source.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimebounds(0, signedAt + 300)
      .build();
    tx.sign(source);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO chain_transactions (contract_id, purpose, subject, tx_hash, envelope_xdr, max_time,
                                       status, submitted_at, created_at)
       VALUES ($1, 'mint', 'mint:test', $2, $3, to_timestamp($4), 'submitted', to_timestamp($5),
               to_timestamp($5)) RETURNING id`,
      [
        CONTRACT,
        Buffer.from(tx.hash()).toString('hex'),
        tx.toEnvelope().toXdr('base64'),
        signedAt + 300,
        signedAt,
      ],
    );
    return rows[0]?.id ?? '';
  }
  const status = async (id: string) =>
    (
      await pool.query<{ status: string }>('SELECT status FROM chain_transactions WHERE id = $1', [
        id,
      ])
    ).rows[0]?.status;
  const notFound = (oldestLedgerCloseTime: number) => () =>
    Promise.resolve({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      latestLedger: 2_000,
      latestLedgerCloseTime: now,
      oldestLedger: 1_000,
      oldestLedgerCloseTime,
    } as unknown as rpc.Api.GetTransactionResponse);
  const ledgerAt =
    (closeTime: number, sequence = 2_000) =>
    () =>
      Promise.resolve({
        sequence,
        closeTime: String(closeTime),
      } as unknown as rpc.Api.GetLatestLedgerResponse);

  describe('A: "not found" proves nothing once RPC no longer holds the ledgers it could be in', () => {
    it('reports the outcome undetermined, and does not expire it, when RPC retention starts after the signing', async () => {
      const id = await recordedMint(NOW);
      now = NOW + 3 * 86_400; // a long outage
      script.getTransaction = notFound(NOW + 86_400); // RPC's window starts a day after signing
      script.getLatestLedger = ledgerAt(now, 90_000);

      const outcome = await client().resolve(pool, id);

      expect(outcome.undetermined).toEqual({
        reason: 'outside_rpc_retention',
        closedAfterMaxTimeLedger: 90_000,
      });
      expect(outcome.status).toBe('submitted');
      expect(await status(id)).toBe('submitted');
      expect(calls).not.toContain('sendTransaction');
    });

    it('expires it when RPC still holds every ledger it could have landed in', async () => {
      const id = await recordedMint(NOW);
      now = NOW + 600;
      script.getTransaction = notFound(NOW - 3_600);
      script.getLatestLedger = ledgerAt(now);

      const outcome = await client().resolve(pool, id);

      expect(outcome.undetermined).toBeUndefined();
      expect(outcome.status).toBe('expired');
    });
  });

  describe('B: a rejected resend is never settled as a failure', () => {
    it('keeps the transaction unsettled when a resend is rejected and RPC cannot see it yet', async () => {
      const id = await recordedMint(NOW);
      now = NOW + 60; // before max_time: resolve() resends the same envelope
      script.getTransaction = notFound(NOW - 3_600);
      script.getLatestLedger = ledgerAt(now);
      // The first copy already landed, so this copy's sequence number is stale.
      script.sendTransaction = () =>
        Promise.resolve({
          status: 'ERROR',
          hash: '',
          latestLedger: 2_000,
          latestLedgerCloseTime: now,
          errorResult: { result: () => ({ switch: () => ({ name: 'txBadSeq' }) }) },
        } as unknown as rpc.Api.SendTransactionResponse);

      const outcome = await client().resolve(pool, id);

      expect(calls).toContain('sendTransaction');
      expect(outcome.status).not.toBe('failed');
      expect(await status(id)).toBe('submitted');
      expect(outcome.contractError).toBeNull();
    });
  });

  describe('C: no mint transaction is built after its deadline, nor carries a later max_time', () => {
    const mintCall = (notAfter: number) => ({
      custodianSubject: 'custodian:test',
      verifierSubject: 'verifier:test',
      leaf: {} as never,
      proof: [],
      subject: 'mint:deadline',
      maxTimeSeconds: 300,
      notAfter,
    });

    it('refuses before anything is simulated, signed or recorded once the deadline has passed', async () => {
      await expect(client().mintFromAnchor(pool, mintCall(NOW))).rejects.toBeInstanceOf(
        DeadlineError,
      );
      expect(calls).toEqual([]);
      expect((await pool.query('SELECT 1 FROM chain_transactions')).rowCount).toBe(0);
    });

    it('caps max_time at the deadline even when the default timeout reaches further', async () => {
      const operator = await addressFor(keys, OPERATOR_SUBJECT);
      const simulation = {
        _parsed: true,
        id: '1',
        latestLedger: 2_000,
        events: [],
        minResourceFee: '100',
        transactionData: new SorobanDataBuilder(),
        result: { auth: [], retval: nativeToScVal(1, { type: 'u32' }) },
      } as unknown as rpc.Api.SimulateTransactionResponse;
      const capped: RpcServer = {
        ...server,
        getAccount: () => Promise.resolve(new Account(operator, '1')),
        simulateTransaction: () => Promise.resolve(simulation),
        getLatestLedger: ledgerAt(NOW),
        sendTransaction: () =>
          Promise.resolve({
            status: 'PENDING',
            hash: '',
          } as unknown as rpc.Api.SendTransactionResponse),
        getTransaction: () =>
          Promise.resolve({
            status: rpc.Api.GetTransactionStatus.SUCCESS,
            ledger: 2_001,
            returnValue: nativeToScVal(7, { type: 'u64' }),
          } as unknown as rpc.Api.GetTransactionResponse),
      };
      const c = new SorobanChainClient(
        {
          rpcUrl: 'https://rpc.invalid',
          networkPassphrase: PASSPHRASE,
          contractId: CONTRACT,
          operatorSubject: OPERATOR_SUBJECT,
        },
        keys,
        createLogger('silent'),
        () => new Date(NOW * 1000),
        capped,
      );
      // 60 s left before the deadline; the default 300 s timeout would go past it.
      await c.mintFromAnchor(pool, {
        ...mintCall(NOW + 60),
        custodianSubject: OPERATOR_SUBJECT,
        verifierSubject: OPERATOR_SUBJECT,
        leaf: LEAF,
      });
      const { rows } = await pool.query<{ max_time: Date; signed_after_ledger: string }>(
        'SELECT max_time, signed_after_ledger FROM chain_transactions',
      );
      expect(rows.map((r) => r.max_time.getTime() / 1000)).toEqual([NOW + 60]);
      // The ledger read just before signing bounds where it can land (INV-1 archive fallback).
      expect(rows.map((r) => Number(r.signed_after_ledger))).toEqual([2_000]);
    });
  });
});

const LEAF = {
  version: 1,
  kind: 2,
  warehouse_id: 'KN_DAWANAU',
  day: 20_733,
  index: 0,
  deposit_no: 1,
  deposit_id: '1fcffeee-3b9a-4c21-9d55-0a7c2e8b6f10',
  receipt_id: 0,
  receipt_version: 0,
  owner: Keypair.random().publicKey(),
  commodity: 'MAIZE_WHITE',
  grade: '1',
  kg: 2000,
  weight_source: 'Scale',
  bags: 20,
  moisture_bps: 1250,
  custodian: Keypair.random().publicKey(),
  verifier: Keypair.random().publicKey(),
  deposited_at: NOW - 86_400,
  at: NOW - 3_600,
  salt: '00'.repeat(32),
} as const;

function fail(): never {
  throw new Error('unexpected RPC call');
}
