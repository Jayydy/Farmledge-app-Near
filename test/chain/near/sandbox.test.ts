import { createHash } from 'node:crypto';

import { baseEncode, SignedTransaction } from 'near-api-js';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { addressFor, OPERATOR_SUBJECT, subjectOf } from '../../../src/chain/addresses.js';
import type { NearOfferTxRequest, ReceiptStatus } from '../../../src/chain/chainClient.js';
import {
  FARMLEDGE_EVENT_VERSION,
  FARMLEDGE_STANDARD,
  NEP297_PREFIX,
  type NearIndexerTxRef,
} from '../../../src/chain/nearEvents.js';
import { nearLeafHash } from '../../../src/chain/nearLeaf.js';
import { NearChainClient } from '../../../src/chain/nearChainClient.js';
import {
  HttpNearRpc,
  type NearAccountView,
  type NearRpc,
  type NearTxStatusResponse,
} from '../../../src/chain/nearRpc.js';
import {
  depthFor,
  foldProof,
  nextHead,
  ZERO_HEAD,
  type LeafJson,
  type WeightSourceName,
} from '../../../src/domain/merkle.js';
import { createLogger } from '../../../src/logger.js';
import { middayOf, startChainHarness, type ChainHarness } from '../../helpers/chainHarness.js';
import { DAY } from '../../invariants/helpers.js';

const SANDBOX_CONTRACT = 'receipt.sandbox.near';
const LENDER = 'lender.sandbox.near';
const START_BLOCK = 10_000;

function nep297Log(event: string, data: Record<string, unknown>): string {
  return `${NEP297_PREFIX}${JSON.stringify({
    standard: FARMLEDGE_STANDARD,
    version: FARMLEDGE_EVENT_VERSION,
    event,
    data: [data],
  })}`;
}

interface PendingMintProposal {
  leaf: LeafJson;
  proof: Buffer[];
  leafHashHex: string;
  custodian: string;
  notAfter: number;
}

interface PendingLockOffer {
  receiptId: string;
  lender: string;
  amountKg: string;
  loanRef: string;
  dueDate: number;
  gracePeriodSeconds: number;
  expiresAt: number;
}

interface SandboxAnchorView {
  day: number;
  head: string;
}

interface SandboxReceiptView {
  receipt_id: string;
  parent_id: string | null;
  status: ReceiptStatus;
  weight_kg: string;
  bag_count: number;
  owner: string;
  warehouse_id: string;
  deposit_no: string;
  deposit_id: string;
  weight_source: WeightSourceName;
  lender: string | null;
}

/**
 * Stateful in-process NEAR sandbox RPC + receipt contract state machine.
 * Executes real Borsh-encoded `SignedTransaction`s from `NearChainClient`,
 * enforces contract rules (Merkle proof folding with `nearLeafHash`, head
 * chaining, two-step `mint_propose`/`mint_approve`, two-step
 * `lock_offer`/`lock_accept`), and emits NEP-297 `EVENT_JSON:` logs so
 * `IndexerService.ingest()` and `IndexerService.reconcile()` run end-to-end.
 */
class InProcessNearSandbox {
  blockHeight = START_BLOCK;
  private readonly nonces = new Map<string, bigint>();
  private readonly accounts = new Map<string, NearAccountView>();
  private readonly txStatuses = new Map<string, NearTxStatusResponse>();
  private readonly activity: NearIndexerTxRef[] = [];
  private readonly warehouses = new Set<string>();
  private readonly custodians = new Map<string, Set<string>>();
  private readonly verifiers = new Set<string>();
  private readonly anchors = new Map<string, { day: number; head: Buffer; root: Buffer; leaves: number }>();
  private readonly claimed = new Set<string>();
  private readonly pendingMints = new Map<string, PendingMintProposal>();
  private readonly receipts = new Map<string, SandboxReceiptView>();
  private readonly pendingLocks = new Map<string, PendingLockOffer>();
  private nextReceiptId = 1n;

  constructor(private readonly nowSeconds: () => number) {
    this.accounts.set(SANDBOX_CONTRACT, {
      amount: '100000000000000000000000000',
      locked: '0',
      code_hash: 'SandboxReceiptContractCodeHash11111111111111',
      storage_usage: 4096,
      block_height: this.blockHeight,
      block_hash: this.blockHashFor(this.blockHeight),
    });
  }

