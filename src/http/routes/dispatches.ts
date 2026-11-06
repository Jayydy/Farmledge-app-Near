import { Router } from 'express';
import { z } from 'zod';

import type { DispatchService } from '../../services/dispatches.js';
import { assertActor, assertOwnWarehouse } from '../auth.js';
import { NotFoundError } from '../errors.js';
import {
  checkShape,
  grade,
  invalidQuery,
  orThrow,
  queryDate,
  parseBody,
  queryLimit,
  queryString,
  queryUuid,
  uuid,
} from '../parse.js';
import { uuidParam } from './params.js';

const dispatchBody = z.object({
  dispatch_id: z.string(),
  warehouse_id: uuid(),
  farmer_id: uuid(),
  custodian_id: uuid(),
  commodity: z.string(),
  grade: grade(),
  bag_count: z.number(),
  exit_weight_kg: z.number().nullish(),
  /** Required when exit_weight_kg is left out; refused with one (D54). */
  not_weighed_reason: z.string().nullish(),
  buyer_name: z.string().nullish(),
  notes: z.string().nullish(),
  /** In tablet mode the farmer approves on the tablet; required to be true. */
  farmer_confirmed: z.boolean(),
  /** Take the bags from this lot only; otherwise the oldest lots go first. */
  deposit_id: z.string().nullish(),
});

const planBody = z.object({
  warehouse_id: uuid(),
  farmer_id: uuid(),
  custodian_id: uuid(),
  commodity: z.string(),
  grade: grade(),
  bag_count: z.number(),
  deposit_id: z.string().nullish(),
});

const blockedBody = z.object({
  id: z.string(),
  custodian_id: uuid(),
  blocked_at: z.string(),
  offline_since: z.string().nullish(),
});

const toleranceBody = z.object({
  tolerance_pct: z.number(),
  /** Left out: the warehouse default, used for commodities without their own. */
  commodity: z.string().nullish(),
  reason: z.string(),
  /** The warehouse owner. */
  set_by: uuid(),
});

/**
 * GET  /dispatches?warehouse=&farmer=&needs_review=&from=&to=   newest first
 * GET  /warehouses/:id/shrinkage-tolerance            tolerance in force per commodity
 * POST /warehouses/:id/shrinkage-tolerance            set it, per commodity or as the default (owner only, with reason)
 * POST /warehouses/:id/dispatch-blocked     the tablet refused a dispatch offline (idempotent on id)
 * GET  /warehouses/:id/dispatch-blocked?from=&to=   how many, from every tablet there (D57)
 * POST /dispatches/plan                     the lots a dispatch would draw now; records nothing
 * POST /dispatches                          stock leaving (idempotent on dispatch_id)
 * GET  /dispatches/:dispatchId              one dispatch
 * GET  /dispatches/:dispatchId/delivery-note the printable delivery note
 */
export function dispatchesRouter(dispatches: DispatchService): Router {
  const router = Router();

  router.post('/dispatches', async (req, res) => {
    const body = orThrow(checkShape(dispatchBody, req.body), 'Dispatch is invalid');
    assertActor(req, {
      custodianId: body.custodian_id,
      custodianField: 'custodian_id',
      warehouseId: body.warehouse_id,
    });
    const outcome = await dispatches.dispatch({
      dispatchId: body.dispatch_id,
      warehouseId: body.warehouse_id,
      farmerId: body.farmer_id,
      custodianId: body.custodian_id,
      commodity: body.commodity,
      grade: body.grade,
      bagCount: body.bag_count,
      exitWeightKg: body.exit_weight_kg ?? undefined,
      notWeighedReason: body.not_weighed_reason ?? undefined,
      buyerName: body.buyer_name ?? undefined,
      notes: body.notes ?? undefined,
      farmerConfirmed: body.farmer_confirmed,
      depositId: body.deposit_id ?? undefined,
    });
    res.status(outcome.kind === 'created' ? 201 : 200).json({
      dispatch: outcome.dispatch,
      duplicate: outcome.kind === 'duplicate',
    });
  });

  router.post('/dispatches/plan', async (req, res) => {
    const body = orThrow(checkShape(planBody, req.body), 'Dispatch plan is invalid');
    assertActor(req, {
      custodianId: body.custodian_id,
      custodianField: 'custodian_id',
      warehouseId: body.warehouse_id,
    });
    res.json(
      await dispatches.plan({
        warehouseId: body.warehouse_id,
        farmerId: body.farmer_id,
        commodity: body.commodity,
        grade: body.grade,
        bagCount: body.bag_count,
        depositId: body.deposit_id ?? undefined,
      }),
    );
  });

  router.post('/warehouses/:warehouseId/dispatch-blocked', async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    const body = parseBody(blockedBody, req.body);
    assertActor(req, {
      custodianId: body.custodian_id,
      custodianField: 'custodian_id',
      warehouseId,
    });
    const outcome = await dispatches.recordBlocked({
      id: body.id,
      warehouseId,
      custodianId: body.custodian_id,
      blockedAt: body.blocked_at,
      offlineSince: body.offline_since ?? undefined,
    });
    res.status(outcome.kind === 'created' ? 201 : 200).json({
      dispatch_blocked: outcome.event,
      duplicate: outcome.kind === 'duplicate',
    });
  });

  router.get('/warehouses/:warehouseId/dispatch-blocked', async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    assertOwnWarehouse(req, warehouseId);
    const from = queryDate(req.query, 'from');
    const to = queryDate(req.query, 'to');
    res.json({
      warehouse_id: warehouseId,
      from: from ?? null,
      to: to ?? null,
      blocked: await dispatches.countBlocked({ warehouseId, from, to }),
    });
  });

  router.get('/dispatches', async (req, res) => {
    const needsReview = queryString(req.query, 'needs_review');
    if (needsReview !== undefined && needsReview !== 'true' && needsReview !== 'false') {
      throw invalidQuery('needs_review', 'needs_review must be true or false');
    }
    const items = await dispatches.list({
      warehouseId: queryUuid(req.query, 'warehouse'),
      farmerId: queryUuid(req.query, 'farmer'),
      needsReview: needsReview === undefined ? undefined : needsReview === 'true',
      from: queryDate(req.query, 'from'),
      to: queryDate(req.query, 'to'),
      limit: queryLimit(req.query, 50, 200),
    });
    res.json({ items });
  });

  router.get('/warehouses/:warehouseId/shrinkage-tolerance', async (req, res) => {
    const items = await dispatches.tolerances(uuidParam(req.params.warehouseId, 'Warehouse'));
    res.json({ items });
  });

  router.post('/warehouses/:warehouseId/shrinkage-tolerance', async (req, res) => {
    const body = parseBody(toleranceBody, req.body);
    const items = await dispatches.setTolerance(uuidParam(req.params.warehouseId, 'Warehouse'), {
      tolerancePct: body.tolerance_pct,
      commodity: body.commodity ?? undefined,
      reason: body.reason,
      setBy: body.set_by,
    });
    res.status(201).json({ items });
  });

  router.get('/dispatches/:dispatchId', async (req, res) => {
    const dispatch = await dispatches.get(req.params.dispatchId);
    if (dispatch === null) throw new NotFoundError('Dispatch not found');
    res.json({ dispatch });
  });

  router.get('/dispatches/:dispatchId/delivery-note', async (req, res) => {
    const note = await dispatches.deliveryNote(req.params.dispatchId);
    if (note === null) throw new NotFoundError('Dispatch not found');
    res.json({ delivery_note: note });
  });

  return router;
}
