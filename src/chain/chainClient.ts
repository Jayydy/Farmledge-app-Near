import type { Queryable } from '../db/pool.js';
import type { LeafJson } from '../domain/merkle.js';

/**
 * The port to the receipt contract, `data_version` 3 (docs/events.md, the
 * protocol README). Reads are free simulations. Every write is built,
 * simulated, signed, **recorded in `chain_transactions` with its hash and
 * max_time before it is submitted**, then submitted and polled. A timeout
 * never leads to a blind retry: `resolve` looks the recorded hash up first,
 * and only the same signed envelope is ever sent again (D30).
 *
 * Signing: auth entries are signed only for the key-service subjects the
 * caller names (`signers`). Nothing here can sign for an address that is
 * not one of those subjects; a lender's authorisation always arrives
 * already signed (D31).
 */
export interface ChainClient {
  readonly enabled: boolean;
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;

  // --- reads -----------------------------------------------------------------
  latestLedger(): Promise<{ sequence: number; closeTime: number }>;
  /** False after a Testnet reset: the contract instance is gone. */
  instanceExists(): Promise<boolean>;
  getAnchor(warehouseSymbol: string): Promise<AnchorHead | null>;
  getReceipt(receiptId: bigint): Promise<ReceiptState | null>;
  /**
   * The highest receipt id the contract has assigned (0 if none), read from
   * its instance storage. Ids are assigned 1, 2, 3, … and never reused, so
   * every receipt that ever existed has an id in 1..this.
   */
  lastReceiptId(): Promise<bigint>;
  isClaimed(warehouseSymbol: string, depositNo: number): Promise<boolean>;
  leafHash(leaf: LeafJson): Promise<Buffer>;
  /** Ledger sequence until which each receipt's entry lives; null if not found. */
  receiptLiveUntil(receiptIds: readonly bigint[]): Promise<Map<string, number | null>>;
  getEvents(range: { startLedger: number; endLedger?: number }): Promise<EventPage>;
  /** The address a key-service subject signs as. */
  addressOf(subject: string): Promise<string>;

  // --- writes (recorded before submission) -----------------------------------
  anchor(db: Queryable, call: AnchorCall): Promise<ChainTxOutcome>;
  mintFromAnchor(db: Queryable, call: MintCall): Promise<ChainTxOutcome>;
  /** Simulates a lock and returns the lender's unsigned authorisation. */
  prepareLock(call: LockCall): Promise<PreparedLock>;
  /**
   * Submits a lock with the lender's signed authorisation. Signs only the
   * owner's entry, as `ownerSubject`; refuses if the lender's entry is not
   * validly signed by the lender.
   */
  submitLock(
    db: Queryable,
    call: LockCall,
    signedLenderEntryXdr: string,
    ownerSubject: string,
    subject: string,
  ): Promise<ChainTxOutcome>;
  extendTtlBatch(db: Queryable, receiptIds: readonly bigint[]): Promise<ChainTxOutcome>;
  /** Looks a recorded transaction up and settles its status. Never resubmits blindly. */
  resolve(db: Queryable, chainTransactionId: string): Promise<ChainTxOutcome>;
}

export interface AnchorHead {
  day: number;
  head: Buffer;
}

export type ReceiptStatus = 'Active' | 'Locked' | 'Recovery' | 'Exited' | 'Revoked';

export interface ReceiptState {
  receiptId: bigint;
  parentId: bigint | null;
  status: ReceiptStatus;
  weightKg: bigint;
  bagCount: number;
  owner: string;
  warehouseSymbol: string;
  depositNo: bigint;
  depositId: string;
  weightSource: 'Scale' | 'BagEstimate';
  lender: string | null;
}

export interface AnchorCall {
  /** Key-service subject of a custodian registered on-chain for the warehouse. */
  custodianSubject: string;
  warehouseSymbol: string;
  day: number;
  root: Buffer;
  leaves: number;
  subject: string;
}

