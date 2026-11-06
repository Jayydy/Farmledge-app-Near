import { createHash } from 'node:crypto';

import {
  Address,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

import type { Queryable } from '../db/pool.js';
import type { KeyService } from '../keys/keyService.js';
import type { Logger } from '../logger.js';
import { leafScVal, type LeafJson } from '../domain/merkle.js';
import {
  ContractCallError,
  DeadlineError,
  EVENT_TOPICS,
  type AnchorCall,
  type AnchorHead,
  type ChainClient,
  type ChainEvent,
  type ChainTxOutcome,
  type ChainTxStatus,
  type DecodedEvent,
  type EventJson,
  type EventPage,
  type LockCall,
  type MintCall,
  type PreparedLock,
  type ReceiptState,
  type ReceiptStatus,
} from './chainClient.js';

export interface SorobanChainConfig {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly contractId: string;
  /** Key-service subject of the account that submits and pays for transactions. */
  readonly operatorSubject: string;
  /** How long to poll a submitted transaction before leaving it to `resolve`. */
  readonly pollTimeoutMs?: number;
  /** Default upper time bound on every transaction. */
  readonly defaultMaxTimeSeconds?: number;
}

/** The RPC calls this client makes; injectable so the settling rules can be tested offline. */
export type RpcServer = Pick<
  rpc.Server,
  | 'getAccount'
  | 'getEvents'
  | 'getLatestLedger'
  | 'getLedgerEntries'
  | 'getTransaction'
  | 'sendTransaction'
  | 'simulateTransaction'
>;

interface TxRow {
  id: string;
  tx_hash: string;
  envelope_xdr: string;
  max_time: Date;
  /** When it was signed and recorded: it cannot be in any ledger before this. */
  created_at: Date;
  status: ChainTxStatus;
  return_value_xdr: string | null;
  ledger: string | null;
  error: string | null;
}

/** Ledgers a signed authorisation stays valid (about 10 minutes at 5 s per ledger). */
const AUTH_VALIDITY_LEDGERS = 120;
/** A lender gets about a day to sign and return their authorisation. */
const LENDER_AUTH_VALIDITY_LEDGERS = 17_280;
const POLL_INTERVAL_MS = 2_000;

const contractErrorCode = (text: string): number | null => {
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  return match ? Number(match[1]) : null;
};

/**
 * CHAIN_ENABLED=true. Talks to the receipt contract through Soroban RPC.
 * See ChainClient for the recording and signing rules this implements.
 */
export class SorobanChainClient implements ChainClient {
  readonly backend = 'stellar' as const;
  readonly enabled = true;
  readonly contractId: string;
  readonly networkId: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly capabilities = { ttl: true } as const;
  private readonly server: RpcServer;
  private readonly contract: Contract;
  /** One submission at a time from the operator account, so sequence numbers never collide. */
  private submitting: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: SorobanChainConfig,
    private readonly keys: KeyService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
    server?: RpcServer,
  ) {
    this.contractId = config.contractId;
    this.networkId = config.networkPassphrase;
    this.networkPassphrase = config.networkPassphrase;
    this.rpcUrl = config.rpcUrl;
    this.server =
      server ??
      new rpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith('http://'),
      });
    this.contract = new Contract(config.contractId);
  }

  validateAccount(address: string): boolean {
    return StrKey.isValidEd25519PublicKey(address);
  }

  async addressOf(subject: string): Promise<string> {
    const hex = await this.keys.publicKey(subject);
    return StrKey.encodeEd25519PublicKey(Buffer.from(hex, 'hex'));
  }

  // --- reads -----------------------------------------------------------------

  async latestLedger(): Promise<{ sequence: number; closeTime: number }> {
    const latest = await this.server.getLatestLedger();
    return { sequence: latest.sequence, closeTime: Number(latest.closeTime) };
  }

  async instanceExists(): Promise<boolean> {
    const found = await this.server.getLedgerEntries(this.contract.getFootprint());
    return found.entries.length > 0;
  }

  async getAnchor(warehouseSymbol: string): Promise<AnchorHead | null> {
    const result = await this.read('get_anchor', [xdr.ScVal.scvSymbol(warehouseSymbol)]);
    if (result.kind === 'error') {
      if (result.code === 53) return null; // NoAnchor
      throw new ContractCallError('get_anchor', result.code, result.message);
    }
    const native = scValToNative(result.value) as { day: number | bigint; head: Buffer };
    return { day: Number(native.day), head: Buffer.from(native.head) };
  }

  async lastReceiptId(): Promise<bigint> {
    const found = await this.server.getLedgerEntries(this.contract.getFootprint());
    const entry = found.entries[0];
    if (entry === undefined) throw new Error(`contract instance ${this.contractId} not found`);
    // DataKey::NextReceiptId, a unit enum variant: Vec[Symbol("NextReceiptId")].
    const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('NextReceiptId')]).toXdr('base64');
    if (
      entry.val.type !== 'contractData' ||
      entry.val.contractData.val.type !== 'scvContractInstance'
    ) {
      throw new Error(`contract ${this.contractId}: the instance entry is not a contract instance`);
    }
    const storage = entry.val.contractData.val.instance.storage ?? [];
    const hit = storage.find((e) => e.key.toXdr('base64') === key);
    return hit === undefined ? 0n : BigInt(scValToNative(hit.val) as bigint | number);
  }

  async getReceipt(receiptId: bigint): Promise<ReceiptState | null> {
    const result = await this.read('get_receipt', [nativeToScVal(receiptId, { type: 'u64' })]);
    if (result.kind === 'error') {
      if (result.code === 10) return null; // ReceiptNotFound
      throw new ContractCallError('get_receipt', result.code, result.message);
    }
    return decodeReceipt(result.value);
  }

  async isClaimed(warehouseSymbol: string, depositNo: number): Promise<boolean> {
    const result = await this.read('is_claimed', [
      xdr.ScVal.scvSymbol(warehouseSymbol),
      nativeToScVal(BigInt(depositNo), { type: 'u64' }),
    ]);
    if (result.kind === 'error') {
      throw new ContractCallError('is_claimed', result.code, result.message);
    }
    return scValToNative(result.value) === true;
  }

  async leafHash(leaf: LeafJson): Promise<Buffer> {
    const result = await this.read('leaf_hash', [leafScVal(leaf)]);
    if (result.kind === 'error') {
      throw new ContractCallError('leaf_hash', result.code, result.message);
    }
    return Buffer.from(scValToNative(result.value) as Buffer);
  }

  async receiptLiveUntil(receiptIds: readonly bigint[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const instanceKey = this.contract.getFootprint().toXdr('base64');
    for (const id of receiptIds) {
      const tx = await this.buildTx('get_receipt', [nativeToScVal(id, { type: 'u64' })]);
      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        out.set(id.toString(), null);
        continue;
      }
      const keys = sim.transactionData
        .build()
        .resources.footprint.readOnly.filter(
          (key) =>
            key.type === 'contractData' &&
            key.contractData.durability.name === 'persistent' &&
            key.toXdr('base64') !== instanceKey,
        );
      if (keys.length === 0) {
        out.set(id.toString(), null);
        continue;
      }
      const entries = await this.server.getLedgerEntries(...keys);
      const lives = entries.entries
        .map((entry) => entry.liveUntilLedgerSeq)
        .filter((seq): seq is number => typeof seq === 'number');
      out.set(id.toString(), lives.length === 0 ? null : Math.min(...lives));
    }
    return out;
  }

  async getEvents(range: { startLedger: number; endLedger?: number }): Promise<EventPage> {
    const limit = 1_000;
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [this.contractId] }];
    const response = await this.server.getEvents({
      startLedger: range.startLedger,
      ...(range.endLedger === undefined ? {} : { endLedger: range.endLedger }),
      filters,
      limit,
    });
    const events = response.events.map((event): ChainEvent => {
      const suffix = event.id.split('-')[1] ?? '0';
      const topicXdr = event.topic.map((topic) => topic.toXdr('base64'));
      const valueXdr = event.value.toXdr('base64');
      return {
        id: event.id,
        contractId: event.contractId?.contractId() ?? this.contractId,
        ledger: event.ledger,
        ledgerClosedAt: event.ledgerClosedAt,
        txHash: event.txHash,
        txIndex: event.transactionIndex,
        opIndex: event.operationIndex,
        eventIndex: Number(suffix),
        inSuccessfulContractCall: event.inSuccessfulContractCall,
        topicXdr,
        valueXdr,
        decoded: decodeSorobanEvent(topicXdr, valueXdr),
        raw: JSON.stringify({ topicXdr, valueXdr }),
      };
    });
    // endLedger is exclusive. A full page may stop inside a ledger, so only
    // the ledgers before the last event's are known to be complete.
    const bound =
      range.endLedger === undefined
        ? response.latestLedger
        : Math.min(range.endLedger - 1, response.latestLedger);
    const last = events.at(-1);
    const coveredThrough =
      events.length < limit || last === undefined ? bound : Math.min(bound, last.ledger - 1);
    return {
      events,
      latestLedger: response.latestLedger,
      oldestLedger: response.oldestLedger,
      coveredThrough,
      cursor: response.cursor,
    };
  }

  // --- writes ----------------------------------------------------------------

  anchor(db: Queryable, call: AnchorCall): Promise<ChainTxOutcome> {
    return this.invoke(db, {
      purpose: 'anchor',
      subject: call.subject,
      method: 'anchor',
      signers: [call.custodianSubject],
      args: async () => [
        Address.fromString(await this.addressOf(call.custodianSubject)).toScVal(),
        xdr.ScVal.scvSymbol(call.warehouseSymbol),
        xdr.ScVal.scvU32(call.day),
        xdr.ScVal.scvBytes(call.root),
        xdr.ScVal.scvU32(call.leaves),
      ],
    });
  }

  mintFromAnchor(db: Queryable, call: MintCall): Promise<ChainTxOutcome> {
    return this.invoke(db, {
      purpose: 'mint',
      subject: call.subject,
      method: 'mint_from_anchor',
      signers: [call.custodianSubject, call.verifierSubject],
      maxTimeSeconds: call.maxTimeSeconds,
      notAfter: call.notAfter,
      args: async () => [
        Address.fromString(await this.addressOf(call.custodianSubject)).toScVal(),
        Address.fromString(await this.addressOf(call.verifierSubject)).toScVal(),
        leafScVal(call.leaf),
        xdr.ScVal.scvVec(call.proof.map((p) => xdr.ScVal.scvBytes(p))),
      ],
    });
  }

  extendTtlBatch(db: Queryable, receiptIds: readonly bigint[]): Promise<ChainTxOutcome> {
    return this.invoke(db, {
      purpose: 'extend_ttl_batch',
      subject: `keepalive:${receiptIds.join(',')}`,
      method: 'extend_ttl_batch',
      signers: [],
      args: () =>
        Promise.resolve([
          xdr.ScVal.scvVec(receiptIds.map((id) => nativeToScVal(id, { type: 'u64' }))),
        ]),
    });
  }

  async prepareLock(call: LockCall): Promise<PreparedLock> {
    const tx = await this.buildTx('lock', lockArgs(call));
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new ContractCallError('lock', contractErrorCode(sim.error), sim.error);
    }
    const entry = (sim.result?.auth ?? []).find((e) => entryAddress(e) === call.lender);
    if (entry === undefined) throw new Error('simulation did not ask the lender to authorise');
    const latest = await this.server.getLatestLedger();
    const validUntilLedger = latest.sequence + LENDER_AUTH_VALIDITY_LEDGERS;
    // Handed out as simulation returned it; the lender's own authorizeEntry
    // sets the expiration to validUntilLedger when it signs.
    return {
      kind: 'soroban_auth',
      lenderEntryXdr: entry.toXdr('base64'),
      validUntilLedger,
      payloadHashHex: createHash('sha256')
        .update(
          buildAuthorizationEntryPreimage(entry, validUntilLedger, this.networkPassphrase).toXdr(),
        )
        .digest('hex'),
    };
  }

  async submitLock(
    db: Queryable,
    call: LockCall,
    signedLenderEntryXdr: string,
    ownerSubject: string,
    subject: string,
  ): Promise<ChainTxOutcome> {
    const lenderEntry = xdr.SorobanAuthorizationEntry.fromXdr(signedLenderEntryXdr, 'base64');
    // D31: the lender's authorisation must arrive signed by the lender, for
    // exactly this lock. We never sign it, and never fall back to signing it.
    verifyLenderEntry(lenderEntry, call, this.contractId, this.networkPassphrase);
    return this.invoke(db, {
      purpose: 'lock',
      subject,
      method: 'lock',
      signers: [ownerSubject],
      args: () => Promise.resolve(lockArgs(call)),
      presigned: [lenderEntry],
    });
  }

  async resolve(db: Queryable, chainTransactionId: string): Promise<ChainTxOutcome> {
    const row = await this.loadTx(db, chainTransactionId);
    if (row.status === 'success' || row.status === 'failed' || row.status === 'expired') {
      return outcomeOf(row);
    }
    const found = await this.server.getTransaction(row.tx_hash);
    if (found.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return this.settle(db, row, 'success', {
        ledger: found.ledger,
        returnValueXdr: found.returnValue?.toXdr('base64') ?? null,
      });
    }
    if (found.status === rpc.Api.GetTransactionStatus.FAILED) {
      return this.settle(db, row, 'failed', {
        ledger: found.ledger,
        error: failureText(found),
      });
    }
    // Not found. Once a ledger has closed after max_time it can never land,
    // but "not found" proves it never did only if RPC still holds every
    // ledger it could have landed in: those closed between its signing and
    // its max_time. RPC keeps a limited window; after a long outage the
    // window may start later, and a mint that landed would read as absent.
    const latest = await this.latestLedger();
    if (latest.closeTime > Math.floor(row.max_time.getTime() / 1000)) {
      const signedAt = Math.floor(row.created_at.getTime() / 1000);
      if (found.oldestLedgerCloseTime > signedAt) {
        this.logger.warn(
          { txHash: row.tx_hash, oldestLedger: found.oldestLedger },
          'transaction outcome undetermined: its ledgers have left RPC retention',
        );
        return {
          ...outcomeOf(row),
          undetermined: {
            reason: 'outside_rpc_retention',
            closedAfterMaxTimeLedger: latest.sequence,
          },
        };
      }
      return this.settle(db, row, 'expired', {
        error: `not in the ledger and max_time ${row.max_time.toISOString()} has passed`,
      });
    }
    // It could still land. Sending the very same signed envelope again is
    // safe (same hash, same sequence number): it lands once or not at all.
    await this.send(db, row);
    return outcomeOf(await this.loadTx(db, chainTransactionId));
  }

  // --- internals -------------------------------------------------------------

  private async read(
    method: string,
    args: xdr.ScVal[],
  ): Promise<
    { kind: 'ok'; value: xdr.ScVal } | { kind: 'error'; code: number | null; message: string }
  > {
    const tx = await this.buildTx(method, args);
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return { kind: 'error', code: contractErrorCode(sim.error), message: sim.error };
    }
    const value = sim.result?.retval;
    if (value === undefined) return { kind: 'error', code: null, message: `${method}: no result` };
    return { kind: 'ok', value };
  }

  private async buildTx(
    method: string,
    args: xdr.ScVal[],
    maxTimeSeconds?: number,
    auth?: xdr.SorobanAuthorizationEntry[],
  ): Promise<Transaction> {
    const operator = await this.addressOf(this.config.operatorSubject);
    const account = await this.server.getAccount(operator);
    const op =
      auth === undefined
        ? this.contract.call(method, ...args)
        : Operation.invokeHostFunction({
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(this.contractId).toScAddress(),
                functionName: method,
                args,
              }),
            ),
            auth,
          });
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    }).addOperation(op);
    if (maxTimeSeconds === undefined) builder.setTimeout(300);
    else builder.setTimebounds(0, maxTimeSeconds);
    return builder.build();
  }

  /**
   * Build → simulate → sign the named subjects' auth entries → re-simulate
   * with signatures → sign the envelope → RECORD → submit → poll.
   */
  private async invoke(
    db: Queryable,
    request: {
      purpose: 'anchor' | 'mint' | 'lock' | 'extend_ttl_batch';
      subject: string;
      method: string;
      signers: readonly string[];
      args: () => Promise<xdr.ScVal[]>;
      maxTimeSeconds?: number;
      /** Absolute deadline (Unix seconds): nothing is built after it, and max_time never exceeds it. */
      notAfter?: number;
      presigned?: xdr.SorobanAuthorizationEntry[];
    },
  ): Promise<ChainTxOutcome> {
    const run = async (): Promise<ChainTxOutcome> => {
      // Checked when this call's turn comes, not when it was queued: a call
      // that waited past its deadline is refused before anything is signed.
      const now = Math.floor(this.clock().getTime() / 1000);
      if (request.notAfter !== undefined && now >= request.notAfter) {
        throw new DeadlineError(request.notAfter);
      }
      const args = await request.args();
      const maxTime = Math.min(
        now + (request.maxTimeSeconds ?? this.config.defaultMaxTimeSeconds ?? 300),
        request.notAfter ?? Number.MAX_SAFE_INTEGER,
      );

      const first = await this.server.simulateTransaction(
        await this.buildTx(request.method, args, maxTime),
      );
      if (rpc.Api.isSimulationError(first)) {
        throw new ContractCallError(request.method, contractErrorCode(first.error), first.error);
      }
      const latest = await this.server.getLatestLedger();
      const signerAddresses = new Map<string, string>();
      for (const subject of request.signers) {
        signerAddresses.set(await this.addressOf(subject), subject);
      }
      const presigned = new Map(
        (request.presigned ?? []).map((entry) => [entryAddress(entry), entry]),
      );
      const auth: xdr.SorobanAuthorizationEntry[] = [];
      for (const entry of first.result?.auth ?? []) {
        if (getAddressCredentials(entry.credentials) === null) {
          // Authorised by the operator's envelope signature. The operator
          // is never a lender, custodian, verifier or owner (D31).
          auth.push(entry);
          continue;
        }
        const address = entryAddress(entry);
        const given = presigned.get(address);
        if (given !== undefined) {
          auth.push(given);
          continue;
        }
        const subject = signerAddresses.get(address);
        if (subject === undefined) {
          // Only named subjects are signed for; anyone else must presign.
          throw new Error(
            `${request.method} needs authorisation from ${address}, which this call may not sign for`,
          );
        }
        auth.push(
          await authorizeEntry(
            entry,
            async (_preimage, payload) => ({
              signature: Buffer.from(
                await this.keys.sign(subject, Buffer.from(payload), {
                  purpose: `soroban_auth:${request.method}`,
                }),
                'hex',
              ),
              publicKey: address,
            }),
            latest.sequence + AUTH_VALIDITY_LEDGERS,
            this.networkPassphrase,
          ),
        );
      }

      const signedTx = await this.buildTx(request.method, args, maxTime, auth);
      const second = await this.server.simulateTransaction(signedTx);
      if (rpc.Api.isSimulationError(second)) {
        throw new ContractCallError(request.method, contractErrorCode(second.error), second.error);
      }
      const assembled = rpc.assembleTransaction(signedTx, second).build();
      const operator = await this.addressOf(this.config.operatorSubject);
      const txHash = Buffer.from(assembled.hash());
      const signature = await this.keys.sign(this.config.operatorSubject, txHash, {
        purpose: `soroban_tx:${request.method}`,
      });
      assembled.addSignature(operator, Buffer.from(signature, 'hex').toString('base64'));

      // Recorded BEFORE submission: from here on, the hash is how we find out.
      const recorded = await db.query<{ id: string }>(
        `INSERT INTO chain_transactions (contract_id, purpose, subject, tx_hash, envelope_xdr,
                                         max_time, signed_after_ledger)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6), $7) RETURNING id`,
        [
          this.contractId,
          request.purpose,
          request.subject,
          txHash.toString('hex'),
          assembled.toEnvelope().toXdr('base64'),
          maxTime,
          // Read before signing: the transaction can only land after it.
          latest.sequence,
        ],
      );
      const id = recorded.rows[0]?.id;
      if (id === undefined) throw new Error('chain transaction insert returned no id');
      if ((await this.send(db, await this.loadTx(db, id))) === 'rejected') {
        // Not accepted: nothing to poll for. resolve() settles it once max_time passes.
        return outcomeOf(await this.loadTx(db, id));
      }
      return this.poll(db, id);
    };
    const next = this.submitting.then(run, run);
    this.submitting = next.catch(() => undefined);
    return next;
  }

  /**
   * Sends the recorded envelope. A rejection is never settled as a failure
   * here: an earlier send of the same envelope may have landed already
   * (and not be visible to RPC yet), or may still land, so a rejection of
   * this copy proves nothing about the transaction. Only resolve(), once a
   * ledger has closed after max_time, may call it failed.
   */
  private async send(db: Queryable, row: TxRow): Promise<'sent' | 'rejected' | 'unknown'> {
    const tx = TransactionBuilder.fromXdr(row.envelope_xdr, this.networkPassphrase);
    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.server.sendTransaction(tx);
    } catch (err) {
      // Unknown whether it arrived: leave it for resolve(), which looks first.
      this.logger.warn(
        { err, txHash: row.tx_hash },
        'sendTransaction failed; will resolve by hash',
      );
      return 'unknown';
    }
    if (sent.status === 'ERROR') {
      const reason = `rejected: ${sent.errorResult?.result.type ?? 'unknown'}`;
      await db.query(
        `UPDATE chain_transactions SET error = $2 WHERE id = $1 AND status IN ('signed', 'submitted')`,
        [row.id, reason],
      );
      this.logger.warn(
        { txHash: row.tx_hash, reason },
        'send rejected; resolve() decides after max_time',
      );
      return 'rejected';
    }
    if (sent.status === 'TRY_AGAIN_LATER') return 'unknown';
    await db.query(
      `UPDATE chain_transactions SET status = 'submitted', submitted_at = now()
       WHERE id = $1 AND status = 'signed'`,
      [row.id],
    );
    return 'sent';
  }

  private async poll(db: Queryable, id: string): Promise<ChainTxOutcome> {
    const deadline = Date.now() + (this.config.pollTimeoutMs ?? 60_000);
    for (;;) {
      const row = await this.loadTx(db, id);
      if (row.status === 'success' || row.status === 'failed' || row.status === 'expired') {
        return outcomeOf(row);
      }
      const found = await this.server.getTransaction(row.tx_hash);
      if (found.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return this.settle(db, row, 'success', {
          ledger: found.ledger,
          returnValueXdr: found.returnValue?.toXdr('base64') ?? null,
        });
      }
      if (found.status === rpc.Api.GetTransactionStatus.FAILED) {
        return this.settle(db, row, 'failed', { ledger: found.ledger, error: failureText(found) });
      }
      if (Date.now() > deadline) return outcomeOf(row);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private async settle(
    db: Queryable,
    row: TxRow,
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

  private async loadTx(db: Queryable, id: string): Promise<TxRow> {
    const { rows } = await db.query<TxRow>(
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

function lockArgs(call: LockCall): xdr.ScVal[] {
  return [
    nativeToScVal(call.receiptId, { type: 'u64' }),
    Address.fromString(call.lender).toScVal(),
    nativeToScVal(call.kg, { type: 'u64' }),
    xdr.ScVal.scvString(call.loanRef),
    nativeToScVal(BigInt(call.dueDate), { type: 'u64' }),
    nativeToScVal(BigInt(call.gracePeriodSeconds), { type: 'u64' }),
  ];
}

/** The address credentials of any credential variant (v1, v2, with delegates); null for source-account. */
function getAddressCredentials(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | null {
  switch (credentials.type) {
    case 'sorobanCredentialsAddress':
      return credentials.address;
    case 'sorobanCredentialsAddressV2':
      return credentials.addressV2;
    case 'sorobanCredentialsAddressWithDelegates':
      return credentials.addressWithDelegates.addressCredentials;
    default:
      return null;
  }
}

function addressCredentials(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const credentials = getAddressCredentials(entry.credentials);
  if (credentials === null) throw new Error(`unsupported credentials ${entry.credentials.type}`);
  return credentials;
}

function entryAddress(entry: xdr.SorobanAuthorizationEntry): string {
  const credentials = getAddressCredentials(entry.credentials);
  return credentials === null ? '' : Address.fromScAddress(credentials.address).toString();
}

/** sha256 of the HashIdPreimage an address-credential entry's signature covers. */
export function authPayloadHash(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): Buffer {
  const credentials = addressCredentials(entry);
  const preimage = buildAuthorizationEntryPreimage(
    entry,
    credentials.signatureExpirationLedger,
    networkPassphrase,
  );
  return createHash('sha256').update(preimage.toXdr()).digest();
}

/**
 * D31: refuses a lender authorisation unless it is for this exact lock on
 * this contract, from this lender, and carries a valid signature by the
 * lender's own key.
 */
export function verifyLenderEntry(
  entry: xdr.SorobanAuthorizationEntry,
  call: LockCall,
  contractId: string,
  networkPassphrase: string,
): void {
  if (entryAddress(entry) !== call.lender) {
    throw new LenderAuthError('the authorisation is not from the pledge lender');
  }
  const fn = entry.rootInvocation.function;
  if (fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new LenderAuthError('the authorisation is not for a contract call');
  }
  const invoke = fn.contractFn;
  const target = Address.fromScAddress(invoke.contractAddress).toString();
  const expected = lockArgs(call).map((arg) => arg.toXdr('base64'));
  const given = invoke.args.map((arg) => arg.toXdr('base64'));
  if (
    target !== contractId ||
    invoke.functionName.toString() !== 'lock' ||
    entry.rootInvocation.subInvocations.length > 0 ||
    expected.length !== given.length ||
    expected.some((arg, i) => arg !== given[i])
  ) {
    throw new LenderAuthError('the authorisation is for a different call than this pledge');
  }
  const signatures = scValToNative(addressCredentials(entry).signature) as
    { public_key: Buffer; signature: Buffer }[] | undefined;
  const payload = authPayloadHash(entry, networkPassphrase);
  const lenderKey = Keypair.fromPublicKey(call.lender);
  const valid =
    Array.isArray(signatures) &&
    signatures.length > 0 &&
    signatures.every(
      (sig) =>
        Buffer.from(sig.public_key).equals(lenderKey.rawPublicKey()) &&
        lenderKey.verify(payload, Buffer.from(sig.signature)),
    );
  if (!valid) throw new LenderAuthError('the authorisation is not signed by the lender');
}

export class LenderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LenderAuthError';
  }
}

function decodeReceipt(value: xdr.ScVal): ReceiptState {
  const r = scValToNative(value) as {
    receipt_id: bigint | number;
    parent_id?: bigint | number | null;
    status: [ReceiptStatus];
    weight_kg: bigint | number;
    bag_count: number | bigint;
    owner: string;
    warehouse_id: string;
    deposit_no: bigint | number;
    deposit_id: string;
    weight_source: ['Scale' | 'BagEstimate'];
    lock: ['None'] | ['Some', { lender: string }];
  };
  return {
    receiptId: BigInt(r.receipt_id),
    parentId: r.parent_id === undefined || r.parent_id === null ? null : BigInt(r.parent_id),
    status: r.status[0],
    weightKg: BigInt(r.weight_kg),
    bagCount: Number(r.bag_count),
    owner: r.owner,
    warehouseSymbol: r.warehouse_id,
    depositNo: BigInt(r.deposit_no),
    depositId: r.deposit_id,
    weightSource: r.weight_source[0],
    lender: r.lock[0] === 'Some' ? r.lock[1].lender : null,
  };
}

function failureText(found: rpc.Api.GetFailedTransactionResponse): string {
  const events = found.diagnosticEventsXdr ?? [];
  const decoded = events
    .map((event) => {
      try {
        return String(scValToNative(event.event.body.v0.data));
      } catch {
        return '';
      }
    })
    .join(' ');
  const code = /#(\d+)/.exec(decoded);
  return `failed on-ledger${code ? `: Error(Contract, #${code[1]})` : ''} (${events.length} diagnostic events)`;
}

function outcomeOf(row: TxRow): ChainTxOutcome {
  return {
    id: row.id,
    txHash: row.tx_hash,
    status: row.status,
    // Only a settled failure carries a contract error; a rejected copy proves nothing.
    contractError:
      row.status === 'failed' && row.error !== null ? contractErrorCode(row.error) : null,
    returnValueXdr: row.return_value_xdr,
    returnValue: decodeSorobanReturnValue(row.return_value_xdr),
    ledger: row.ledger === null ? null : Number(row.ledger),
    error: row.error,
  };
}

/** A native ScVal value as JSON: u64 and i128 as decimal strings, bytes as hex. */
function toEventJson(value: unknown): EventJson {
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toEventJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toEventJson(v)]));
  }
  return value as EventJson;
}

export function decodeSorobanEvent(topicXdr: readonly string[], valueXdr: string): DecodedEvent {
  const topics = topicXdr.map((t) => toEventJson(scValToNative(xdr.ScVal.fromXdr(t, 'base64'))));
  const name = typeof topics[0] === 'string' ? topics[0] : JSON.stringify(topics[0]);
  const data = toEventJson(scValToNative(xdr.ScVal.fromXdr(valueXdr, 'base64')));
  const fields: Record<string, EventJson> =
    typeof data === 'object' && data !== null && !Array.isArray(data) ? { ...data } : {};
  (EVENT_TOPICS[name] ?? []).forEach((field, i) => {
    fields[field] = topics[i + 1] ?? null;
  });
  return { name, fields, topics };
}

export function decodeSorobanReturnValue(returnValueXdr: string | null): unknown {
  if (returnValueXdr === null) return null;
  try {
    return toEventJson(scValToNative(xdr.ScVal.fromXdr(returnValueXdr, 'base64')));
  } catch {
    return null;
  }
}
