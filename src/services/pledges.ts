import { scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';
import type pg from 'pg';

import { addressFor, OPERATOR_SUBJECT, subjectOf } from '../chain/addresses.js';
import {
  ContractCallError,
  ContractError,
  DeadlineError,
  type ChainClient,
  type ChainTxOutcome,
  type LockCall,
} from '../chain/chainClient.js';
import { LenderAuthError } from '../chain/sorobanChainClient.js';
import type { FarmerConfirmation } from '../confirmation/farmerConfirmation.js';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { cutoffOf, warehouseSymbol } from '../domain/book.js';
import { domainError, type DomainError } from '../domain/errors.js';
import type { LeafJson } from '../domain/merkle.js';
import { assertPledgeable } from '../domain/weightPolicy.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import type { KeyService } from '../keys/keyService.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alerts.js';
import {
  chainHalted,
  ensurePreclaimGate,
  preclaimGateOpen,
  verifyGateWithoutPredecessor,
} from './chainDeployment.js';
import { findHoles } from './indexer.js';
import { checkReferences } from './references.js';

/** INV-1: a mint transaction can never land later than this after it is signed. */
export const MINT_MAX_TIME_SECONDS = 300;
/**
 * How long POST /pledges waits for the mint before answering 202 `minting`
 * ("unknown, still resolving"): well under common client and proxy
 * timeouts (30–60 s), so the caller hears that the outcome is unknown
 * instead of timing out and taking silence for failure.
 */
export const PLEDGE_RESPONSE_BUDGET_MS = 20_000;
/** Requests from before mint deadlines were stored: unrecorded after this long, never submitted. */
const LEGACY_UNSUBMITTED_AFTER_MS = (MINT_MAX_TIME_SECONDS + 60) * 1000;

export interface PledgeInput {
  /**
   * Client-generated idempotency key. A retry with the same id, after a
   * timeout or a lost response, returns that pledge's current state
   * instead of refusing the lot as already pledged.
   */
  readonly pledgeId?: string | undefined;
  readonly depositId: string;
  /** The lender's own Stellar account (`G…`). We never hold its key. */
  readonly lender: string;
  /** Whole kg to pledge; at most what the lot's anchored balance leaf holds. */
  readonly kg: number;
  /** The lender's opaque reference, ≤ 64 bytes, never personal data (it is public). */
  readonly loanRef: string;
  readonly dueDate: Date;
  readonly gracePeriodSeconds: number;
  /** The custodian who co-signs the mint. */
  readonly requestedBy: string;
  /** The verifier who co-signs the mint. */
  readonly verifierId: string;
  readonly farmerConfirmed: boolean;
}

export interface PledgeView {
  pledge_id: string;
  deposit_id: string;
  deposit_no: number;
  status: 'minting' | 'awaiting_lender_signature' | 'locking' | 'locked' | 'failed';
  lender: string;
  kg: number;
  loan_ref: string;
  due_date: Date;
  grace_period_seconds: number;
  receipt_id: string | null;
  locked_receipt_id: string | null;
  /**
   * What the lender must sign and return (step 2): the unsigned
   * SorobanAuthorizationEntry, as base64 XDR, and the ledger it is valid to.
   */
  lender_authorization: { entry_xdr: string; valid_until_ledger: number } | null;
  failure: string | null;
  /** Why it failed, machine-readable: e.g. `books_not_anchored`. */
  failure_code: string | null;
}

interface PledgeRow {
  id: string;
  deposit_id: string;
  deposit_no: string;
  warehouse_id: string;
  farmer_id: string;
  status: PledgeView['status'];
  lender_address: string;
  kg: string;
  loan_ref: string;
  due_date: Date;
  grace_period_seconds: string;
  receipt_id: string | null;
  locked_receipt_id: string | null;
  lender_auth_entry_xdr: string | null;
  lender_auth_valid_until_ledger: string | null;
  failure: string | null;
  failure_code: string | null;
}

const PLEDGE_SELECT = `
  SELECT p.id, p.deposit_id, d.deposit_no, p.warehouse_id, d.farmer_id, p.status,
         p.lender_address, p.kg, p.loan_ref, p.due_date, p.grace_period_seconds, p.receipt_id,
         p.locked_receipt_id, p.lender_auth_entry_xdr, p.lender_auth_valid_until_ledger, p.failure,
         p.failure_code
    FROM pledges p JOIN deposits d ON d.deposit_id = p.deposit_id`;

function toView(row: PledgeRow): PledgeView {
  return {
    pledge_id: row.id,
    deposit_id: row.deposit_id,
    deposit_no: Number(row.deposit_no),
    status: row.status,
    lender: row.lender_address,
    kg: Number(row.kg),
    loan_ref: row.loan_ref,
    due_date: row.due_date,
    grace_period_seconds: Number(row.grace_period_seconds),
    receipt_id: row.receipt_id,
    locked_receipt_id: row.locked_receipt_id,
    lender_authorization:
      row.status === 'awaiting_lender_signature' && row.lender_auth_entry_xdr !== null
        ? {
            entry_xdr: row.lender_auth_entry_xdr,
            valid_until_ledger: Number(row.lender_auth_valid_until_ledger),
          }
        : null,
    failure: row.failure,
    failure_code: row.failure_code,
  };
}

/**
 * Pledging a lot (backend-requirements §5; storage-strategy "The freshness
 * invariant"). Backend-enforced invariants here, which the contract cannot
 * check and nothing else stands behind:
 *
 * - INV-1 freshness: the lot is frozen, in a committed transaction, before
 *   anything is signed; minting is refused if any movement of the lot was
 *   recorded after the cutoff of the anchored day the mint uses; the freeze
 *   is lifted only on a definite failure (FAILED, never submitted, or
 *   max_time passed with RPC confirming absence). Once minted, the freeze is
 *   never lifted: it becomes INV-6, enforced by the database.
 * - INV-2 pre-claim gate: checked before freezing.
 * - D31 lender keys: we never hold one. The lock is two-step: we build it and
 *   return the lender's unsigned authorisation; the lender signs and returns
 *   it. No code path signs for the lender, as a fallback or otherwise: the
 *   key service holds no lender subject, and a lender address that is any
 *   key we manage is refused outright.
 *
 * Contract-enforced, so not re-implemented here: only balance leaves of the
 * latest anchored day mint (A5, A6 on-chain), one mint per (warehouse,
 * deposit_no) ever (A1), receipt fields come only from the leaf (A8),
 * Scale-only locks, lender ≠ owner.
 */
export class PledgeService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: ChainClient,
    private readonly keys: KeyService,
    private readonly confirmation: FarmerConfirmation,
    private readonly alerts: AlertService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
    private readonly responseBudgetMs: number = PLEDGE_RESPONSE_BUDGET_MS,
  ) {}

  /**
   * Step 1: freeze, mint from the lot's balance leaf in the warehouse's
   * latest anchored day, and prepare the lock for the lender to sign.
   */
  async pledge(input: PledgeInput): Promise<PledgeView> {
    const depositId = input.depositId.toLowerCase();
    const pledgeId = input.pledgeId?.toLowerCase();
    if (pledgeId !== undefined) {
      const replay = await this.replay(pledgeId, depositId);
      if (replay !== null) return replay;
    }
    const errors = validatePledge(input, this.clock());
    if (errors.length > 0) throw new ValidationError('Pledge is invalid', { details: errors });
    if (!this.chain.enabled) {
      throw new ConflictError('CHAIN_ENABLED=false: pledges need the receipt contract', {
        code: 'chain_disabled',
      });
    }
    if (await chainHalted(this.pool)) {
      throw new ConflictError('Chain writers are halted: a Testnet reset is unresolved', {
        code: 'chain_halted',
      });
    }

    const lot = await this.loadLot(this.pool, depositId);
    if (lot === null) throw new NotFoundError('Deposit not found');
    const referenceErrors = await checkReferences(this.pool, {
      warehouse: { id: lot.warehouse_id, field: 'warehouse_id', mustBeActive: true },
      custodian: { id: input.requestedBy.toLowerCase(), field: 'requested_by' },
      verifier: { id: input.verifierId.toLowerCase(), field: 'verifier_id' },
    });
    if (referenceErrors.length > 0) {
      throw new ValidationError('Pledge is invalid', { details: referenceErrors });
    }
    // D31: a lender is never one of our own keys.
    if (await this.isManagedAddress(input.lender)) {
      throw new ValidationError('Pledge is invalid', {
        details: [
          domainError(
            'invalid_lender',
            'lender',
            'The lender must be the lender’s own account, never a key Farmledge holds',
          ),
        ],
      });
    }
    const pledgeable = assertPledgeable({
      weightSource: lot.weight_source,
      bagCount: lot.bag_count,
      bagsWeighed: lot.bags_weighed,
    });
    if (!pledgeable.ok)
      throw new ValidationError('Pledge is invalid', { details: pledgeable.errors });

    // INV-2: the pre-claim gate.
    await ensurePreclaimGate(this.pool, this.chain.contractId, lot.warehouse_id);
    const gateProblems = await verifyGateWithoutPredecessor(
      this.pool,
      this.chain,
      lot.warehouse_id,
      this.clock(),
    );
    const gate = await preclaimGateOpen(this.pool, this.chain.contractId, lot.warehouse_id);
    if (!gate.open) {
      throw new ConflictError(`No mint for this warehouse yet: ${gate.reason}`, {
        code: 'preclaim_gate_closed',
        ...(gateProblems.length > 0 ? { details: gateProblems } : {}),
      });
    }

    // The leaf must come from the warehouse's latest anchored day, here and
    // on-chain (A6; the contract would refuse it with StaleLeaf anyway).
    const symbol = warehouseSymbol(lot.warehouse_code);
    const latest = await this.latestAnchoredDay(lot.warehouse_id);
    const onChain = await this.chain.getAnchor(symbol);
    if (latest === null || onChain === null || onChain.day !== latest) {
      throw booksNotAnchored(symbol, latest, onChain === null ? 'missing' : 'stale');
    }
    const leaf = await this.balanceLeaf(depositId, latest);
    if (leaf === null) {
      throw new ConflictError(
        `Lot ${lot.deposit_no} has no balance in the anchored day ${latest}`,
        {
          code: 'lot_not_in_anchored_books',
        },
      );
    }
    if (leaf.json.weight_source !== 'Scale') {
      throw new ValidationError('Pledge is invalid', {
        details: [
          domainError('invalid_kg', 'weight_source', 'The anchored balance is a bag estimate'),
        ],
      });
    }
    if (input.kg > leaf.json.kg) {
      throw new ValidationError('Pledge is invalid', {
        details: [
          domainError(
            'invalid_pledge_kg',
            'kg',
            `The lot's anchored balance is ${leaf.json.kg} kg`,
          ),
        ],
      });
    }

    // INV-1, step 1: freeze before anything is signed, in one transaction.
    // The mint's deadline is fixed here, so a call that waits in the
    // submission queue cannot carry a later max_time than this.
    const notAfter = Math.floor(this.clock().getTime() / 1000) + MINT_MAX_TIME_SECONDS;
    let frozen: { pledgeId: string; mintId: string };
    try {
      frozen = await withTransaction(this.pool, async (client) => {
        const locked = await client.query<{ frozen_for_mint: string | null; status: string }>(
          'SELECT frozen_for_mint, status FROM deposits WHERE deposit_id = $1 FOR UPDATE',
          [depositId],
        );
        const row = locked.rows[0];
        if (row === undefined) throw new NotFoundError('Deposit not found');
        if (row.frozen_for_mint !== null || row.status === 'minted') {
          // Name the live pledge, so a caller that lost a response can follow it.
          const live = await client.query<{ pledge_id: string | null }>(
            `SELECT pledge_id FROM mint_requests WHERE deposit_id = $1
              AND status IN ('pending', 'submitted', 'minted') ORDER BY created_at DESC LIMIT 1`,
            [depositId],
          );
          throw new ConflictError('This lot is already pledged or being pledged', {
            code: 'lot_already_pledged',
            details: { pledge_id: live.rows[0]?.pledge_id ?? null },
          });
        }
        // Any movement recorded at or after the anchored day's cutoff makes its
        // balance leaf stale: the mint must wait for the next anchor.
        const since = await client.query(
          'SELECT 1 FROM lot_movements WHERE deposit_id = $1 AND recorded_at >= $2 LIMIT 1',
          [depositId, cutoffOf(latest)],
        );
        if ((since.rowCount ?? 0) > 0) throw booksNotAnchored(symbol, latest, 'moved_since_anchor');

        const newPledgeId = pledgeId ?? crypto.randomUUID();
        const confirmation = await this.confirmation.request(client, {
          farmerId: lot.farmer_id,
          action: 'lock',
          subjectId: newPledgeId,
          farmerConfirmed: input.farmerConfirmed,
        });
        if (confirmation.status !== 'approved') {
          throw new ConflictError('The farmer has not approved this pledge', {
            code: 'farmer_not_confirmed',
          });
        }
        await client.query(
          `INSERT INTO pledges (id, deposit_id, warehouse_id, lender_address, kg, loan_ref, due_date,
                              grace_period_seconds, requested_by, verifier_id, confirmation_id,
                              status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'minting')`,
          [
            newPledgeId,
            depositId,
            lot.warehouse_id,
            input.lender,
            input.kg,
            input.loanRef,
            input.dueDate,
            input.gracePeriodSeconds,
            input.requestedBy.toLowerCase(),
            input.verifierId.toLowerCase(),
            confirmation.id,
          ],
        );
        const mint = await client.query<{ id: string }>(
          `INSERT INTO mint_requests (pledge_id, deposit_id, warehouse_id, anchor_day, book_entry_id,
                                    status, max_time)
         VALUES ($1, $2, $3, $4, $5, 'pending', to_timestamp($6)) RETURNING id`,
          [newPledgeId, depositId, lot.warehouse_id, latest, leaf.id, notAfter],
        );
        const mintId = mint.rows[0]?.id;
        if (mintId === undefined) throw new Error('mint request insert returned no id');
        await client.query('UPDATE deposits SET frozen_for_mint = $2 WHERE deposit_id = $1', [
          depositId,
          mintId,
        ]);
        return { pledgeId: newPledgeId, mintId };
      });
    } catch (err) {
      // The same pledge_id racing itself: the lot is frozen by this very pledge.
      const live = (err as { details?: { pledge_id?: string | null } }).details?.pledge_id;
      if (
        pledgeId !== undefined &&
        err instanceof ConflictError &&
        err.code === 'lot_already_pledged' &&
        live === pledgeId
      ) {
        return this.get(pledgeId);
      }
      throw err;
    }
    // Only now, with the freeze committed, is the mint transaction built.
    const minting = this.submitMint(frozen, leaf, input, notAfter);
    // Answer within the budget either way. Past it the outcome is unknown,
    // not failed: 202 `minting`, settled later by the running mint or by
    // resolve-pending, and followed with GET /pledges/:id.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => {
        resolve('pending');
      }, this.responseBudgetMs);
    });
    try {
      const first = await Promise.race([minting, budget]);
      if (first !== 'pending') return first;
    } finally {
      clearTimeout(timer);
    }
    minting.catch((err: unknown) => {
      this.logger.warn({ err, pledgeId: frozen.pledgeId }, 'mint settled after the response');
    });
    return this.get(frozen.pledgeId);
  }

  /** Submits and settles the frozen mint; resolves with the pledge, or throws the refusal to report. */
  private async submitMint(
    frozen: { pledgeId: string; mintId: string },
    leaf: { json: LeafJson; proof: Buffer[] },
    input: PledgeInput,
    notAfter: number,
  ): Promise<PledgeView> {
    let outcome: ChainTxOutcome;
    try {
      outcome = await this.chain.mintFromAnchor(this.pool, {
        custodianSubject: subjectOf.custodian(input.requestedBy.toLowerCase()),
        verifierSubject: subjectOf.verifier(input.verifierId.toLowerCase()),
        leaf: leaf.json,
        proof: leaf.proof,
        subject: `mint:${frozen.mintId}`,
        maxTimeSeconds: MINT_MAX_TIME_SECONDS,
        notAfter,
      });
    } catch (err) {
      // Refused in simulation: nothing was signed into a recorded
      // transaction, so nothing can land. A definite failure.
      const recorded = await this.recordedMintTx(this.pool, frozen.mintId);
      if (recorded === null) {
        const cause = err instanceof ContractCallError ? anchorCause(err.contractError) : null;
        if (cause !== null) {
          const refused = await this.booksNotAnchoredFor(frozen.mintId, cause);
          await this.failMint(frozen.mintId, refused.message, 'books_not_anchored');
          throw refused;
        }
        await this.failMint(frozen.mintId, errText(err));
        if (err instanceof DeadlineError) {
          throw new ConflictError('The mint could not be submitted in time; try again', {
            code: 'mint_deadline_passed',
          });
        }
        if (
          err instanceof ContractCallError &&
          err.contractError === ContractError.DuplicateDepositId
        ) {
          throw new ConflictError('This lot has already been minted on-chain', {
            code: 'lot_already_pledged',
          });
        }
        if (err instanceof ContractCallError) {
          throw new ConflictError(`The contract refused the mint: ${err.message}`, {
            code: 'contract_refused',
            details: { contract_error: err.contractError },
          });
        }
      }
      throw err;
    }
    await this.settleMint(frozen.mintId, outcome);
    const settled = await this.get(frozen.pledgeId);
    if (settled.failure_code === 'books_not_anchored' && outcome.status === 'failed') {
      // Refused on-ledger rather than in simulation: reported the same way.
      throw await this.booksNotAnchoredFor(
        frozen.mintId,
        anchorCause(outcome.contractError) ?? 'stale',
      );
    }
    return settled;
  }

  /**
   * Step 2: the lender's signed authorisation. Verified as the lender's own
   * signature over exactly this lock, then submitted with the owner's.
   */
  async submitLenderSignature(pledgeId: string, signedEntryXdr: string): Promise<PledgeView> {
    const row = await this.find(this.pool, pledgeId);
    if (row === null) throw new NotFoundError('Pledge not found');
    if (row.status !== 'awaiting_lender_signature' || row.receipt_id === null) {
      throw new ConflictError(`This pledge is ${row.status}`, {
        code: 'pledge_not_awaiting_lender',
      });
    }
    if (await chainHalted(this.pool)) {
      throw new ConflictError('Chain writers are halted: a Testnet reset is unresolved', {
        code: 'chain_halted',
      });
    }
    await this.pool.query(`UPDATE pledges SET status = 'locking' WHERE id = $1`, [pledgeId]);
    let outcome: ChainTxOutcome;
    try {
      outcome = await this.chain.submitLock(
        this.pool,
        lockCallOf(row),
        signedEntryXdr,
        subjectOf.farmer(row.farmer_id),
        `lock:${pledgeId}`,
      );
    } catch (err) {
      await this.pool.query(
        `UPDATE pledges SET status = 'awaiting_lender_signature', failure = $2 WHERE id = $1`,
        [pledgeId, errText(err)],
      );
      if (err instanceof LenderAuthError) {
        throw new ValidationError('Lender signature is invalid', {
          details: [domainError('invalid_lender', 'signed_entry_xdr', err.message)],
        });
      }
      throw err;
    }
    if (outcome.status === 'success') {
      const lockedId = decodeU64(outcome.returnValueXdr);
      await this.pool.query(
        `UPDATE pledges SET status = 'locked', locked_receipt_id = $2, failure = NULL WHERE id = $1`,
        [pledgeId, lockedId],
      );
    } else if (outcome.status === 'failed' || outcome.status === 'expired') {
      await this.pool.query(
        `UPDATE pledges SET status = 'awaiting_lender_signature', failure = $2 WHERE id = $1`,
        [pledgeId, outcome.error ?? outcome.status],
      );
    }
    return this.get(pledgeId);
  }

  /**
   * After a crash or a timeout: resolve every pending mint before dispatch
   * reopens for its lot. No recorded transaction (and older than any mint
   * could still be in flight): nothing was submitted, so unfreeze. A recorded
   * one is looked up; it is completed if it succeeded, unfrozen only once it
   * failed or its max_time passed unconfirmed. Never while it could land.
   */
  async resolvePending(): Promise<void> {
    const { rows } = await this.pool.query<{
      id: string;
      created_at: Date;
      max_time: Date | null;
    }>(
      `SELECT id, created_at, max_time FROM mint_requests WHERE status IN ('pending', 'submitted')`,
    );
    for (const row of rows) {
      const tx = await this.recordedMintTx(this.pool, row.id);
      if (tx === null) {
        // INV-1: unrecorded is not the same as unsubmittable. A call may still
        // be waiting in the submission queue. It can never carry a max_time
        // past the request's deadline, so only once a ledger has closed after
        // that deadline can nothing land.
        if (row.max_time === null) {
          if (this.clock().getTime() - row.created_at.getTime() > LEGACY_UNSUBMITTED_AFTER_MS) {
            await this.failMint(row.id, 'never submitted');
          }
        } else if (
          (await this.chain.latestLedger()).closeTime > Math.floor(row.max_time.getTime() / 1000)
        ) {
          await this.failMint(row.id, 'never submitted before its deadline');
        }
        continue;
      }
      await this.settleMint(row.id, await this.chain.resolve(this.pool, tx));
    }
  }

  async get(pledgeId: string): Promise<PledgeView> {
    const row = await this.find(this.pool, pledgeId);
    if (row === null) throw new NotFoundError('Pledge not found');
    return toView(row);
  }

  // --- internals -------------------------------------------------------------

  private async settleMint(mintId: string, outcome: ChainTxOutcome): Promise<void> {
    if (outcome.undetermined !== undefined) {
      await this.settleFromArchive(mintId, outcome);
      return;
    }
    await this.pool.query(
      `UPDATE mint_requests SET chain_transaction_id = $2,
              status = CASE WHEN status = 'pending' THEN 'submitted' ELSE status END
        WHERE id = $1 AND status IN ('pending', 'submitted')`,
      [mintId, outcome.id],
    );
    if (outcome.status === 'success') {
      const receiptId = decodeU64(outcome.returnValueXdr);
      const pledge = await withTransaction(this.pool, async (client) => {
        const mint = await client.query<{ deposit_id: string; pledge_id: string }>(
          `UPDATE mint_requests SET status = 'minted', receipt_id = $2, resolved_at = now()
            WHERE id = $1 AND status IN ('pending', 'submitted')
          RETURNING deposit_id, pledge_id`,
          [mintId, receiptId],
        );
        const m = mint.rows[0];
        if (m === undefined) return null;
        // INV-6 from here on: the database keeps the lot frozen forever.
        await client.query(
          `UPDATE deposits SET status = 'minted', chain_receipt_id = $2 WHERE deposit_id = $1`,
          [m.deposit_id, receiptId],
        );
        await client.query(`UPDATE pledges SET receipt_id = $2 WHERE id = $1`, [
          m.pledge_id,
          receiptId,
        ]);
        return m.pledge_id;
      });
      if (pledge !== null) await this.prepareLock(pledge);
      return;
    }
    if (outcome.status === 'failed' || outcome.status === 'expired') {
      const cause = outcome.status === 'failed' ? anchorCause(outcome.contractError) : null;
      if (cause !== null) {
        // StaleLeaf / NoAnchor on-ledger (or found by resolve-pending): the
        // same specific cause as a refusal in simulation, never a generic failure.
        const refused = await this.booksNotAnchoredFor(mintId, cause);
        await this.failMint(mintId, refused.message, 'books_not_anchored');
      } else {
        await this.failMint(mintId, outcome.error ?? outcome.status);
      }
    }
    // signed / submitted: it could still land. Stay frozen.
  }

  private async prepareLock(pledgeId: string): Promise<void> {
    const row = await this.find(this.pool, pledgeId);
    if (row === null || row.receipt_id === null) return;
    try {
      const prepared = await this.chain.prepareLock(lockCallOf(row));
      await this.pool.query(
        `UPDATE pledges SET status = 'awaiting_lender_signature', lender_auth_entry_xdr = $2,
                lender_auth_valid_until_ledger = $3
          WHERE id = $1 AND status = 'minting'`,
        [pledgeId, prepared.lenderEntryXdr, prepared.validUntilLedger],
      );
    } catch (err) {
      await this.pool.query(
        `UPDATE pledges SET status = 'awaiting_lender_signature', failure = $2 WHERE id = $1`,
        [pledgeId, `the lock could not be prepared: ${errText(err)}`],
      );
    }
  }

  /**
   * INV-1, when RPC can no longer say whether the mint landed (its ledgers
   * left RPC's retention window). The event archive decides instead:
   * - a `minted` event for this lot (each lot mints once, ever) means it
   *   landed: settle it as minted, with that receipt;
   * - the archive covering every ledger the mint could be in, with no hole
   *   (INV-8), from the ledger before it was signed through one that closed
   *   after max_time, and holding no such event, means it never landed: a
   *   definite failure. A cursor past max_time is not enough on its own:
   *   a hole below the cursor could be exactly where the mint landed;
   * - otherwise nothing is known yet: stay frozen and page urgently.
   */
  private async settleFromArchive(mintId: string, outcome: ChainTxOutcome): Promise<void> {
    const contractId = this.chain.contractId;
    const { rows } = await this.pool.query<{
      code: string;
      deposit_no: string;
      cursor: string | null;
      start_ledger: string | null;
      signed_after_ledger: string | null;
    }>(
      `SELECT w.code, d.deposit_no, ic.cursor_ledger AS cursor, ic.start_ledger,
              (SELECT signed_after_ledger FROM chain_transactions WHERE id = $3) AS signed_after_ledger
         FROM mint_requests m
         JOIN deposits d ON d.deposit_id = m.deposit_id
         JOIN warehouses w ON w.id = d.warehouse_id
         LEFT JOIN indexer_cursors ic ON ic.contract_id = $2
        WHERE m.id = $1`,
      [mintId, contractId, outcome.id],
    );
    const row = rows[0];
    if (row === undefined) return;
    // The archive stores the warehouse as its on-chain Symbol.
    const symbol = warehouseSymbol(row.code);
    const minted = await this.pool.query<{ receipt_id: string; ledger: string }>(
      `SELECT value->>'receipt_id' AS receipt_id, ledger FROM events_archive
        WHERE contract_id = $1 AND event_type = 'minted' AND in_successful_contract_call
          AND value->>'warehouse_id' = $2 AND value->>'deposit_no' = $3
        ORDER BY ledger LIMIT 1`,
      [contractId, symbol, row.deposit_no],
    );
    const event = minted.rows[0];
    const undetermined = outcome.undetermined;
    if (undetermined === undefined) return;
    if (event !== undefined) {
      await this.pool.query(
        `UPDATE chain_transactions SET status = 'success', ledger = $2, resolved_at = now(),
                error = 'settled from the event archive: outside RPC retention'
          WHERE id = $1 AND status IN ('signed', 'submitted')`,
        [outcome.id, event.ledger],
      );
      await this.settleMint(mintId, {
        id: outcome.id,
        txHash: outcome.txHash,
        status: 'success',
        contractError: null,
        returnValueXdr: nativeU64Xdr(event.receipt_id),
        ledger: Number(event.ledger),
        error: null,
      });
      await this.alerts.resolve(`mint_undetermined:${mintId}`);
      return;
    }
    // INV-8 gap state over every ledger the mint could have landed in.
    const from = Number(row.signed_after_ledger ?? row.start_ledger ?? 0);
    const to = undetermined.closedAfterMaxTimeLedger;
    const ranges = await this.pool.query<{ from_ledger: string; to_ledger: string }>(
      `SELECT from_ledger, to_ledger FROM indexed_ranges
        WHERE contract_id = $1 AND to_ledger >= $2 AND from_ledger <= $3`,
      [contractId, from, to],
    );
    const holes = findHoles(
      ranges.rows.map((r): [number, number] => [Number(r.from_ledger), Number(r.to_ledger)]),
      from,
      to,
    );
    if (row.cursor !== null && Number(row.cursor) >= to && holes.length === 0) {
      await this.pool.query(
        `UPDATE chain_transactions SET status = 'expired', resolved_at = now(),
                error = 'no minted event in the archive through a ledger after max_time'
          WHERE id = $1 AND status IN ('signed', 'submitted')`,
        [outcome.id],
      );
      await this.failMint(mintId, 'not minted: the archive shows no mint through max_time');
      await this.alerts.resolve(`mint_undetermined:${mintId}`);
      return;
    }
    await this.alerts.raise({
      key: `mint_undetermined:${mintId}`,
      severity: 'urgent',
      category: 'pledges',
      message:
        `Mint ${mintId} (lot ${row.deposit_no} at ${symbol}) may or may not have landed: RPC no longer ` +
        'holds its ledgers and the archive does not yet cover them all without a gap. The lot stays frozen.',
      details: {
        mint_id: mintId,
        archive_cursor: row.cursor,
        needs_cursor: undetermined.closedAfterMaxTimeLedger,
        archive_holes: holes,
      },
    });
  }

  /** An earlier POST with this pledge_id: its current state, or a 409 if the id names another lot. */
  private async replay(pledgeId: string, depositId: string): Promise<PledgeView | null> {
    const row = await this.find(this.pool, pledgeId);
    if (row === null) return null;
    if (row.deposit_id !== depositId) {
      throw new ConflictError('This pledge_id was already used for a different lot', {
        code: 'pledge_id_conflict',
      });
    }
    return toView(row);
  }

  /** A definite failure: the request fails, the pledge fails, the lot is unfrozen. */
  private async failMint(mintId: string, reason: string, code?: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const failed = await client.query<{ deposit_id: string; pledge_id: string | null }>(
        `UPDATE mint_requests SET status = 'failed', failure = $2, resolved_at = now()
          WHERE id = $1 AND status IN ('pending', 'submitted')
        RETURNING deposit_id, pledge_id`,
        [mintId, reason],
      );
      const row = failed.rows[0];
      if (row === undefined) return;
      await client.query(
        `UPDATE deposits SET frozen_for_mint = NULL WHERE deposit_id = $1 AND frozen_for_mint = $2`,
        [row.deposit_id, mintId],
      );
      if (row.pledge_id !== null) {
        await client.query(
          `UPDATE pledges SET status = 'failed', failure = $2, failure_code = $3 WHERE id = $1`,
          [row.pledge_id, reason, code ?? null],
        );
      }
    });
    this.logger.warn({ mintId, reason }, 'mint failed; lot unfrozen');
  }

  private async recordedMintTx(db: Queryable, mintId: string): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM chain_transactions WHERE subject = $1 AND contract_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [`mint:${mintId}`, this.chain.contractId],
    );
    return rows[0]?.id ?? null;
  }

  /** The books_not_anchored error for a mint request: its warehouse, day used, and the last anchored day. */
  private async booksNotAnchoredFor(mintId: string, cause: AnchorCause): Promise<ConflictError> {
    const { rows } = await this.pool.query<{
      code: string;
      warehouse_id: string;
      anchor_day: number;
    }>(
      `SELECT w.code, m.warehouse_id, m.anchor_day FROM mint_requests m
         JOIN warehouses w ON w.id = m.warehouse_id WHERE m.id = $1`,
      [mintId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`mint request ${mintId} not found`);
    return booksNotAnchored(
      warehouseSymbol(row.code),
      await this.latestAnchoredDay(row.warehouse_id),
      cause,
      row.anchor_day,
    );
  }

  private async latestAnchoredDay(warehouseId: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ day: number | null }>(
      'SELECT max(day) AS day FROM book_anchors WHERE contract_id = $1 AND warehouse_id = $2',
      [this.chain.contractId, warehouseId],
    );
    return rows[0]?.day ?? null;
  }

  private async balanceLeaf(
    depositId: string,
    day: number,
  ): Promise<{ id: string; json: LeafJson; proof: Buffer[] } | null> {
    const { rows } = await this.pool.query<{
      id: string;
      content: Omit<LeafJson, 'day' | 'index' | 'salt'>;
      salt: Buffer;
      idx: number;
      proof: string[];
    }>(
      `SELECT id, content, salt, idx, proof FROM book_entries
        WHERE deposit_id = $1 AND day = $2 AND kind = 2`,
      [depositId, day],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      json: { ...row.content, day, index: row.idx, salt: row.salt.toString('hex') },
      proof: row.proof.map((p) => Buffer.from(p, 'hex')),
    };
  }

  private async loadLot(db: Queryable, depositId: string) {
    const { rows } = await db.query<{
      deposit_id: string;
      deposit_no: string;
      warehouse_id: string;
      warehouse_code: string;
      farmer_id: string;
      weight_source: string;
      bag_count: number;
      bags_weighed: number;
    }>(
      `SELECT d.deposit_id, d.deposit_no, d.warehouse_id, w.code AS warehouse_code, d.farmer_id,
              d.weight_source, d.bag_count, dw.bags_weighed::int AS bags_weighed
         FROM deposits d
         JOIN warehouses w ON w.id = d.warehouse_id
         JOIN deposit_weights dw ON dw.deposit_id = d.deposit_id
        WHERE d.deposit_id = $1`,
      [depositId],
    );
    return rows[0] ?? null;
  }

  /** True if `address` is the operator, or any farmer's, custodian's or verifier's key. */
  private async isManagedAddress(address: string): Promise<boolean> {
    if ((await addressFor(this.keys, OPERATOR_SUBJECT)) === address) return true;
    const { rows } = await this.pool.query<{ subject: string }>(
      `SELECT 'farmer:' || id AS subject FROM farmers
       UNION ALL SELECT 'custodian:' || id FROM custodians
       UNION ALL SELECT 'verifier:' || id FROM verifiers`,
    );
    for (const { subject } of rows) {
      if ((await addressFor(this.keys, subject)) === address) return true;
    }
    return false;
  }

  private async find(db: Queryable, pledgeId: string): Promise<PledgeRow | null> {
    const { rows } = await db.query<PledgeRow>(`${PLEDGE_SELECT} WHERE p.id = $1`, [pledgeId]);
    return rows[0] ?? null;
  }
}

