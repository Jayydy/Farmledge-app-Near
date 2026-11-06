import { Router } from 'express';
import { z } from 'zod';

import { COMMODITIES } from '../../config/index.js';
import { isCommodity } from '../../domain/deposit.js';
import type { ScaleSampleService } from '../../services/scaleSamples.js';
import { assertActor } from '../auth.js';
import { ValidationError } from '../errors.js';
import { parseBody, queryString, queryTimestamp, uuid } from '../parse.js';
import { uuidParam } from './params.js';

const sampleBody = z.object({
  /** Tablet-generated idempotency key (D42). */
  sample_id: z.string().nullish(),
  bags_weighed: z.number(),
  total_kg: z.number(),
  recorded_by: uuid(),
  recorded_at: z.string().nullish(),
});

/**
 * POST /deposits/:depositId/scale-samples   record a scale reading (idempotent on sample_id)
 * GET  /warehouses/:id/scale-summary         measured vs assumed bag weight
 */
export function scaleSamplesRouter(samples: ScaleSampleService): Router {
  const router = Router();

  router.post('/deposits/:depositId/scale-samples', async (req, res) => {
    const body = parseBody(sampleBody, req.body);
    assertActor(req, { custodianId: body.recorded_by, custodianField: 'recorded_by' });
    const outcome = await samples.record(req.params.depositId, {
      sampleId: body.sample_id ?? undefined,
      bagsWeighed: body.bags_weighed,
      totalKg: body.total_kg,
      recordedBy: body.recorded_by,
      recordedAt: body.recorded_at ?? undefined,
    });
    res.status(outcome.kind === 'created' ? 201 : 200).json({
      scale_sample: outcome.sample,
      duplicate: outcome.kind === 'duplicate',
    });
  });

  router.get('/warehouses/:warehouseId/scale-summary', async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    const commodity = queryString(req.query, 'commodity');
    if (commodity !== undefined && !isCommodity(commodity)) {
      throw new ValidationError('Request is invalid', {
        details: [
          {
            code: 'unsupported_commodity',
            field: 'commodity',
            message: `commodity must be one of ${COMMODITIES.join(', ')}`,
          },
        ],
      });
    }
    const summary = await samples.warehouseSummary(warehouseId, {
      commodity,
      from: queryTimestamp(req.query, 'from'),
      to: queryTimestamp(req.query, 'to'),
    });
    res.json({ warehouse_id: warehouseId, ...summary });
  });

  return router;
}