  private blockHashFor(height: number): string {
    return baseEncode(createHash('sha256').update(`sandbox-block:${height}`).digest());
  }

  private timestampNs(): string {
    return (BigInt(this.nowSeconds()) * 1_000_000_000n).toString();
  }

  seedRegistration(warehouseSymbol: string, custodianId: string, verifierId: string): void {
    this.warehouses.add(warehouseSymbol);
    const set = this.custodians.get(warehouseSymbol) ?? new Set<string>();
    set.add(custodianId);
    this.custodians.set(warehouseSymbol, set);
    this.verifiers.add(verifierId);

    this.recordSyntheticContractTx('admin.sandbox.near', 'register_roles', {}, [
      nep297Log('warehouse_added', {
        warehouse_id: warehouseSymbol,
        added_at: String(this.nowSeconds()),
      }),
      nep297Log('custodian_added', {
        warehouse_id: warehouseSymbol,
        custodian: custodianId,
        added_at: String(this.nowSeconds()),
      }),
      nep297Log('verifier_added', {
        verifier: verifierId,
        added_at: String(this.nowSeconds()),
      }),
    ]);
  }

  submitLenderOffer(signerId: string, txRequest: NearOfferTxRequest): string {
    const args = txRequest.args;
    const receiptId = args.receipt_id;
    const offer: PendingLockOffer = {
      receiptId,
      lender: signerId,
      amountKg: args.amount_kg,
      loanRef: args.loan_ref,
      dueDate: args.due_date,
      gracePeriodSeconds: args.grace_period_seconds,
      expiresAt: args.expires_at,
    };
    this.pendingLocks.set(receiptId, offer);
    return this.recordSyntheticContractTx(signerId, txRequest.methodName, args, [
      nep297Log('lock_offered', {
        receipt_id: offer.receiptId,
        lender: offer.lender,
        amount_kg: offer.amountKg,
        expires_at: offer.expiresAt,
      }),
    ]);
  }

  private recordSyntheticContractTx(
    signerId: string,
    methodName: string,
    args: Record<string, unknown>,
    logs: string[],
    returnValue: unknown = '',
  ): string {
    this.blockHeight += 1;
    const blockHash = this.blockHashFor(this.blockHeight);
    const txHash = baseEncode(
      createHash('sha256')
        .update(`${this.blockHeight}:${signerId}:${methodName}:${JSON.stringify(args)}`)
        .digest(),
    );
    const tsNs = this.timestampNs();
    const statusValue =
      returnValue === ''
        ? ''
        : Buffer.from(JSON.stringify(returnValue), 'utf8').toString('base64');

    this.txStatuses.set(txHash, {
      status: { SuccessValue: statusValue },
      transaction: {
        hash: txHash,
        signer_id: signerId,
        public_key: 'ed25519:11111111111111111111111111111111',
        nonce: 1,
        receiver_id: SANDBOX_CONTRACT,
        actions: [
          {
            FunctionCall: {
              method_name: methodName,
              args: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
              gas: 30_000_000_000_000,
              deposit: '1',
            },
          },
        ],
      },
      transaction_outcome: {
        id: txHash,
        block_hash: blockHash,
        outcome: {
          executor_id: signerId,
          logs: [],
          receipt_ids: [`receipt:${txHash}`],
          status: { SuccessReceiptId: `receipt:${txHash}` },
        },
      },
      receipts_outcome: [
        {
          id: `receipt:${txHash}`,
          block_hash: blockHash,
          outcome: {
            executor_id: SANDBOX_CONTRACT,
            logs,
            receipt_ids: [],
            status: { SuccessValue: statusValue },
          },
        },
      ],
    });
    this.activity.push({
      txHash,
      signerId,
      blockHeight: this.blockHeight,
      blockTimestampNs: tsNs,
    });
    return txHash;
  }

  readonly fetchFn: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          this.activity.map((a) => ({
            tx_hash: a.txHash,
            signer_id: a.signerId,
            block_height: a.blockHeight,
            block_timestamp: a.blockTimestampNs,
          })),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