function lockCallOf(row: PledgeRow): LockCall {
  return {
    receiptId: BigInt(row.receipt_id ?? 0),
    lender: row.lender_address,
    kg: BigInt(row.kg),
    loanRef: row.loan_ref,
    dueDate: Math.floor(row.due_date.getTime() / 1000),
    gracePeriodSeconds: Number(row.grace_period_seconds),
  };
}

function validatePledge(input: PledgeInput, now: Date): DomainError[] {
  const errors: DomainError[] = [];
  if (!StrKey.isValidEd25519PublicKey(input.lender)) {
    errors.push(domainError('invalid_lender', 'lender', 'lender must be a Stellar account (G…)'));
  }
  if (!Number.isSafeInteger(input.kg) || input.kg <= 0) {
    errors.push(domainError('invalid_pledge_kg', 'kg', 'kg must be a whole number of kg above 0'));
  }
  const refBytes = Buffer.byteLength(input.loanRef, 'utf8');
  if (refBytes === 0 || refBytes > 64) {
    errors.push(domainError('invalid_loan_ref', 'loan_ref', 'loan_ref must be 1 to 64 bytes'));
  }
  if (!(input.dueDate.getTime() > now.getTime())) {
    errors.push(domainError('invalid_due_date', 'due_date', 'due_date must be in the future'));
  }
  if (!Number.isSafeInteger(input.gracePeriodSeconds) || input.gracePeriodSeconds < 0) {
    errors.push(
      domainError('invalid_due_date', 'grace_period_seconds', 'grace period must be ≥ 0 seconds'),
    );
  }
  return errors;
}

