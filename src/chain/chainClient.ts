import type { Queryable } from '../db/pool.js';
import type { LeafJson } from '../domain/merkle.js';

export type ChainBackend = 'stellar' | 'near';

export type EventJson =
  | string
  | number
  | boolean
  | null
  | EventJson[]
  | { [key: string]: EventJson };

export interface DecodedEvent {
  name: string;
  /** Every field, topics and data, by name. */
  fields: Record<string, EventJson>;
  topics: EventJson[];
}

/** Topic fields after the event name, per event (docs/events.md; contract events.rs). */
export const EVENT_TOPICS: Record<string, readonly string[]> = {
  anchored: ['warehouse_id'],
  minted: ['receipt_id', 'warehouse_id'],
  preclaimed: ['warehouse_id'],
  split: ['parent_id'],
  exited: ['receipt_id', 'warehouse_id'],
  revoked: ['receipt_id', 'warehouse_id'],
  ttl_extended: ['receipt_id', 'warehouse_id'],
  locked: ['receipt_id', 'lender'],
  unlocked: ['receipt_id', 'lender'],
  due_extended: ['receipt_id', 'lender'],
  recovery_started: ['receipt_id', 'lender', 'warehouse_id'],
  recovery_completed: ['receipt_id', 'lender'],
  settlement_recorded: ['sale_id', 'lender'],
  warehouse_added: ['warehouse_id'],
  warehouse_removed: ['warehouse_id'],
  custodian_added: ['warehouse_id'],
  custodian_removed: ['warehouse_id'],
  verifier_added: ['verifier'],
  verifier_removed: ['verifier'],
  recovery_operator_added: ['operator'],
  recovery_operator_removed: ['operator'],
};

/**
 * The port to the receipt contract, `data_version` 3 (docs/events.md, the
 * protocol README). Reads are free simulations / views. Every write is built,
 * simulated, signed, **recorded in `chain_transactions` with its hash and
 * max_time before it is submitted**, then submitted and polled. A timeout
 * never leads to a blind retry: `resolve` looks the recorded hash up first,
 * and only the same signed envelope is ever sent again (D30).
 *
 * Signing: auth entries / transactions are signed only for the key-service
 * subjects the caller names (`signers`). Nothing here can sign for an address
 * that is not one of those subjects; a lender's authorisation or offer always
 * arrives from the lender's own wallet (D31).
 */
export interface ChainClient {
  readonly backend: ChainBackend;
  readonly enabled: boolean;
  readonly contractId: string;
  /** Network identifier: Stellar network passphrase or NEAR network ('testnet' | 'mainnet'). */
  readonly networkId: string;
  /** Alias for `networkId` (retained for Stellar callers). */
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly capabilities: { readonly ttl: boolean };

  /** Validates a chain account address (G... on Stellar; named or 64-hex implicit account on NEAR). */
  validateAccount(address: string): boolean;

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
  /** Prepares a lock: Soroban auth entry on Stellar, or `lock_offer` tx request on NEAR. */
  prepareLock(call: LockCall): Promise<PreparedLock>;
  /**
   * Submits a lock with the lender's proof (`signedLenderEntryXdr` on Stellar,
   * or `lenderOfferTxHash` on NEAR). Signs only for `ownerSubject`; refuses if
   * the lender's proof is not valid (D31).
   */
  submitLock(
    db: Queryable,
    call: LockCall,
    lenderProof: string,
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

export interface NearOfferTxRequest {
  /** Receipt contract ID. */
  readonly receiverId: string;
  readonly methodName: 'lock_offer';
  readonly args: {
    /** u64 decimal string (NEP-297 style). */
    readonly receipt_id: string;
    /** i128 decimal string. */
    readonly amount_kg: string;
    /** 32-byte hex. */
    readonly loan_ref: string;
    readonly due_date: number;
    readonly grace_period_seconds: number;
    readonly expires_at: number;
  };
  /** "30000000000000" (30 TGas). */
  readonly gas: string;
  /** "1" (1 yoctoNEAR, requires wallet confirmation). */
  readonly deposit: string;
}

export interface SorobanPreparedLock {
  readonly kind: 'soroban_auth';
  /** The lender's SorobanAuthorizationEntry, unsigned, base64 XDR. */
  readonly lenderEntryXdr: string;
  /** Ledger until which the lender's signature must be valid. */
  readonly validUntilLedger: number;
  /** What the lender signs: sha256 of the entry's HashIdPreimage, hex. */
  readonly payloadHashHex: string;
}

export interface NearPreparedLock {
  readonly kind: 'near_offer';
  readonly txRequest: NearOfferTxRequest;
  readonly lenderEntryXdr?: undefined;
  readonly validUntilLedger?: undefined;
  readonly payloadHashHex?: undefined;
}

export type PreparedLock = SorobanPreparedLock | NearPreparedLock;

export type ChainTxStatus = 'signed' | 'submitted' | 'success' | 'failed' | 'expired';

export interface ChainTxOutcome {
  /** `chain_transactions.id`. */
  id: string;
  txHash: string;
  status: ChainTxStatus;
  /** Contract error code when the call failed in simulation or on-ledger. */
  contractError: number | null;
  /** The call's return value (base64 ScVal on Stellar; null on NEAR) on success. */
  returnValueXdr: string | null;
  /** Decoded return value (e.g. decimal string receipt_id for u64 returns, or null). */
  returnValue?: unknown;
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
  /** Pre-decoded event (name, fields, topics) produced by the chain adapter. */
  decoded: DecodedEvent;
  /** Raw XDR JSON or NEP-297 JSON line for audit log. */
  raw: string;
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
  // NEAR-specific contract error codes (70–77):
  Unauthorized: 70,
  PendingNotFound: 71,
  PendingExpired: 72,
  PendingExists: 73,
  TermsMismatch: 74,
  MintWindowTooLong: 75,
  InvalidSymbol: 76,
  Overflow: 77,
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

/** D31: the lender's authorisation or offer is missing, invalid, or for different terms. */
export class LenderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LenderAuthError';
  }
}
