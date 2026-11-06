import { createHash, randomBytes } from 'node:crypto';

import type { Keypair } from '@stellar/stellar-sdk';
import { Address, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { addressFor } from '../../src/chain/addresses.js';
import {
  ContractCallError,
  DeadlineError,
  ContractError,
  type AnchorCall,
  type AnchorHead,
  type ChainClient,
  type ChainEvent,
  type ChainTxOutcome,
  type EventPage,
  type LockCall,
  type MintCall,
  type PreparedLock,
  type ReceiptState,
} from '../../src/chain/chainClient.js';
import { authPayloadHash, verifyLenderEntry } from '../../src/chain/sorobanChainClient.js';
import type { Queryable } from '../../src/db/pool.js';
import { utcDay } from '../../src/domain/book.js';
import { entryHash, foldProof, nextHead, depthFor, ZERO_HEAD } from '../../src/domain/merkle.js';
import type { KeyService } from '../../src/keys/keyService.js';

export const FAKE_CONTRACT = 'CBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN';
const PASSPHRASE = 'Test SDF Network ; September 2015';

/**
 * timeout: submitted, outcome unknown, never lands.
 * landed_unseen: it lands on-chain, but the backend never learns so
 * (a crash or timeout before the answer); resolve() reports it pending.
 */
type FailMode =
  | 'simulation'
  | 'ledger'
  /** Passes simulation, then the contract refuses it on-ledger with StaleLeaf / NoAnchor. */
  | 'ledger_stale'
  | 'ledger_noanchor'
  | 'timeout'
  | 'landed_unseen';

/**
 * An in-memory stand-in for the receipt contract, for database-level tests.
 * It enforces the contract's own rules that the backend relies on (anchor
 * order, latest-day balance leaves only, proof folding to the stored root,
 * one mint per deposit number) so a test can show what the backend must
 * enforce on top. Every write is recorded in `chain_transactions` like the
 * real client. The Testnet suite runs the same flows against the real
 * contract.
 */
export class FakeChain implements ChainClient {
  readonly enabled = true;
  readonly contractId = FAKE_CONTRACT;
  readonly networkPassphrase = PASSPHRASE;
  readonly rpcUrl = 'https://rpc.fake.test';
  ledger = 1_000_000;
  instanceGone = false;
  readonly heads = new Map<string, AnchorHead>();
  readonly roots = new Map<string, { root: Buffer; leaves: number }>();
  readonly claimed = new Set<string>();
  readonly receipts = new Map<string, ReceiptState>();
  readonly ttlBatches: bigint[][] = [];
  readonly liveUntil = new Map<string, number>();
  readonly events: ChainEvent[] = [];
  private nextReceipt = 1n;
  private failNext: { method: string; mode: FailMode } | null = null;
  /**
   * RPC's retention window no longer covers transactions signed before now:
   * resolve() reports an unsettled, past-max_time transaction as undetermined.
   */
  retentionLost = false;
  /** Awaited before a mint is built: stands for time spent in the submission queue. */
  beforeMint: (() => Promise<void>) | null = null;
  /** After the next anchor lands, get_anchor returns a head other than the one computed. */
  tamperHeadAfterAnchor = false;
  /** Every subject the fake was asked to sign for, by method. */
  readonly signedFor: { method: string; subject: string }[] = [];

  constructor(
    private readonly keys: KeyService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  failNextCall(method: string, mode: FailMode): void {
    this.failNext = { method, mode };
  }

  addressOf(subject: string): Promise<string> {
    return addressFor(this.keys, subject);
  }

  latestLedger() {
    return Promise.resolve({
      sequence: this.ledger,
      closeTime: Math.floor(this.clock().getTime() / 1000),
    });
  }

  instanceExists() {
    return Promise.resolve(!this.instanceGone);
  }

  getAnchor(symbol: string) {
    return Promise.resolve(this.heads.get(symbol) ?? null);
  }

  getReceipt(id: bigint) {
    return Promise.resolve(this.receipts.get(id.toString()) ?? null);
  }

  lastReceiptId() {
    return Promise.resolve(this.nextReceipt - 1n);
  }

  /** A receipt created on-chain directly (no mint call), with the next id. */
  seedReceipt(status: ReceiptState['status']): bigint {
    const id = this.nextReceipt++;
    this.receipts.set(id.toString(), {
      receiptId: id,
      parentId: null,
      status,
      weightKg: 100n,
      bagCount: 1,
      owner: 'G',
      warehouseSymbol: 'KN_DAWANAU',
      depositNo: id,
      depositId: 'd',
      weightSource: 'Scale',
      lender: null,
    });
    return id;
  }

  isClaimed(symbol: string, depositNo: number) {
    return Promise.resolve(this.claimed.has(`${symbol}:${depositNo}`));
  }

  leafHash(leaf: Parameters<ChainClient['leafHash']>[0]) {
    return Promise.resolve(entryHash(leaf));
  }

  receiptLiveUntil(ids: readonly bigint[]) {
    return Promise.resolve(
      new Map(
        ids.map((id) => [
          id.toString(),
          this.liveUntil.get(id.toString()) ?? this.ledger + 175 * 17_280,
        ]),
      ),
    );
  }

  getEvents(range: { startLedger: number; endLedger?: number }): Promise<EventPage> {
    const end =
      range.endLedger === undefined ? this.ledger : Math.min(range.endLedger - 1, this.ledger);
    return Promise.resolve({
      events: this.events.filter((e) => e.ledger >= range.startLedger && e.ledger <= end),
      latestLedger: this.ledger,
      oldestLedger: this.ledger - 120_960,
      coveredThrough: end,
      cursor: '',
    });
  }

  async anchor(db: Queryable, call: AnchorCall): Promise<ChainTxOutcome> {
    this.signedFor.push({ method: 'anchor', subject: call.custodianSubject });
    this.maybeFailSimulation('anchor');
    const last = this.heads.get(call.warehouseSymbol);
    if (last !== undefined && call.day <= last.day) {
      throw new ContractCallError('anchor', ContractError.AnchorOutOfOrder, 'Error(Contract, #54)');
    }
    if (call.day > utcDay(this.clock())) {
      throw new ContractCallError('anchor', ContractError.AnchorInFuture, 'Error(Contract, #55)');
    }
    return this.record(db, 'anchor', call.subject, () => {
      const head = nextHead(last?.head ?? ZERO_HEAD, call.day, call.leaves, call.root);
      this.heads.set(call.warehouseSymbol, {
        day: call.day,
        head: this.tamperHeadAfterAnchor ? randomBytes(32) : head,
      });
      this.roots.set(`${call.warehouseSymbol}:${call.day}`, {
        root: call.root,
        leaves: call.leaves,
      });
      return null;
    });
  }

  async mintFromAnchor(db: Queryable, call: MintCall): Promise<ChainTxOutcome> {
    if (this.beforeMint !== null) await this.beforeMint();
    // As the real client: refused before anything is signed once the deadline has passed.
    if (Math.floor(this.clock().getTime() / 1000) >= call.notAfter) {
      throw new DeadlineError(call.notAfter);
    }
    this.signedFor.push({ method: 'mint_from_anchor', subject: call.custodianSubject });
    this.signedFor.push({ method: 'mint_from_anchor', subject: call.verifierSubject });
    this.maybeFailSimulation('mint_from_anchor');
    const leaf = call.leaf;
    const fail = (code: number) => {
      throw new ContractCallError('mint_from_anchor', code, `Error(Contract, #${code})`);
    };
    if (leaf.kind !== 2) fail(ContractError.WrongLeafKind);
    if (leaf.receipt_id !== 0 || leaf.receipt_version !== 0) fail(ContractError.LeafHasReceipt);
    const head = this.heads.get(leaf.warehouse_id);
    if (head === undefined) fail(ContractError.NoAnchor);
    if (head?.day !== leaf.day) fail(ContractError.StaleLeaf);
    const stored = this.roots.get(`${leaf.warehouse_id}:${leaf.day}`);
    if (
      stored === undefined ||
      call.proof.length !== depthFor(stored.leaves) ||
      !foldProof(entryHash(leaf), leaf.index, call.proof).equals(stored.root)
    ) {
      fail(ContractError.InvalidProof);
    }
    if (this.claimed.has(`${leaf.warehouse_id}:${leaf.deposit_no}`))
      fail(ContractError.DuplicateDepositId);
    return this.record(
      db,
      'mint',
      call.subject,
      () => {
        this.claimed.add(`${leaf.warehouse_id}:${leaf.deposit_no}`);
        const id = this.nextReceipt++;
        this.receipts.set(id.toString(), {
          receiptId: id,
          parentId: null,
          status: 'Active',
          weightKg: BigInt(leaf.kg),
          bagCount: leaf.bags,
          owner: leaf.owner,
          warehouseSymbol: leaf.warehouse_id,
          depositNo: BigInt(leaf.deposit_no),
          depositId: leaf.deposit_id,
          weightSource: leaf.weight_source,
          lender: null,
        });
        return nativeToScVal(id, { type: 'u64' }).toXdr('base64');
      },
      call.notAfter,
    );
  }

  /** Builds the lender's unsigned authorisation exactly as the real client does. */
  prepareLock(call: LockCall): Promise<PreparedLock> {
    const receipt = this.receipts.get(call.receiptId.toString());
    if (receipt === undefined)
      return Promise.reject(new ContractCallError('lock', 10, 'Error(Contract, #10)'));
    if (receipt.owner === call.lender)
      throw new ContractCallError('lock', 36, 'Error(Contract, #36)');
    const entry = lenderEntry(call, this.contractId, this.ledger + 17_280);
    return Promise.resolve({
      lenderEntryXdr: entry.toXdr('base64'),
      validUntilLedger: this.ledger + 17_280,
      payloadHashHex: authPayloadHash(entry, this.networkPassphrase).toString('hex'),
    });
  }

  async submitLock(
    db: Queryable,
    call: LockCall,
    signedLenderEntryXdr: string,
    ownerSubject: string,
    subject: string,
  ): Promise<ChainTxOutcome> {
    // The same verification the real client runs before anything is sent.
    verifyLenderEntry(
      xdr.SorobanAuthorizationEntry.fromXdr(signedLenderEntryXdr, 'base64'),
      call,
      this.contractId,
      this.networkPassphrase,
    );
    this.signedFor.push({ method: 'lock', subject: ownerSubject });
    this.maybeFailSimulation('lock');
    const receipt = this.receipts.get(call.receiptId.toString());
    if (receipt?.status !== 'Active')
      throw new ContractCallError('lock', 12, 'Error(Contract, #12)');
    if (receipt.weightSource !== 'Scale')
      throw new ContractCallError('lock', 30, 'Error(Contract, #30)');
    return this.record(db, 'lock', subject, () => {
      receipt.status = 'Locked';
      receipt.lender = call.lender;
      return nativeToScVal(call.receiptId, { type: 'u64' }).toXdr('base64');
    });
  }

  async extendTtlBatch(db: Queryable, ids: readonly bigint[]): Promise<ChainTxOutcome> {
    if (ids.length > 25)
      throw new ContractCallError('extend_ttl_batch', 40, 'Error(Contract, #40)');
    return this.record(db, 'extend_ttl_batch', `keepalive:${ids.join(',')}`, () => {
      this.ttlBatches.push([...ids]);
      return null;
    });
  }

  async resolve(db: Queryable, id: string): Promise<ChainTxOutcome> {
    const { rows } = await db.query<{
      id: string;
      tx_hash: string;
      status: ChainTxOutcome['status'];
      max_time: Date;
      error: string | null;
    }>('SELECT id, tx_hash, status, max_time, error FROM chain_transactions WHERE id = $1', [id]);
    const row = rows[0];
    if (row === undefined) throw new Error('no such transaction');
    const unsettled = row.status === 'submitted' || row.status === 'signed';
    if (unsettled && this.retentionLost && this.clock().getTime() > row.max_time.getTime()) {
      return {
        ...outcome(row),
        undetermined: { reason: 'outside_rpc_retention', closedAfterMaxTimeLedger: this.ledger },
      };
    }
    if (row.status === 'submitted' && this.clock().getTime() > row.max_time.getTime()) {
      await db.query(
        `UPDATE chain_transactions SET status = 'expired', resolved_at = now(), error = 'max_time passed'
          WHERE id = $1`,
        [id],
      );
      return { ...outcome(row), status: 'expired' };
    }
    return outcome(row);
  }

  private maybeFailSimulation(method: string): void {
    if (this.failNext?.method === method && this.failNext.mode === 'simulation') {
      this.failNext = null;
      throw new ContractCallError(
        method,
        ContractError.VerifierNotRegistered,
        'Error(Contract, #22)',
      );
    }
  }

  private async record(
    db: Queryable,
    purpose: string,
    subject: string,
    apply: () => string | null,
    notAfter?: number,
  ): Promise<ChainTxOutcome> {
    const txHash = randomBytes(32).toString('hex');
    const maxTime = new Date(
      Math.min(
        this.clock().getTime() + 300_000,
        (notAfter ?? Number.MAX_SAFE_INTEGER / 1000) * 1000,
      ),
    );
    const mode =
      this.failNext?.method !== undefined && purposeOf(this.failNext.method) === purpose
        ? this.failNext.mode
        : null;
    if (mode !== null) this.failNext = null;
    // Recorded before "submission", as the real client does.
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO chain_transactions (contract_id, purpose, subject, tx_hash, envelope_xdr, max_time,
                                       signed_after_ledger)
       VALUES ($1, $2, $3, $4, 'fake-envelope', $5, $6) RETURNING id`,
      [this.contractId, purpose, subject, txHash, maxTime, this.ledger],
    );
    const id = inserted.rows[0]?.id ?? '';
    if (mode === 'landed_unseen') {
      apply();
      this.ledger += 1;
      await db.query(
        `UPDATE chain_transactions SET status = 'submitted', submitted_at = now() WHERE id = $1`,
        [id],
      );
      return {
        id,
        txHash,
        status: 'submitted',
        contractError: null,
        returnValueXdr: null,
        ledger: null,
        error: null,
      };
    }
    if (mode === 'timeout') {
      await db.query(
        `UPDATE chain_transactions SET status = 'submitted', submitted_at = now() WHERE id = $1`,
        [id],
      );
      return {
        id,
        txHash,
        status: 'submitted',
        contractError: null,
        returnValueXdr: null,
        ledger: null,
        error: null,
      };
    }
    if (mode === 'ledger' || mode === 'ledger_stale' || mode === 'ledger_noanchor') {
      const code =
        mode === 'ledger_stale'
          ? ContractError.StaleLeaf
          : mode === 'ledger_noanchor'
            ? ContractError.NoAnchor
            : null;
      const error =
        code === null ? 'failed on-ledger' : `failed on-ledger: Error(Contract, #${code})`;
      await db.query(
        `UPDATE chain_transactions SET status = 'failed', resolved_at = now(), error = $2
          WHERE id = $1`,
        [id, error],
      );
      return {
        id,
        txHash,
        status: 'failed',
        contractError: code,
        returnValueXdr: null,
        ledger: null,
        error,
      };
    }
    const returnValue = apply();
    this.ledger += 1;
    await db.query(
      `UPDATE chain_transactions SET status = 'success', resolved_at = now(), ledger = $2,
              return_value_xdr = $3 WHERE id = $1`,
      [id, this.ledger, returnValue],
    );
    return {
      id,
      txHash,
      status: 'success',
      contractError: null,
      returnValueXdr: returnValue,
      ledger: this.ledger,
      error: null,
    };
  }
}

function purposeOf(method: string): string {
  return method === 'mint_from_anchor' ? 'mint' : method;
}

function outcome(row: {
  id: string;
  tx_hash: string;
  status: ChainTxOutcome['status'];
  error?: string | null;
}): ChainTxOutcome {
  // As the real client: a settled failure carries the contract's error code.
  const code = row.status === 'failed' ? /#(\d+)/.exec(row.error ?? '')?.[1] : undefined;
  return {
    id: row.id,
    txHash: row.tx_hash,
    status: row.status,
    contractError: code === undefined ? null : Number(code),
    returnValueXdr: null,
    ledger: null,
    error: row.error ?? null,
  };
}

/** The lender's unsigned SorobanAuthorizationEntry for a lock, as simulation returns it. */
export function lenderEntry(
  call: LockCall,
  contractId: string,
  validUntil: number,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: new xdr.SorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(call.lender).toScAddress(),
        nonce: BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`)),
        signatureExpirationLedger: validUntil,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId).toScAddress(),
          functionName: 'lock',
          args: [
            nativeToScVal(call.receiptId, { type: 'u64' }),
            Address.fromString(call.lender).toScVal(),
            nativeToScVal(call.kg, { type: 'u64' }),
            xdr.ScVal.scvString(call.loanRef),
            nativeToScVal(BigInt(call.dueDate), { type: 'u64' }),
            nativeToScVal(BigInt(call.gracePeriodSeconds), { type: 'u64' }),
          ],
        }),
      ),
      subInvocations: [],
    }),
  });
}

/** What a lender does on their side: sign the entry with their own key. */
export async function lenderSigns(
  entryXdr: string,
  lender: Keypair,
  validUntil: number,
): Promise<string> {
  const { authorizeEntry } = await import('@stellar/stellar-sdk');
  const signed = await authorizeEntry(
    xdr.SorobanAuthorizationEntry.fromXdr(entryXdr, 'base64'),
    lender,
    validUntil,
    PASSPHRASE,
  );
  return signed.toXdr('base64');
}

export { hash };

/** Encodes a contract event as the RPC returns it: topics, then a data map keyed by name. */
export function encodeEvent(
  ledger: number,
  txIndex: number,
  eventIndex: number,
  name: string,
  topics: xdr.ScVal[],
  data: Record<string, xdr.ScVal>,
): ChainEvent {
  const entries = Object.entries(data)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }));
  return {
    id: `${String(ledger).padStart(10, '0')}${txIndex}-${String(eventIndex).padStart(10, '0')}`,
    contractId: FAKE_CONTRACT,
    ledger,
    ledgerClosedAt: new Date(ledger * 5000).toISOString(),
    txHash: createHash('sha256').update(`${ledger}:${txIndex}`).digest('hex'),
    txIndex,
    opIndex: 0,
    eventIndex,
    inSuccessfulContractCall: true,
    topicXdr: [xdr.ScVal.scvSymbol(name), ...topics].map((t) => t.toXdr('base64')),
    valueXdr: xdr.ScVal.scvMap(entries).toXdr('base64'),
  };
}

export const sv = {
  u64: (n: number | bigint) => nativeToScVal(BigInt(n), { type: 'u64' }),
  u32: (n: number) => xdr.ScVal.scvU32(n),
  sym: (s: string) => xdr.ScVal.scvSymbol(s),
  str: (s: string) => xdr.ScVal.scvString(s),
  addr: (a: string) => Address.fromString(a).toScVal(),
  bytes: (b: Buffer) => xdr.ScVal.scvBytes(b),
  unit: (variant: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]),
  none: () => xdr.ScVal.scvVoid(),
};
