import { createHash } from 'node:crypto';

import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  encodeTransaction,
  KeyType,
  PublicKey,
  Signature,
  SignedTransaction,
} from 'near-api-js';

import type { Queryable } from '../db/pool.js';
import type { LeafJson } from '../domain/merkle.js';
import type { KeyService } from '../keys/keyService.js';
import type { Logger } from '../logger.js';
import { addressFor, isValidAccount } from './addresses.js';
import {
  ContractCallError,
  ContractError,
  DeadlineError,
  LenderAuthError,
  type AnchorCall,
  type AnchorHead,
  type ChainClient,
  type ChainTxOutcome,
  type ChainTxStatus,
  type EventPage,
  type LockCall,
  type MintCall,
  type PreparedLock,
  type ReceiptState,
  type ReceiptStatus,
} from './chainClient.js';
import { fetchNearEvents } from './nearEvents.js';
import { nearLeafHash } from './nearLeaf.js';
import {
  HttpNearRpc,
  NearRpcError,
  parseNearContractError,
  type NearFunctionCallActionView,
  type NearRpc,
  type NearTxStatusResponse,
} from './nearRpc.js';

export { LenderAuthError };

export interface NearChainConfig {
  readonly rpcUrl: string;
  readonly networkId: string;
  readonly contractId: string;
  readonly operatorSubject: string;
  readonly operatorFundYocto?: bigint;
  readonly indexerUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly defaultMaxTimeSeconds?: number;
}

interface NearTxRow {
  id: string;
  tx_hash: string;
  envelope_xdr: string;
  max_time: Date;
  created_at: Date;
  status: ChainTxStatus;
  return_value_xdr: string | null;
  ledger: string | null;
  error: string | null;
}

const DEFAULT_GAS = 30_000_000_000_000n; // 30 TGas
const MINT_PROPOSE_GAS = 100_000_000_000_000n; // 100 TGas
const LENDER_OFFER_TTL_SECONDS = 86_400; // 24 hours
const NEAR_TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const EMPTY_CODE_HASH = '11111111111111111111111111111111';

export function loanRefToHex(loanRef: string): string {
  if (/^[0-9a-f]{64}$/i.test(loanRef)) return loanRef.toLowerCase();
  return createHash('sha256').update(loanRef, 'utf8').digest('hex');
}

/**
 * NEAR implementation of `ChainClient` (`CHAIN_BACKEND=near`).
 *
 * Preserves:
 * - D30: Every write transaction is Borsh-serialized, signed, and recorded in
 *   `chain_transactions` (`chain = 'near'`, `envelope_encoding = 'borsh_b64'`)
 *   BEFORE `broadcast_tx_async`. `resolve()` looks up `txStatus` first and only
 *   re-broadcasts the identical signed envelope.
 * - D31: We never hold or sign for a lender key. `prepareLock` returns a
 *   `NearOfferTxRequest` for the lender's wallet; `submitLock` verifies the
 *   lender's on-chain `lock_offer` transaction before signing `lock_accept`
 *   with `ownerSubject`.
 * - INV-1: `mintFromAnchor` enforces `notAfter` before Step 1 (`mint_propose`)
 *   and passes `not_after` to the contract so `mint_approve` cannot land after
 *   the deadline.
 */
export class NearChainClient implements ChainClient {
  readonly backend = 'near' as const;
  readonly enabled = true;
  readonly contractId: string;
  readonly networkId: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly capabilities = { ttl: false } as const;
  private readonly rpc: NearRpc;
  private readonly signerQueues = new Map<string, Promise<unknown>>();
  private readonly fundedAccounts = new Set<string>();

  constructor(
    private readonly config: NearChainConfig,
    private readonly keys: KeyService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
    rpc?: NearRpc,
  ) {
    this.contractId = config.contractId;
    this.networkId = config.networkId;
    this.networkPassphrase = config.networkId;
    this.rpcUrl = config.rpcUrl;
    this.rpc = rpc ?? new HttpNearRpc(config.rpcUrl);
  }

  validateAccount(address: string): boolean {
    return isValidAccount(address, 'near');
  }

  addressOf(subject: string): Promise<string> {
    return addressFor(this.keys, subject, 'near');
  }