function nativeU64Xdr(value: string): string {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(value)).toXdr('base64');
}

/** missing: no anchor on-chain; stale: not the latest anchored day; moved_since_anchor: the lot moved after it. */
type AnchorCause = 'missing' | 'stale' | 'moved_since_anchor';

function anchorCause(contractError: number | null): AnchorCause | null {
  if (contractError === ContractError.NoAnchor) return 'missing';
  if (contractError === ContractError.StaleLeaf) return 'stale';
  return null;
}

/**
 * backend-requirements §3: a mint blocked by a missing or stale anchor is
 * reported as "the warehouse's books are not anchored for today", naming
 * the warehouse and its last anchored day, never as a generic failure.
 */
function booksNotAnchored(
  symbol: string,
  lastAnchoredDay: number | null,
  cause: AnchorCause,
  mintAnchorDay?: number,
): ConflictError {
  const last = lastAnchoredDay ?? 'none';
  const why =
    cause === 'missing'
      ? `${symbol} has no anchor on-chain; last anchored day recorded here: ${last}`
      : cause === 'moved_since_anchor'
        ? `the lot moved after the cutoff of ${symbol}'s last anchored day ${last}; pledge after the next anchor`
        : `${symbol}'s last anchored day is ${last}` +
          (mintAnchorDay === undefined ? '' : `, but this mint used day ${mintAnchorDay}`) +
          '; pledge again once today is anchored';
  return new ConflictError(`The warehouse's books are not anchored for today: ${why}`, {
    code: 'books_not_anchored',
    details: {
      warehouse_id: symbol,
      last_anchored_day: lastAnchoredDay,
      cause,
      ...(mintAnchorDay === undefined ? {} : { mint_anchor_day: mintAnchorDay }),
    },
  });
}

function decodeU64(valueXdr: string | null): string {
  if (valueXdr === null) throw new Error('the call returned no value');
  return String(scValToNative(xdr.ScVal.fromXdr(valueXdr, 'base64')) as bigint);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