  readonly rpc: NearRpc = {
    status: () =>
      Promise.resolve({
        sync_info: {
          latest_block_hash: this.blockHashFor(this.blockHeight),
          latest_block_height: this.blockHeight,
          latest_block_time: new Date(this.nowSeconds() * 1000).toISOString(),
          earliest_block_height: START_BLOCK,
          earliest_block_time: new Date((this.nowSeconds() - 7 * 86_400) * 1000).toISOString(),
        },
      }),
    block: (ref) => {
      const height =
        'blockId' in ref && typeof ref.blockId === 'number' ? ref.blockId : this.blockHeight;
      const ns = this.timestampNs();
      return Promise.resolve({
        header: {
          height,
          hash: this.blockHashFor(height),
          timestamp: Number(BigInt(ns)),
          timestamp_nanosec: ns,
        },
      });
    },
    viewAccount: (accountId) => Promise.resolve(this.accounts.get(accountId) ?? null),
    viewAccessKey: (accountId) => {
      const current = this.nonces.get(accountId) ?? 0n;
      this.nonces.set(accountId, current + 1n);
      return Promise.resolve({
        nonce: current,
        permission: 'FullAccess',
        block_height: this.blockHeight,
        block_hash: this.blockHashFor(this.blockHeight),
      });
    },
    callFunction: <T = unknown>(_contractId: string, method: string, args: Record<string, unknown>) => {
      if (method === 'last_receipt_id') {
        return Promise.resolve((this.nextReceiptId - 1n).toString() as T);
      }
      if (method === 'is_claimed') {
        const key = `${String(args.warehouse_id)}:${String(args.deposit_no)}`;
        return Promise.resolve(this.claimed.has(key) as T);
      }
      if (method === 'get_anchor') {
        const anchor = this.anchors.get(String(args.warehouse_id));
        if (anchor === undefined) return Promise.resolve(null as T);
        const view: SandboxAnchorView = {
          day: anchor.day,
          head: anchor.head.toString('hex'),
        };
        return Promise.resolve(view as T);
      }
      if (method === 'get_receipt') {
        const receipt = this.receipts.get(String(args.receipt_id));
        return Promise.resolve((receipt ?? null) as T);
      }
      return Promise.resolve(null as T);
    },
    sendTxAsync: (envelopeB64) => {
      const decoded = SignedTransaction.decode(Buffer.from(envelopeB64, 'base64'));
      const txHash = baseEncode(
        createHash('sha256').update(decoded.transaction.encode()).digest(),
      );
      const signerId = decoded.transaction.signerId;
      const receiverId = decoded.transaction.receiverId;
      this.blockHeight += 1;
      const blockHash = this.blockHashFor(this.blockHeight);
      const tsNs = this.timestampNs();

      // Native transfer (auto-funding implicit account)
      const transfer = decoded.transaction.actions[0]?.transfer;
      if (transfer !== undefined) {
        this.accounts.set(receiverId, {
          amount: transfer.deposit.toString(),
          locked: '0',
          code_hash: '11111111111111111111111111111111',
          storage_usage: 100,
          block_height: this.blockHeight,
          block_hash: blockHash,
        });
        this.txStatuses.set(txHash, {
          status: { SuccessValue: '' },
          transaction: {
            hash: txHash,
            signer_id: signerId,
            public_key: decoded.transaction.publicKey.toString(),
            nonce: Number(decoded.transaction.nonce),
            receiver_id: receiverId,
            actions: [],
          },
          transaction_outcome: {
            id: txHash,
            block_hash: blockHash,
            outcome: {
              executor_id: signerId,
              logs: [],
              receipt_ids: [],
              status: { SuccessValue: '' },
            },
          },
          receipts_outcome: [],
        });
        return Promise.resolve(txHash);
      }

      const fnCall = decoded.transaction.actions[0]?.functionCall;
      if (fnCall === undefined) {
        throw new Error('Unsupported sandbox action');
      }
      const methodName = fnCall.methodName;
      const rawArgs = Buffer.from(fnCall.args).toString('utf8');
      const args = JSON.parse(rawArgs) as Record<string, unknown>;

      const exec = this.executeContractCall(signerId, methodName, args);
      const statusValue =
        exec.returnValue === null
          ? ''
          : Buffer.from(JSON.stringify(exec.returnValue), 'utf8').toString('base64');

      this.txStatuses.set(txHash, {
        status: { SuccessValue: statusValue },
        transaction: {
          hash: txHash,
          signer_id: signerId,
          public_key: decoded.transaction.publicKey.toString(),
          nonce: Number(decoded.transaction.nonce),
          receiver_id: receiverId,
          actions: [
            {
              FunctionCall: {
                method_name: methodName,
                args: Buffer.from(fnCall.args).toString('base64'),
                gas: Number(fnCall.gas),
                deposit: fnCall.deposit.toString(),
              },
            },
          ],
        },
        transaction_outcome: {
          id: txHash,
          block_hash: blockHash,
          outcome: {
            executor_id: signerId,
            logs: [],
            receipt_ids: [`receipt:${txHash}`],
            status: { SuccessReceiptId: `receipt:${txHash}` },
          },
        },
        receipts_outcome: [
          {
            id: `receipt:${txHash}`,
            block_hash: blockHash,
            outcome: {
              executor_id: SANDBOX_CONTRACT,
              logs: exec.logs,
              receipt_ids: [],
              status: { SuccessValue: statusValue },
            },
          },
        ],
      });
      this.activity.push({
        txHash,
        signerId,
        blockHeight: this.blockHeight,
        blockTimestampNs: tsNs,
      });
      return Promise.resolve(txHash);
    },
    txStatus: (txHash) => Promise.resolve(this.txStatuses.get(txHash) ?? null),
  };