  // --- reads -----------------------------------------------------------------

  async latestLedger(): Promise<{ sequence: number; closeTime: number }> {
    const status = await this.rpc.status();
    const closeTime = Math.floor(Date.parse(status.sync_info.latest_block_time) / 1000);
    return {
      sequence: status.sync_info.latest_block_height,
      closeTime,
    };
  }

  async instanceExists(): Promise<boolean> {
    const account = await this.rpc.viewAccount(this.contractId);
    return account !== null && account.code_hash !== EMPTY_CODE_HASH;
  }

  async getAnchor(warehouseSymbol: string): Promise<AnchorHead | null> {
    try {
      const res = await this.rpc.callFunction<{ day: number; head: string | number[] } | null>(
        this.contractId,
        'get_anchor',
        { warehouse_id: warehouseSymbol },
      );
      if (res === null) return null;
      const head =
        typeof res.head === 'string' ? Buffer.from(res.head, 'hex') : Buffer.from(res.head);
      return { day: res.day, head };
    } catch (err) {
      if (err instanceof NearRpcError) {
        if (err.code === ContractError.NoAnchor) return null;
        throw new ContractCallError('get_anchor', err.code, err.message);
      }
      throw err;
    }
  }

  async getReceipt(receiptId: bigint): Promise<ReceiptState | null> {
    try {
      const res = await this.rpc.callFunction<NearReceiptView | null>(
        this.contractId,
        'get_receipt',
        { receipt_id: receiptId.toString() },
      );
      if (res === null) return null;
      return decodeNearReceipt(res);
    } catch (err) {
      if (err instanceof NearRpcError) {
        if (err.code === 10) return null; // ReceiptNotFound
        throw new ContractCallError('get_receipt', err.code, err.message);
      }
      throw err;
    }
  }

  async lastReceiptId(): Promise<bigint> {
    const res = await this.rpc.callFunction<string | number | null>(
      this.contractId,
      'last_receipt_id',
      {},
    );
    if (res === null) return 0n;
    return BigInt(res);
  }

  async isClaimed(warehouseSymbol: string, depositNo: number): Promise<boolean> {
    return this.rpc.callFunction<boolean>(this.contractId, 'is_claimed', {
      warehouse_id: warehouseSymbol,
      deposit_no: depositNo.toString(),
    });
  }

  leafHash(leaf: LeafJson): Promise<Buffer> {
    return Promise.resolve(nearLeafHash(leaf));
  }

  receiptLiveUntil(receiptIds: readonly bigint[]): Promise<Map<string, number | null>> {
    return Promise.resolve(new Map(receiptIds.map((id) => [id.toString(), null])));
  }

  getEvents(range: { startLedger: number; endLedger?: number }): Promise<EventPage> {
    return fetchNearEvents(this.rpc, {
      contractId: this.contractId,
      ...(this.config.indexerUrl !== undefined ? { indexerUrl: this.config.indexerUrl } : {}),
      ...(this.config.fetchFn !== undefined ? { fetchFn: this.config.fetchFn } : {}),
      startLedger: range.startLedger,
      ...(range.endLedger !== undefined ? { endLedger: range.endLedger } : {}),
    });
  }

  // --- writes ----------------------------------------------------------------

  anchor(db: Queryable, call: AnchorCall): Promise<ChainTxOutcome> {
    return this.invokeSingle(db, {
      purpose: 'anchor',
      subject: call.subject,
      signerSubject: call.custodianSubject,
      method: 'anchor',
      args: {
        warehouse_id: call.warehouseSymbol,
        day: call.day,
        root: call.root.toString('hex'),
        leaves: call.leaves,
      },
      gas: DEFAULT_GAS,
    });
  }

