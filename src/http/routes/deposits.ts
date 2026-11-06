import { Router } from 'express';
import { z } from 'zod';

import type { DomainError } from '../../domain/errors.js';
import { moisturePercentToBps } from '../../domain/units.js';
import {
  DEPOSIT_STATUSES,
  type DepositService,
  type DepositStatus,
  type DepositSubmission,
  type DepositView,
} from '../../services/deposits.js';
import { actorMismatch, assertActor, assertOwnWarehouse, staffOf } from '../auth.js';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { checkShape, grade, orThrow, queryDate, queryString, queryUuid, uuid } from '../parse.js';

export const MAX_BATCH_ITEMS = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const depositFields = {
  deposit_id: z.string(),
  farmer_id: uuid(),
  warehouse_id: uuid(),
  custodian_id: uuid(),
  verifier_id: uuid(),
  commodity: z.string(),
  grade: grade(),
  /** Percentage with at most one decimal, e.g. 12.5. */
  moisture_pct: z.number(),
  bag_count: z.number(),
  confirm_bag_count: z.boolean().nullish(),
  notes: z.string().nullish(),
};
const depositBody = z.object({ ...depositFields, captured_at: z.string().nullish() });
/** Offline items must say when they were captured on the tablet. */
const batchItem = z.object({ ...depositFields, captured_at: z.string() });
const batchBody = z.object({ items: z.array(z.unknown()) });

function toSubmission(body: z.output<typeof depositBody>): DepositSubmission {
  return {
    depositId: body.deposit_id,
    farmerId: body.farmer_id,
    warehouseId: body.warehouse_id,
    custodianId: body.custodian_id,
    verifierId: body.verifier_id,
    commodity: body.commodity,
    grade: body.grade,
    // The one place moisture crosses from the API's percentage to basis points.
    moistureBps: moisturePercentToBps(body.moisture_pct),
    bagCount: body.bag_count,
    confirmBagCount: body.confirm_bag_count ?? undefined,
    notes: body.notes ?? undefined,
    capturedAt: body.captured_at ?? undefined,
  };
}

type BatchItemResult =
  | {
      index: number;
      deposit_id: string | null;
      status: 'created' | 'duplicate';
      deposit: DepositView;
    }
  | {
      index: number;
      deposit_id: string | null;
      status: 'rejected';
      error: { code: string; message: string; details?: unknown };
    };

/**
 * POST /deposits                 record one deposit (idempotent on deposit_id)
 * POST /deposits/batch           record offline captures, each independently
 * GET  /deposits/:depositId      one deposit
 * GET  /deposits/:depositId/slip the counter slip: the deposit leaf and salt for its QR code
 * GET  /deposits                 filtered, paginated list (warehouse, farmer, deposit_no, status, needs_review, from, to)
 */