  private executeContractCall(
    signerId: string,
    method: string,
    args: Record<string, unknown>,
  ): { logs: string[]; returnValue: unknown } {
    if (method === 'anchor') {
      const warehouseId = String(args.warehouse_id);
      const day = Number(args.day);
      const leaves = Number(args.leaves);
      const rootHex = String(args.root);
      const root = Buffer.from(rootHex, 'hex');
      const prevHead = this.anchors.get(warehouseId)?.head ?? ZERO_HEAD;
      const head = nextHead(prevHead, day, leaves, root);
      this.anchors.set(warehouseId, { day, head, root, leaves });

      return {
        returnValue: null,
        logs: [
          nep297Log('anchored', {
            warehouse_id: warehouseId,
            day,
            leaves,
            root: rootHex,
            prev_head: prevHead.toString('hex'),
            head: head.toString('hex'),
            custodian: signerId,
            anchored_at: String(this.nowSeconds()),
          }),
        ],
      };
    }

    if (method === 'mint_propose') {
      const leaf = args.leaf as LeafJson;
      const proofHex = args.proof as string[];
      const notAfter = Number(args.not_after);
      const proof = proofHex.map((h) => Buffer.from(h, 'hex'));
      const anchor = this.anchors.get(leaf.warehouse_id);
      if (anchor === undefined) throw new Error('E50:NoAnchor');
      if (anchor.day !== leaf.day) throw new Error('E51:StaleLeaf');
      const leafHash = nearLeafHash(leaf);
      if (
        proof.length !== depthFor(anchor.leaves) ||
        !foldProof(leafHash, leaf.index, proof).equals(anchor.root)
      ) {
        throw new Error('E52:InvalidProof');
      }
      const key = `${leaf.warehouse_id}:${leaf.deposit_no}`;
      this.pendingMints.set(key, {
        leaf,
        proof,
        leafHashHex: leafHash.toString('hex'),
        custodian: signerId,
        notAfter,
      });
      return {
        returnValue: null,
        logs: [
          nep297Log('mint_proposed', {
            warehouse_id: leaf.warehouse_id,
            deposit_no: String(leaf.deposit_no),
            custodian: signerId,
            not_after: notAfter,
          }),
        ],
      };
    }

    if (method === 'mint_approve') {
      const warehouseId = String(args.warehouse_id);
      const depositNo = String(args.deposit_no);
      const expectedLeafHash = String(args.expected_leaf_hash);
      const key = `${warehouseId}:${depositNo}`;
      const pending = this.pendingMints.get(key);
      if (pending === undefined) throw new Error('E70:PendingNotFound');
      if (this.nowSeconds() >= pending.notAfter) throw new Error('E72:PendingExpired');
      if (pending.leafHashHex !== expectedLeafHash) throw new Error('E71:PendingMismatch');
      this.pendingMints.delete(key);
      this.claimed.add(key);

      const id = (this.nextReceiptId++).toString();
      const leaf = pending.leaf;
      this.receipts.set(id, {
        receipt_id: id,
        parent_id: null,
        status: 'Active',
        weight_kg: String(leaf.kg),
        bag_count: leaf.bags,
        owner: leaf.owner,
        warehouse_id: leaf.warehouse_id,
        deposit_no: String(leaf.deposit_no),
        deposit_id: leaf.deposit_id,
        weight_source: leaf.weight_source,
        lender: null,
      });

      return {
        returnValue: id,
        logs: [
          nep297Log('minted', {
            receipt_id: id,
            warehouse_id: leaf.warehouse_id,
            deposit_no: String(leaf.deposit_no),
            deposit_id: leaf.deposit_id,
            owner: leaf.owner,
            commodity: leaf.commodity,
            grade: leaf.grade,
            weight_kg: String(leaf.kg),
            bag_count: leaf.bags,
            moisture_bps: leaf.moisture_bps,
            weight_source: leaf.weight_source,
            anchor_day: leaf.day,
            leaf_hash: pending.leafHashHex,
            minted_at: String(this.nowSeconds()),
          }),
        ],
      };
    }

    if (method === 'lock_accept') {
      const receiptId = String(args.receipt_id);
      const expectedLender = String(args.lender ?? args.expected_lender);
      const expectedAmountKg = String(args.expected_amount_kg);
      const expectedLoanRef = String(args.expected_loan_ref);
      const receipt = this.receipts.get(receiptId);
      if (receipt === undefined) throw new Error('E10:ReceiptNotFound');
      if (receipt.owner !== signerId) throw new Error('E23:NotReceiptOwner');
      const offer = this.pendingLocks.get(receiptId);
      if (offer === undefined) throw new Error('E70:PendingNotFound');
      if (
        offer.lender !== expectedLender ||
        offer.amountKg !== expectedAmountKg ||
        offer.loanRef !== expectedLoanRef
      ) {
        throw new Error('E71:PendingMismatch');
      }
      this.pendingLocks.delete(receiptId);
      this.receipts.set(receiptId, {
        ...receipt,
        status: 'Locked',
        lender: offer.lender,
      });
      return {
        returnValue: receiptId,
        logs: [
          nep297Log('locked', {
            receipt_id: receiptId,
            lender: offer.lender,
            weight_kg: offer.amountKg,
            loan_ref: offer.loanRef,
            due_date: String(offer.dueDate),
            grace_period: String(offer.gracePeriodSeconds),
          }),
        ],
      };
    }

    throw new Error(`Unhandled sandbox contract method: ${method}`);
  }
}