  async mintFromAnchor(db: Queryable, call: MintCall): Promise<ChainTxOutcome> {
    const now = Math.floor(this.clock().getTime() / 1000);
    if (now >= call.notAfter) {
      throw new DeadlineError(call.notAfter);
    }

    const leafHashHex = nearLeafHash(call.leaf).toString('hex');
    const proposeOutcome = await this.invokeSingle(db, {
      purpose: 'mint_propose',
      subject: `${call.subject}:propose`,
      signerSubject: call.custodianSubject,
      method: 'mint_propose',
      args: {
        leaf: call.leaf,
        proof: call.proof.map((p) => p.toString('hex')),
        not_after: call.notAfter,
      },
      gas: MINT_PROPOSE_GAS,
      maxTimeSeconds: call.maxTimeSeconds,
      notAfter: call.notAfter,
    });

    if (proposeOutcome.status !== 'success') {
      return proposeOutcome;
    }

    return this.invokeSingle(db, {
      purpose: 'mint_approve',
      subject: call.subject,
      signerSubject: call.verifierSubject,
      method: 'mint_approve',
      args: {
        warehouse_id: call.leaf.warehouse_id,
        deposit_no: String(call.leaf.deposit_no),
        expected_leaf_hash: leafHashHex,
      },
      gas: DEFAULT_GAS,
      maxTimeSeconds: call.maxTimeSeconds,
      notAfter: call.notAfter,
    });
  }

  async prepareLock(call: LockCall): Promise<PreparedLock> {
    const receipt = await this.getReceipt(call.receiptId);
    if (receipt === null) {
      throw new ContractCallError('lock_offer', 10, 'E10:ReceiptNotFound');
    }
    if (receipt.owner === call.lender) {
      throw new ContractCallError(
        'lock_offer',
        ContractError.LenderIsOwner,
        'E36:LenderIsOwner',
      );
    }
    const expiresAt = Math.floor(this.clock().getTime() / 1000) + LENDER_OFFER_TTL_SECONDS;
    return {
      kind: 'near_offer',
      txRequest: {
        receiverId: this.contractId,
        methodName: 'lock_offer',
        args: {
          receipt_id: call.receiptId.toString(),
          amount_kg: call.kg.toString(),
          loan_ref: loanRefToHex(call.loanRef),
          due_date: call.dueDate,
          grace_period_seconds: call.gracePeriodSeconds,
          expires_at: expiresAt,
        },
        gas: DEFAULT_GAS.toString(),
        deposit: '1',
      },
    };
  }

  async submitLock(
    db: Queryable,
    call: LockCall,
    lenderOfferTxHash: string,
    ownerSubject: string,
    subject: string,
  ): Promise<ChainTxOutcome> {
    await this.verifyLenderOfferTx(lenderOfferTxHash, call);
    return this.invokeSingle(db, {
      purpose: 'lock_accept',
      subject,
      signerSubject: ownerSubject,
      method: 'lock_accept',
      args: {
        receipt_id: call.receiptId.toString(),
        lender: call.lender,
        expected_amount_kg: call.kg.toString(),
        expected_loan_ref: loanRefToHex(call.loanRef),
        expected_due_date: call.dueDate,
        expected_grace_period: call.gracePeriodSeconds,
      },
      gas: DEFAULT_GAS,
    });
  }

  extendTtlBatch(): Promise<ChainTxOutcome> {
    return Promise.resolve({
      id: '',
      txHash: '',
      status: 'success',
      contractError: null,
      returnValueXdr: null,
      returnValue: null,
      ledger: null,
      error: null,
    });
  }