export interface MintCall {
  custodianSubject: string;
  verifierSubject: string;
  leaf: LeafJson;
  proof: readonly Buffer[];
  subject: string;
  /** INV-1: the mint must never land after this (5 minutes). */
  maxTimeSeconds: number;
  /**
   * INV-1: absolute deadline (Unix seconds), fixed when the lot was frozen.
   * No transaction is built once it has passed, and none carries a later
   * max_time, so once a ledger closes after it the mint can no longer land.
   */
  notAfter: number;
}

export interface LockCall {
  receiptId: bigint;
  lender: string;
  kg: bigint;
  loanRef: string;
  /** Unix seconds. */
  dueDate: number;
  gracePeriodSeconds: number;
}

export interface PreparedLock {
  /** The lender's SorobanAuthorizationEntry, unsigned, base64 XDR. */
  lenderEntryXdr: string;
  /** Ledger until which the lender's signature must be valid. */
  validUntilLedger: number;
  /** What the lender signs: sha256 of the entry's HashIdPreimage, hex. */
  payloadHashHex: string;
}

export type ChainTxStatus = 'signed' | 'submitted' | 'success' | 'failed' | 'expired';

export interface ChainTxOutcome {
  /** `chain_transactions.id`. */
  id: string;
  txHash: string;
  status: ChainTxStatus;
  /** Contract error code when the call failed in simulation or on-ledger. */
  contractError: number | null;
  /** The call's return value (base64 ScVal) on success. */
  returnValueXdr: string | null;
  ledger: number | null;
  error: string | null;
  /**
   * Set when the transaction is not on-chain as far as RPC can tell, its
   * max_time has passed, but RPC no longer holds every ledger it could have
   * landed in: absence there proves nothing. Status stays unsettled; the
   * caller must settle it from the event archive or keep waiting.
   */
  undetermined?: {
    reason: 'outside_rpc_retention';
    /** A ledger known to have closed after max_time. */
    closedAfterMaxTimeLedger: number;
  };
}

export interface ChainEvent {
  /** RPC event id: deterministic per (ledger, transaction, operation, event). */
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  txIndex: number;
  opIndex: number;
  /** Position of the event within its transaction. */
  eventIndex: number;
  inSuccessfulContractCall: boolean;
  topicXdr: string[];
  valueXdr: string;
}

export interface EventPage {
  events: ChainEvent[];
  latestLedger: number;
  oldestLedger: number;
  /** Ledgers [startLedger, coveredThrough] were fully scanned by this page. */
  coveredThrough: number;
  cursor: string;
}

/** Contract error codes the backend reacts to (contract errors.rs; public ABI). */
export const ContractError = {
  DuplicateDepositId: 11,
  InvalidStatus: 12,
  CustodianNotRegistered: 21,
  VerifierNotRegistered: 22,
  OnlyScaleEligibleForLock: 30,
  LenderIsOwner: 36,
  WrongLeafKind: 50,
  StaleLeaf: 51,
  InvalidProof: 52,
  NoAnchor: 53,
  AnchorOutOfOrder: 54,
  AnchorInFuture: 55,
  LeafHasReceipt: 57,
} as const;

/** README: at most 25 receipts per extend_ttl_batch. */
export const MAX_TTL_BATCH = 25;

export class ChainDisabledError extends Error {
  constructor() {
    super('CHAIN_ENABLED=false: nothing goes on chain in this deployment');
    this.name = 'ChainDisabledError';
  }
}

/** INV-1: the call's deadline passed before anything was signed or recorded. */
export class DeadlineError extends Error {
  constructor(readonly notAfter: number) {
    super(`the deadline ${new Date(notAfter * 1000).toISOString()} passed before submission`);
    this.name = 'DeadlineError';
  }
}

/** A simulation or submission the contract refused, with its error code. */
export class ContractCallError extends Error {
  constructor(
    readonly method: string,
    readonly contractError: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ContractCallError';
  }
}