export function depositsRouter(deposits: DepositService): Router {
  const router = Router();

  router.post('/deposits', async (req, res) => {
    const body = orThrow(checkShape(depositBody, req.body), 'Deposit is invalid');
    assertActor(req, actorClaim(body));
    const outcome = await deposits.submit(toSubmission(body));
    res.status(outcome.kind === 'created' ? 201 : 200).json({
      deposit: outcome.deposit,
      duplicate: outcome.kind === 'duplicate',
    });
  });

  // Each item runs on its own: one bad item never blocks the rest, and a
  // retried batch is safe because every item is idempotent on deposit_id.
  // An unexpected failure (e.g. the database going away) fails the whole
  // request; items processed before it are kept and come back as duplicates
  // on retry.
  router.post('/deposits/batch', async (req, res) => {
    const { items } = orThrow(checkShape(batchBody, req.body));
    if (items.length === 0 || items.length > MAX_BATCH_ITEMS) {
      throw new ValidationError('Request is invalid', {
        details: [
          {
            code: 'invalid_batch_size',
            field: 'items',
            message: `items must hold between 1 and ${MAX_BATCH_ITEMS} deposits`,
          },
        ],
      });
    }

    const results: BatchItemResult[] = [];
    for (const [index, item] of items.entries()) {
      const depositId = depositIdOf(item);
      const shape = checkShape(batchItem, item);
      if (!shape.ok) {
        results.push(
          rejected(
            index,
            depositId,
            new ValidationError('Deposit is invalid', {
              details: shape.errors,
            }),
          ),
        );
        continue;
      }
      const mismatch = actorMismatch(req, actorClaim(shape.value));
      if (mismatch !== null) {
        results.push(rejected(index, depositId, mismatch));
        continue;
      }
      try {
        const outcome = await deposits.submit(toSubmission(shape.value));
        results.push({
          index,
          deposit_id: outcome.deposit.deposit_id,
          status: outcome.kind,
          deposit: outcome.deposit,
        });
      } catch (err) {
        if (!(err instanceof AppError) || err.status >= 500) throw err;
        results.push(rejected(index, depositId, err));
      }
    }

    const count = (status: BatchItemResult['status']) =>
      results.filter((result) => result.status === status).length;
    res.json({
      summary: {
        created: count('created'),
        duplicate: count('duplicate'),
        rejected: count('rejected'),
      },
      results,
    });
  });

  // With a session, a deposit is readable only at its own warehouse (D46).
  router.get('/deposits/:depositId/slip', async (req, res) => {
    const slip = await deposits.slip(req.params.depositId);
    if (slip === null) throw new NotFoundError('Deposit not found');
    assertOwnWarehouse(req, slip.deposit.warehouse_id);
    res.set('Cache-Control', 'no-store').json(slip);
  });

  router.get('/deposits/:depositId', async (req, res) => {
    const deposit = await deposits.get(req.params.depositId);
    if (deposit === null) throw new NotFoundError('Deposit not found');
    assertOwnWarehouse(req, deposit.warehouse_id);
    res.json({ deposit });
  });

  router.get('/deposits', async (req, res) => {
    const status = queryString(req.query, 'status');
    if (status !== undefined && !(DEPOSIT_STATUSES as readonly string[]).includes(status)) {
      throw invalidQuery('status', `status must be one of ${DEPOSIT_STATUSES.join(', ')}`);
    }
    const needsReview = queryString(req.query, 'needs_review');
    if (needsReview !== undefined && needsReview !== 'true' && needsReview !== 'false') {
      throw invalidQuery('needs_review', 'needs_review must be true or false');
    }
    const limitText = queryString(req.query, 'limit');
    const limit = limitText === undefined ? DEFAULT_PAGE_SIZE : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw invalidQuery('limit', `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
    }
    const depositNoText = queryString(req.query, 'deposit_no');
    const depositNo = depositNoText === undefined ? undefined : Number(depositNoText);
    if (depositNo !== undefined && (!Number.isSafeInteger(depositNo) || depositNo < 1)) {
      throw invalidQuery('deposit_no', 'deposit_no must be a whole number of at least 1');
    }
    // With a session, the list is the session's own warehouse (D46).
    const session = staffOf(req);
    const warehouseId = queryUuid(req.query, 'warehouse') ?? session?.warehouseId;
    if (session !== undefined && warehouseId !== undefined) {
      assertOwnWarehouse(req, warehouseId);
    }
    res.json(
      await deposits.list({
        warehouseId,
        farmerId: queryUuid(req.query, 'farmer'),
        depositNo,
        status: status as DepositStatus | undefined,
        needsReview: needsReview === undefined ? undefined : needsReview === 'true',
        from: queryDate(req.query, 'from'),
        to: queryDate(req.query, 'to'),
        limit,
        cursor: queryString(req.query, 'cursor'),
      }),
    );
  });

  return router;
}

function actorClaim(body: z.output<typeof depositBody>) {
  return {
    custodianId: body.custodian_id,
    custodianField: 'custodian_id',
    warehouseId: body.warehouse_id,
  };
}

function depositIdOf(item: unknown): string | null {
  if (typeof item === 'object' && item !== null && 'deposit_id' in item) {
    return typeof item.deposit_id === 'string' ? item.deposit_id.toLowerCase() : null;
  }
  return null;
}

function rejected(index: number, depositId: string | null, err: AppError): BatchItemResult {
  return {
    index,
    deposit_id: depositId,
    status: 'rejected',
    error: {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    },
  };
}

function invalidQuery(field: string, message: string): ValidationError {
  const detail: DomainError = { code: 'invalid_query', field, message };
  return new ValidationError('Request is invalid', { details: [detail] });
}