  async resolve(db: Queryable, chainTransactionId: string): Promise<ChainTxOutcome> {
    const row = await this.loadTx(db, chainTransactionId);
    if (row.status === 'success' || row.status === 'failed' || row.status === 'expired') {
      return outcomeOf(row);
    }

    const signerId = decodeSignerId(row.envelope_xdr);
    const found = await this.rpc.txStatus(row.tx_hash, signerId);
    if (found !== null) {
      if (found.status.Failure !== undefined) {
        const errStr = failureString(found);
        const code = parseNearContractError(errStr);
        const settledStatus = code === ContractError.PendingExpired ? 'expired' : 'failed';
        return this.settle(db, row, settledStatus, {
          ledger: await this.outcomeBlockHeight(found),
          error: errStr,
        });
      }
      if (found.status.SuccessValue !== undefined) {
        const decodedVal = decodeSuccessValue(found.status.SuccessValue);
        return this.settle(db, row, 'success', {
          ledger: await this.outcomeBlockHeight(found),
          returnValueXdr: decodedVal,
        });
      }
    }

    const status = await this.rpc.status();
    const latestCloseTime = Math.floor(Date.parse(status.sync_info.latest_block_time) / 1000);
    const latestSeq = status.sync_info.latest_block_height;

    if (latestCloseTime > Math.floor(row.max_time.getTime() / 1000)) {
      const signedAt = Math.floor(row.created_at.getTime() / 1000);
      const earliestTimeStr = status.sync_info.earliest_block_time;
      const earliestCloseTime =
        earliestTimeStr !== undefined && earliestTimeStr !== null
          ? Math.floor(Date.parse(earliestTimeStr) / 1000)
          : 0;
      if (earliestCloseTime > signedAt) {
        this.logger.warn(
          { txHash: row.tx_hash, earliestBlock: status.sync_info.earliest_block_height },
          'NEAR transaction outcome undetermined: its blocks have left RPC retention',
        );
        return {
          ...outcomeOf(row),
          undetermined: {
            reason: 'outside_rpc_retention',
            closedAfterMaxTimeLedger: latestSeq,
          },
        };
      }
      return this.settle(db, row, 'expired', {
        error: `not on-chain and max_time ${row.max_time.toISOString()} has passed`,
      });
    }

    // D30: Re-broadcast the identical signed envelope (same nonce, same hash).
    await this.send(db, row);
    return outcomeOf(await this.loadTx(db, chainTransactionId));
  }

  // --- internals -------------------------------------------------------------

