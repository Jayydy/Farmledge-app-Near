import type pg from 'pg';

import type { Config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import { businessDate } from '../domain/dates.js';
import type { DomainError } from '../domain/errors.js';
import { lowestRunningBags, mayCancel, type BalanceKey } from '../domain/ledger.js';
import { roundHalfAway, toCentiKg } from '../domain/quantities.js';
import { accrualRows, checkReason, computeExpectedCharges } from '../domain/storageFees.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import type { KeyService } from '../keys/keyService.js';
import { openBookWrite, writeBookEntries } from './book.js';
import { lockedBalance } from './ledger.js';
import { resolveActor } from './references.js';
import {
  ACCRUAL_LOCK,
  insertAccrualRows,
  lastAccruedDate,
  loadAccruedTotals,
  loadLedgerEvents,
  loadSchedules,
  scheduleLookup,
} from './storageFees.js';

export interface CancellationInput {
  readonly cancelledBy: string;
  readonly reason: string;
}

export interface CancellationView {
  id: string;
  deposit_id: string;
  cancelled_by: string;
  cancelled_by_role: 'custodian' | 'warehouse_owner';
  reason: string;
  /** False when cancelled by the owner after the custodian window. */
  within_window: boolean;
  /** Storage fees reversed by contra entries, in naira (0 or negative). */
  fees_reversed_ngn: number;
  cancelled_at: Date;
}

interface DepositRow {
  deposit_id: string;
  warehouse_id: string;
  farmer_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bag_count: number;
  status: string;
  created_at: Date;
  intake_at: Date;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Cancelling a deposit recorded by mistake (docs/decisions.md D22). The
 * deposit's stock is reversed at its intake time, and every storage fee it
 * caused is reversed by contra entries that point at this cancellation (its
 * reason and authoriser). Nothing is deleted.
 */
export class CancellationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly keys: KeyService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async cancel(depositId: string, input: CancellationInput): Promise<CancellationView> {
    const id = depositId.toLowerCase();
    const found = await this.pool.query<DepositRow>(
      `SELECT deposit_id, warehouse_id, farmer_id, commodity, grading_scheme, grade, bag_count,
              status, created_at, intake_at
       FROM deposits WHERE deposit_id = $1`,
      [id],
    );
    const deposit = found.rows[0];
    if (deposit === undefined) throw new NotFoundError('Deposit not found');

    const errors: DomainError[] = [];
    const reason = checkReason(input.reason, errors);
    if (reason === null) throw new ValidationError('Cancellation is invalid', { details: errors });

    const actor = await resolveActor(
      this.pool,
      input.cancelledBy,
      deposit.warehouse_id,
      'cancelled_by',
    );
    const now = this.clock();
    const windowHours = this.config.intake.cancelWindowHours;
    const withinWindow = now.getTime() - deposit.created_at.getTime() <= windowHours * HOUR_MS;
    if (!mayCancel(actor.role, withinWindow)) {
      throw new ForbiddenError(
        `More than ${windowHours} hours after recording, only the warehouse owner can cancel a deposit`,
        {
          code: 'owner_required',
          details: [
            {
              code: 'owner_required',
              field: 'cancelled_by',
              message: `More than ${windowHours} hours after recording, only the warehouse owner can cancel a deposit`,
            },
          ],
        },
      );
    }

    return withTransaction(this.pool, async (client) => {
      await openBookWrite(client, deposit.warehouse_id, now);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ACCRUAL_LOCK]);
      const locked = await client.query<{ status: string; governed: boolean }>(
        `SELECT status, (frozen_for_mint IS NOT NULL OR status = 'minted') AS governed
         FROM deposits WHERE deposit_id = $1 FOR UPDATE`,
        [id],
      );
      assertCancellable(locked.rows[0]?.status ?? deposit.status);
      if (locked.rows[0]?.governed === true) {
        // D33: a minted or pledged lot cannot be cancelled off-chain.
        throw new ConflictError(
          'This lot is pledged or has a mint pending; it cannot be cancelled off-chain',
          { code: 'lot_governed_on_chain' },
        );
      }
      // The lot itself must be untouched: only its intake and its own scale
      // reweigh. If a dispatch or adjustment drew on it, grain moved.
      const drawn = await client.query(
        `SELECT 1 FROM lot_movements lm
           JOIN stock_movements sm ON sm.id = lm.stock_movement_id
           LEFT JOIN stock_adjustments a ON a.id = sm.adjustment_id
          WHERE lm.deposit_id = $1
            AND NOT (sm.kind = 'deposit_in'
                     OR (sm.kind = 'adjustment' AND a.deposit_id = $1))
          LIMIT 1`,
        [id],
      );
      if ((drawn.rowCount ?? 0) > 0) {
        throw new ConflictError(
          'Some of this lot has already been dispatched or adjusted; grain that left is a dispatch, not a mistake',
          { code: 'deposit_stock_dispatched' },
        );
      }

      const key: BalanceKey = {
        warehouseId: deposit.warehouse_id,
        farmerId: deposit.farmer_id,
        commodity: deposit.commodity,
        gradingScheme: deposit.grading_scheme,
        grade: deposit.grade,
      };
      await lockedBalance(client, key);

      // Cancelling removes the deposit from its intake onwards. If that takes
      // the balance below zero at any point, some of it has already left.
      const history = await client.query<{ bags_delta: number; occurred_at: Date; own: boolean }>(
        `SELECT bags_delta, occurred_at, (kind = 'deposit_in' AND deposit_id = $6) AS own
         FROM stock_movements
         WHERE warehouse_id = $1 AND farmer_id = $2 AND commodity = $3
           AND grading_scheme = $4 AND grade = $5`,
        [key.warehouseId, key.farmerId, key.commodity, key.gradingScheme, key.grade, id],
      );
      const without = history.rows
        .filter((row) => !row.own)
        .map((row) => ({ bagsDelta: row.bags_delta, occurredAt: row.occurred_at }));
      if (lowestRunningBags(without) < 0) {
        throw new ConflictError(
          'Some of this deposit has already been dispatched; grain that left is a dispatch, not a mistake',
          { code: 'deposit_stock_dispatched' },
        );
      }

      // The void the ledger will hold: the deposit's bags and kg, including
      // any scale reweigh posted against it.
      const voidKg = await client.query<{ kg: string }>(
        `SELECT d.estimated_weight_kg + COALESCE(sum(a.kg_delta), 0) AS kg
         FROM deposits d LEFT JOIN stock_adjustments a ON a.deposit_id = d.deposit_id
         WHERE d.deposit_id = $1 GROUP BY d.estimated_weight_kg`,
        [id],
      );
      const rows = await this.contraRows(client, key, deposit, toCentiKg(voidKg.rows[0]?.kg ?? 0));
      const feesReversed = roundHalfAway(
        rows.reduce((sum, row) => sum + row.amountNgn, 0),
        4,
      );

      const inserted = await client.query<CancellationView & { fees_reversed_ngn: string }>(
        `INSERT INTO deposit_cancellations (deposit_id, warehouse_id, cancelled_by, cancelled_by_role,
                                            reason, within_window, fees_reversed_ngn, cancelled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, deposit_id, cancelled_by, cancelled_by_role, reason, within_window,
                   fees_reversed_ngn, cancelled_at`,
        [
          id,
          deposit.warehouse_id,
          actor.id,
          actor.role,
          reason,
          withinWindow,
          feesReversed.toFixed(4),
          now,
        ],
      );
      const cancellation = inserted.rows[0];
      if (cancellation === undefined) throw new Error('cancellation insert returned no row');
      await insertAccrualRows(client, rows, { cancellationId: cancellation.id });

      // The ledger trigger posts the void, dated at the deposit's intake,
      // and its lot movement; the cancellation goes in the book (D32).
      await client.query(`UPDATE deposits SET status = 'cancelled' WHERE deposit_id = $1`, [id]);
      const voided = await client.query<{ id: string }>(
        `SELECT lm.id FROM lot_movements lm
           JOIN stock_movements sm ON sm.id = lm.stock_movement_id
          WHERE sm.deposit_id = $1 AND sm.kind = 'deposit_void'`,
        [id],
      );
      await writeBookEntries(
        client,
        this.keys,
        voided.rows.map((row) => row.id),
        this.config.chain.backend,
      );
      return {
        ...cancellation,
        fees_reversed_ngn: roundHalfAway(Number(cancellation.fees_reversed_ngn)),
      };
    });
  }

  /**
   * Contra entries: for every day already accrued since intake, the
   * difference between what was charged and what would have been charged
   * had the deposit never existed. Applied, the charges equal exactly that,
   * so the accrual job finds nothing left to correct.
   */
  private async contraRows(
    client: pg.PoolClient,
    key: BalanceKey,
    deposit: DepositRow,
    voidCentiKg: number,
  ) {
    const lastAccrued = await lastAccruedDate(client);
    const tz = this.config.businessTimeZone;
    const intakeDay = businessDate(deposit.intake_at, tz);
    if (lastAccrued === null || intakeDay > lastAccrued) return [];

    const schedules = await loadSchedules(client);
    const events = await loadLedgerEvents(client, tz, lastAccrued, key);
    // As the ledger will be once the void is posted (after its deposit_in).
    events.push({
      ...key,
      kind: 'deposit_void',
      day: intakeDay,
      bagsDelta: -deposit.bag_count,
      centiKgDelta: -voidCentiKg,
      depositId: deposit.deposit_id,
    });
    const expected = computeExpectedCharges({
      events,
      schedules,
      from: intakeDay,
      to: lastAccrued,
    });
    const accrued = await loadAccruedTotals(client, intakeDay, lastAccrued, key);
    return accrualRows(expected, accrued, scheduleLookup(schedules)).map((row) => ({
      ...row,
      // Contra entries are corrections of past days (or of a top-up).
      kind: row.kind === 'daily' ? ('correction' as const) : row.kind,
    }));
  }
}

function assertCancellable(status: string): void {
  if (status === 'cancelled') {
    throw new ConflictError('This deposit is already cancelled', {
      code: 'deposit_already_cancelled',
    });
  }
  if (status === 'rejected') {
    throw new ConflictError('This deposit was rejected; there is nothing to cancel', {
      code: 'deposit_rejected',
    });
  }
  if (status === 'minted') {
    throw new ConflictError('A minted receipt is exited, not cancelled', {
      code: 'deposit_minted',
    });
  }
}