describe('NEAR sandbox full flow (test/chain/near/sandbox.test.ts)', () => {
  let h: ChainHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('anchor → propose/approve mint → offer/accept lock → indexer ingests every event → reconcile() finds no drift', async () => {
    let sandbox!: InProcessNearSandbox;
    h = await startChainHarness({
      start: middayOf(DAY),
      backend: 'near',
      env: {
        NEAR_CONTRACT_ID: SANDBOX_CONTRACT,
        NEAR_CONTRACT_START_BLOCK: String(START_BLOCK),
      },
      chain: ({ adapters, clock }) => {
        sandbox = new InProcessNearSandbox(() => Math.floor(clock.now().getTime() / 1000));
        return new NearChainClient(
          {
            rpcUrl: 'http://127.0.0.1:3030',
            networkId: 'sandbox',
            contractId: SANDBOX_CONTRACT,
            operatorSubject: OPERATOR_SUBJECT,
            operatorFundYocto: 100_000_000_000_000_000_000_000n,
            indexerUrl: 'http://127.0.0.1:3030/indexer',
            fetchFn: sandbox.fetchFn,
            pollIntervalMs: 5,
            pollTimeoutMs: 100,
          },
          adapters.keys,
          createLogger('silent'),
          clock.now,
          sandbox.rpc,
        );
      },
    });

    const custodianId = await addressFor(
      h.adapters.keys,
      subjectOf.custodian(h.fixtures.custodianId),
      'near',
    );
    const verifierId = await addressFor(
      h.adapters.keys,
      subjectOf.verifier(h.fixtures.verifierId),
      'near',
    );

    // 1. Register warehouse, custodian, and verifier on-chain and ingest initial registry events.
    sandbox.seedRegistration('KN_DAWANAU', custodianId, verifierId);
    const initialIngest = await h.indexer.ingest();
    expect(initialIngest.archived).toBe(3);

    // 2. Intake a scale-weighed deposit and close + anchor the day via NearChainClient.
    const lot = await h.scaleLot(20);
    h.clock.set(middayOf(DAY + 1));
    const anchorRuns = await h.anchoring.runWarehouse(h.fixtures.warehouseId);
    expect(anchorRuns).toEqual([expect.objectContaining({ day: DAY, anchored: true })]);

    // 3. Propose + approve mint and prepare the lock offer via POST /pledges.
    const created = await request(h.app)
      .post('/pledges')
      .send({
        deposit_id: lot.depositId,
        lender: LENDER,
        kg: 1995,
        loan_ref: 'LOAN-SANDBOX-001',
        due_date: new Date(middayOf(DAY + 90)).toISOString(),
        grace_period_seconds: 86_400,
        requested_by: h.fixtures.custodianId,
        verifier_id: h.fixtures.verifierId,
        farmer_confirmed: true,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pledgeBody = created.body as {
      pledge: {
        pledge_id: string;
        status: string;
        receipt_id: string;
        lender_tx_request: NearOfferTxRequest;
      };
    };
    expect(pledgeBody.pledge.status).toBe('awaiting_lender_offer');
    expect(pledgeBody.pledge.receipt_id).toBe('1');

    // 4. Lender submits lock_offer on-chain, then farmer accepts via POST /pledges/:id/lender-offer.
    const offerTxHash = sandbox.submitLenderOffer(LENDER, pledgeBody.pledge.lender_tx_request);
    const locked = await request(h.app)
      .post(`/pledges/${pledgeBody.pledge.pledge_id}/lender-offer`)
      .send({ txHash: offerTxHash });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body).toMatchObject({
      pledge: {
        pledge_id: pledgeBody.pledge.pledge_id,
        status: 'locked',
        locked_receipt_id: '1',
      },
    });

    // 5. Indexer ingests every NEP-297 event emitted across anchor, mint, and lock.
    const finalIngest = await h.indexer.ingest();
    expect(finalIngest.archived).toBe(5); // anchored, mint_proposed, minted, lock_offered, locked

    const { rows: archivedEvents } = await h.pool.query<{ event_type: string }>(
      `SELECT event_type FROM events_archive
        WHERE contract_id = $1
        ORDER BY ledger, tx_index, op_index, event_index`,
      [SANDBOX_CONTRACT],
    );
    expect(archivedEvents.map((r) => r.event_type)).toEqual([
      'warehouse_added',
      'custodian_added',
      'verifier_added',
      'anchored',
      'mint_proposed',
      'minted',
      'lock_offered',
      'locked',
    ]);

    // 6. Projections match on-chain state and reconcile() + checkMints() report zero drift.
    const { rows: projectedReceipts } = await h.pool.query<{
      receipt_id: string;
      status: string;
      lender: string;
      weight_kg: string;
    }>(
      `SELECT receipt_id, status, lender, weight_kg FROM chain_receipts WHERE contract_id = $1`,
      [SANDBOX_CONTRACT],
    );
    expect(projectedReceipts).toEqual([
      {
        receipt_id: '1',
        status: 'Locked',
        lender: LENDER,
        weight_kg: '1995',
      },
    ]);

    expect(await h.indexer.reconcile()).toEqual([]);
    expect(await h.reconciliation.checkMints()).toEqual([]);
  });
});

const liveSandboxRpcUrl = process.env.NEAR_SANDBOX_RPC_URL;
describe.skipIf(!liveSandboxRpcUrl)(
  'Live near-sandbox node smoke check (NEAR_SANDBOX_RPC_URL)',
  () => {
    it('connects to the live near-sandbox JSON-RPC endpoint and reads block height', async () => {
      const rpc = new HttpNearRpc(liveSandboxRpcUrl ?? 'http://127.0.0.1:3030');
      const status = await rpc.status();
      expect(status.sync_info.latest_block_height).toBeGreaterThanOrEqual(0);
    });
  },
);