  private withSignerQueue<T>(signerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.signerQueues.get(signerId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.signerQueues.set(
      signerId,
      next.catch(() => undefined),
    );
    return next;
  }

  async fundSubject(
    subject: string,
  ): Promise<{ subject: string; accountId: string; funded: boolean }> {
    const accountId = await this.addressOf(subject);
    if (subject === this.config.operatorSubject) {
      return { subject, accountId, funded: false };
    }
    if (this.fundedAccounts.has(accountId)) {
      return { subject, accountId, funded: false };
    }
    const existing = await this.rpc.viewAccount(accountId);
    if (existing !== null) {
      this.fundedAccounts.add(accountId);
      return { subject, accountId, funded: false };
    }
    const fundAmount = this.config.operatorFundYocto ?? 0n;
    if (fundAmount <= 0n) {
      this.fundedAccounts.add(accountId);
      return { subject, accountId, funded: false };
    }

    let didFund = false;
    const operatorId = await this.addressOf(this.config.operatorSubject);
    await this.withSignerQueue(operatorId, async () => {
      const checkAgain = await this.rpc.viewAccount(accountId);
      if (checkAgain !== null) {
        this.fundedAccounts.add(accountId);
        return;
      }
      const pubHex = await this.keys.publicKey(this.config.operatorSubject);
      const pubKey = new PublicKey({
        keyType: KeyType.ED25519,
        data: Buffer.from(pubHex, 'hex'),
      });
      const [accessKey, status] = await Promise.all([
        this.rpc.viewAccessKey(operatorId, pubKey.toString()),
        this.rpc.status(),
      ]);
      const nonce = BigInt(accessKey.nonce) + 1n;
      const tx = createTransaction(
        operatorId,
        pubKey,
        accountId,
        nonce,
        [actions.transfer(fundAmount)],
        baseDecode(status.sync_info.latest_block_hash),
      );
      const txBytes = encodeTransaction(tx);
      const txHashBytes = createHash('sha256').update(txBytes).digest();
      const sigHex = await this.keys.sign(this.config.operatorSubject, txHashBytes, {
        purpose: 'near_tx:fund_implicit_account',
      });
      const signedTx = new SignedTransaction({
        transaction: tx,
        signature: new Signature({
          keyType: KeyType.ED25519,
          data: Buffer.from(sigHex, 'hex'),
        }),
      });
      const b64 = Buffer.from(signedTx.encode()).toString('base64');
      await this.rpc.sendTxAsync(b64);
      this.fundedAccounts.add(accountId);
      didFund = true;
    });
    return { subject, accountId, funded: didFund };
  }

  private async ensureFunded(subject: string, accountId: string): Promise<void> {
    if (this.fundedAccounts.has(accountId)) return;
    await this.fundSubject(subject);
  }

  private async invokeSingle(
    db: Queryable,
    request: {
      purpose: 'anchor' | 'mint_propose' | 'mint_approve' | 'lock_accept';
      subject: string;
      signerSubject: string;
      method: string;
      args: Record<string, unknown>;
      gas: bigint;
      deposit?: bigint;
      maxTimeSeconds?: number;
      notAfter?: number;
    },
  ): Promise<ChainTxOutcome> {
    const signerId = await this.addressOf(request.signerSubject);
    return this.withSignerQueue(signerId, async () => {
      const now = Math.floor(this.clock().getTime() / 1000);
      if (request.notAfter !== undefined && now >= request.notAfter) {
        throw new DeadlineError(request.notAfter);
      }

      await this.ensureFunded(request.signerSubject, signerId);

      const pubHex = await this.keys.publicKey(request.signerSubject);
      const pubKey = new PublicKey({
        keyType: KeyType.ED25519,
        data: Buffer.from(pubHex, 'hex'),
      });
      const [accessKey, status] = await Promise.all([
        this.rpc.viewAccessKey(signerId, pubKey.toString()),
        this.rpc.status(),
      ]);
      const nonce = BigInt(accessKey.nonce) + 1n;
      const latestSeq = status.sync_info.latest_block_height;
      const maxTime = Math.min(
        now + (request.maxTimeSeconds ?? this.config.defaultMaxTimeSeconds ?? 300),
        request.notAfter ?? Number.MAX_SAFE_INTEGER,
      );

      const tx = createTransaction(
        signerId,
        pubKey,
        this.contractId,
        nonce,
        [
          actions.functionCall(
            request.method,
            Buffer.from(JSON.stringify(request.args), 'utf8'),
            request.gas,
            request.deposit ?? 0n,
          ),
        ],
        baseDecode(status.sync_info.latest_block_hash),
      );
      const txBytes = encodeTransaction(tx);
      const txHashBytes = createHash('sha256').update(txBytes).digest();
      const txHash = baseEncode(txHashBytes);
      const sigHex = await this.keys.sign(request.signerSubject, txHashBytes, {
        purpose: `near_tx:${request.method}`,
      });
      const signedTx = new SignedTransaction({
        transaction: tx,
        signature: new Signature({
          keyType: KeyType.ED25519,
          data: Buffer.from(sigHex, 'hex'),
        }),
      });
      const envelopeB64 = Buffer.from(signedTx.encode()).toString('base64');

      // D30: Record BEFORE submission.
      const recorded = await db.query<{ id: string }>(
        `INSERT INTO chain_transactions (
           contract_id, chain, purpose, subject, tx_hash,
           envelope_xdr, envelope_encoding, signer_nonce,
           max_time, signed_after_ledger, created_at
         )
         VALUES ($1, 'near', $2, $3, $4, $5, 'borsh_b64', $6, to_timestamp($7), $8, to_timestamp($9))
         RETURNING id`,
        [
          this.contractId,
          request.purpose,
          request.subject,
          txHash,
          envelopeB64,
          nonce.toString(),
          maxTime,
          latestSeq,
          now,
        ],
      );
      const id = recorded.rows[0]?.id;
      if (id === undefined) throw new Error('chain transaction insert returned no id');

      if ((await this.send(db, await this.loadTx(db, id))) === 'rejected') {
        return outcomeOf(await this.loadTx(db, id));
      }
      return this.poll(db, id, signerId);
    });
  }

  private async send(db: Queryable, row: NearTxRow): Promise<'sent' | 'rejected' | 'unknown'> {
    try {
      await this.rpc.sendTxAsync(row.envelope_xdr);
    } catch (err) {
      if (err instanceof NearRpcError && /InvalidTxError|Expired|InvalidNonce/i.test(err.message)) {
        const reason = `rejected: ${err.message}`;
        await db.query(
          `UPDATE chain_transactions SET error = $2 WHERE id = $1 AND status IN ('signed', 'submitted')`,
          [row.id, reason],
        );
        this.logger.warn(
          { txHash: row.tx_hash, reason },
          'NEAR broadcast rejected; resolve() decides after max_time',
        );
        return 'rejected';
      }
      this.logger.warn(
        { err, txHash: row.tx_hash },
        'NEAR sendTxAsync failed; will resolve by hash',
      );
      return 'unknown';
    }
    await db.query(
      `UPDATE chain_transactions SET status = 'submitted', submitted_at = now()
        WHERE id = $1 AND status = 'signed'`,
      [row.id],
    );
    return 'sent';
  }

  private async poll(db: Queryable, id: string, signerId: string): Promise<ChainTxOutcome> {
    const deadline = Date.now() + (this.config.pollTimeoutMs ?? 60_000);
    const intervalMs = this.config.pollIntervalMs ?? 1_500;
    for (;;) {
      const row = await this.loadTx(db, id);
      if (row.status === 'success' || row.status === 'failed' || row.status === 'expired') {
        return outcomeOf(row);
      }
      const found = await this.rpc.txStatus(row.tx_hash, signerId);
      if (found !== null) {
        if (found.status.Failure !== undefined) {
          const errStr = failureString(found);
          const code = parseNearContractError(errStr);
          const settledStatus = code === ContractError.PendingExpired ? 'expired' : 'failed';
          return this.settle(db, row, settledStatus, {
            ledger: await this.outcomeBlockHeight(found),
            error: errStr,
          });
        }
        if (found.status.SuccessValue !== undefined) {
          return this.settle(db, row, 'success', {
            ledger: await this.outcomeBlockHeight(found),
            returnValueXdr: decodeSuccessValue(found.status.SuccessValue),
          });
        }
      }
      if (Date.now() > deadline) return outcomeOf(row);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private async verifyLenderOfferTx(lenderOfferTxHash: string, call: LockCall): Promise<void> {
    if (!NEAR_TX_HASH_RE.test(lenderOfferTxHash)) {
      throw new LenderAuthError('lender_offer_tx_hash is not a valid Base58 NEAR transaction hash');
    }
    const tx = await this.rpc.txStatus(lenderOfferTxHash, call.lender);
    if (tx === null) {
      throw new LenderAuthError('the lender lock_offer transaction was not found on-chain');
    }
    if (tx.status.Failure !== undefined || tx.status.SuccessValue === undefined) {
      throw new LenderAuthError('the lender lock_offer transaction failed on-chain');
    }
    if (tx.transaction.signer_id !== call.lender) {
      throw new LenderAuthError('the lock_offer transaction was not signed by the pledge lender');
    }
    if (tx.transaction.receiver_id !== this.contractId) {
      throw new LenderAuthError('the lock_offer transaction is for a different contract');
    }
    if (tx.transaction.actions.length !== 1) {
      throw new LenderAuthError('the lock_offer transaction must contain exactly one action');
    }
    const action = tx.transaction.actions[0] as Partial<NearFunctionCallActionView> | undefined;
    const fn = action?.FunctionCall;
    if (
      fn === undefined ||
      (fn.method_name !== 'lock_offer' && fn.method_name !== 'offer_lock')
    ) {
      throw new LenderAuthError('the lender transaction is not a lock_offer call');
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(Buffer.from(fn.args, 'base64').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new LenderAuthError('the lock_offer arguments are not valid JSON');
    }
    const scalarStr = (v: unknown): string =>
      typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    const givenReceiptId = scalarStr(args.receipt_id);
    const givenKg = scalarStr(args.amount_kg ?? args.kg);
    const givenLoanRef = scalarStr(args.loan_ref);
    const givenDueDate = Number(args.due_date ?? -1);
    const givenGrace = Number(args.grace_period_seconds ?? args.grace_period ?? -1);
    const expectedLoanRefHex = loanRefToHex(call.loanRef);

    if (
      givenReceiptId !== call.receiptId.toString() ||
      givenKg !== call.kg.toString() ||
      (givenLoanRef !== expectedLoanRefHex && givenLoanRef !== call.loanRef) ||
      givenDueDate !== call.dueDate ||
      givenGrace !== call.gracePeriodSeconds
    ) {
      throw new LenderAuthError('the lock_offer transaction terms do not match this pledge');
    }
  }

  private async outcomeBlockHeight(found: NearTxStatusResponse): Promise<number> {
    const blockHash =
      found.receipts_outcome.at(-1)?.block_hash ?? found.transaction_outcome.block_hash;
    if (blockHash !== undefined) {
      try {
        const blk = await this.rpc.block({ blockId: blockHash });
        return blk.header.height;
      } catch {
        // Fall through to status height if block lookup is unavailable in a stub.
      }
    }
    const status = await this.rpc.status();
    return status.sync_info.latest_block_height;
  }

  private async settle(
    db: Queryable,
    row: NearTxRow,
    status: 'success' | 'failed' | 'expired',
    result: { ledger?: number; returnValueXdr?: string | null; error?: string },
  ): Promise<ChainTxOutcome> {
    await db.query(
      `UPDATE chain_transactions
          SET status = $2, ledger = $3, return_value_xdr = $4, error = $5, resolved_at = now()
        WHERE id = $1 AND status IN ('signed', 'submitted')`,
      [row.id, status, result.ledger ?? null, result.returnValueXdr ?? null, result.error ?? null],
    );
    return outcomeOf(await this.loadTx(db, row.id));
  }

  private async loadTx(db: Queryable, id: string): Promise<NearTxRow> {
    const { rows } = await db.query<NearTxRow>(
      `SELECT id, tx_hash, envelope_xdr, max_time, created_at, status, return_value_xdr, ledger,
              error
         FROM chain_transactions WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`chain transaction ${id} not found`);
    return row;
  }
}

interface NearReceiptView {
  receipt_id: string | number;
  parent_id?: string | number | null;
  status: ReceiptStatus | [ReceiptStatus];
  weight_kg: string | number;
  bag_count: number;
  owner: string;
  warehouse_id: string;
  deposit_no: string | number;
  deposit_id: string;
  weight_source: 'Scale' | 'BagEstimate' | ['Scale' | 'BagEstimate'];
  lender?: string | null;
  lock?: { lender: string } | ['None'] | ['Some', { lender: string }] | null;
}

function decodeNearReceipt(r: NearReceiptView): ReceiptState {
  const status = Array.isArray(r.status) ? r.status[0] : r.status;
  const weightSource = Array.isArray(r.weight_source) ? r.weight_source[0] : r.weight_source;
  let lender: string | null = r.lender ?? null;
  if (lender === null && r.lock !== undefined && r.lock !== null) {
    if (Array.isArray(r.lock)) {
      lender = r.lock[0] === 'Some' ? r.lock[1].lender : null;
    } else if (typeof r.lock === 'object' && 'lender' in r.lock) {
      lender = r.lock.lender;
    }
  }
  return {
    receiptId: BigInt(r.receipt_id),
    parentId: r.parent_id === undefined || r.parent_id === null ? null : BigInt(r.parent_id),
    status,
    weightKg: BigInt(r.weight_kg),
    bagCount: r.bag_count,
    owner: r.owner,
    warehouseSymbol: r.warehouse_id,
    depositNo: BigInt(r.deposit_no),
    depositId: r.deposit_id,
    weightSource,
    lender,
  };
}

function decodeSignerId(envelopeB64: string): string {
  const bytes = Buffer.from(envelopeB64, 'base64');
  const signed = SignedTransaction.decode(bytes);
  return signed.transaction.signerId;
}

function decodeSuccessValue(b64: string): string | null {
  if (b64.length === 0) return null;
  const text = Buffer.from(b64, 'base64').toString('utf8').trim();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || parsed === undefined) return null;
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  } catch {
    return text;
  }
}

function failureString(found: NearTxStatusResponse): string {
  const raw = JSON.stringify(found.status.Failure);
  const code = parseNearContractError(raw);
  return `failed on-chain${code !== null ? `: E${code}` : ''}: ${raw}`;
}

function outcomeOf(row: NearTxRow): ChainTxOutcome {
  const contractError =
    (row.status === 'failed' || row.status === 'expired') && row.error !== null
      ? parseNearContractError(row.error)
      : null;
  return {
    id: row.id,
    txHash: row.tx_hash,
    status: row.status,
    contractError,
    returnValueXdr: row.return_value_xdr,
    returnValue: row.return_value_xdr,
    ledger: row.ledger === null ? null : Number(row.ledger),
    error: row.error,
  };
}
