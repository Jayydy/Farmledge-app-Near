import { Router } from 'express';
import { z } from 'zod';

import type { StorageFeeService } from '../../services/storageFees.js';
import { ValidationError } from '../errors.js';
import { parseBody, queryDate, queryUuid, uuid } from '../parse.js';
import { uuidParam } from './params.js';

const scheduleBody = z.object({
  /** Omit for the warehouse default schedule. */
  commodity: z.string().nullish(),
  basis: z.string(),
  period: z.string(),
  rate_ngn: z.number(),
  minimum_days: z.number().nullish(),
  effective_from: z.string(),
  reason: z.string(),
  /** The warehouse owner. */
  set_by: uuid(),
});

const reversalBody = z.object({ reversed_by: uuid(), reason: z.string() });

const paymentBody = z.object({
  warehouse_id: uuid(),
  farmer_id: uuid(),
  amount_ngn: z.number(),
  reference: z.string(),
  paid_on: z.string(),
  method: z.string(),
  notes: z.string().nullish(),
  recorded_by: uuid(),
});

const notifyBody = z.object({ warehouse_id: uuid(), requested_by: uuid() });

/**
 * POST /warehouses/:id/storage-fee-schedules  add a fee schedule from a date
 * GET  /warehouses/:id/storage-fee-schedules  list them
 * GET  /farmers/:id/statement?warehouse=&from=&to=
 * POST /farmers/:id/statement/notify          text the farmer what they owe
 * POST /fee-payments                          record a payment (no money moves)
 * POST /fee-payments/:paymentId/reverse       reverse one recorded in error (owner only)
 */
export function storageFeesRouter(fees: StorageFeeService): Router {
  const router = Router();

  router.post('/warehouses/:warehouseId/storage-fee-schedules', async (req, res) => {
    const body = parseBody(scheduleBody, req.body);
    const schedule = await fees.createSchedule(uuidParam(req.params.warehouseId, 'Warehouse'), {
      commodity: body.commodity ?? undefined,
      reason: body.reason,
      basis: body.basis,
      period: body.period,
      rateNgn: body.rate_ngn,
      minimumDays: body.minimum_days ?? undefined,
      effectiveFrom: body.effective_from,
      setBy: body.set_by,
    });
    res.status(201).json({ schedule });
  });

  router.get('/warehouses/:warehouseId/storage-fee-schedules', async (req, res) => {
    const items = await fees.listSchedules(uuidParam(req.params.warehouseId, 'Warehouse'));
    res.json({ items });
  });

  router.get('/farmers/:farmerId/statement', async (req, res) => {
    const farmerId = uuidParam(req.params.farmerId, 'Farmer');
    const warehouseId = queryUuid(req.query, 'warehouse');
    if (warehouseId === undefined) {
      throw new ValidationError('Request is invalid', {
        details: [{ code: 'required', field: 'warehouse', message: 'warehouse is required' }],
      });
    }
    res.json(
      await fees.statement(farmerId, warehouseId, {
        from: queryDate(req.query, 'from'),
        to: queryDate(req.query, 'to'),
      }),
    );
  });

  router.post('/farmers/:farmerId/statement/notify', async (req, res) => {
    const body = parseBody(notifyBody, req.body);
    const notification = await fees.notifyStatement(
      uuidParam(req.params.farmerId, 'Farmer'),
      body.warehouse_id.toLowerCase(),
      body.requested_by.toLowerCase(),
    );
    res.status(201).json({ notification });
  });

  router.post('/fee-payments', async (req, res) => {
    const body = parseBody(paymentBody, req.body);
    const outcome = await fees.recordPayment({
      warehouseId: body.warehouse_id,
      farmerId: body.farmer_id,
      amountNgn: body.amount_ngn,
      reference: body.reference,
      paidOn: body.paid_on,
      method: body.method,
      notes: body.notes ?? undefined,
      recordedBy: body.recorded_by,
    });
    res.status(outcome.kind === 'created' ? 201 : 200).json({
      payment: outcome.payment,
      outstanding_ngn: outcome.outstanding_ngn,
      duplicate: outcome.kind === 'duplicate',
    });
  });

  router.post('/fee-payments/:paymentId/reverse', async (req, res) => {
    const body = parseBody(reversalBody, req.body);
    const outcome = await fees.reversePayment(uuidParam(req.params.paymentId, 'Payment'), {
      reversedBy: body.reversed_by,
      reason: body.reason,
    });
    res.status(201).json(outcome);
  });

  return router;
}
