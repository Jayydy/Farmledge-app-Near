import { Router } from 'express';
import { z } from 'zod';

import { COMMODITIES } from '../../config/index.js';
import { isCommodity } from '../../domain/deposit.js';
import { MOVEMENT_KINDS, type MovementKind } from '../../domain/ledger.js';
import type { LedgerService } from '../../services/ledger.js';
import { assertOwnWarehouse } from '../auth.js';
import {
  grade,
  invalidQuery,
  orThrow,
  checkShape,
  queryDate,
  queryLimit,
  queryString,
  queryUuid,
  uuid,
} from '../parse.js';
import { uuidParam } from './params.js';

const adjustmentBody = z.object({
  adjustment_id: z.string(),
  warehouse_id: uuid(),
  farmer_id: uuid(),
  commodity: z.string(),
  grade: grade(),
  bags_delta: z.number(),
  kg_delta: z.number(),
  reason_code: z.string(),
  notes: z.string(),
  recorded_by: uuid(),
  authorised_by: uuid(),
  /** Adjust this lot only (D29). */
  deposit_id: z.string().nullish(),
});

/**
 * GET  /warehouses/:id/stock     current stock by commodity and grade, valued
 * GET  /farmers/:id/balance      a farmer's balances, free and held on-chain (?warehouse=)
 * GET  /farmers/:id/lots         a farmer's lots at a warehouse, oldest first, with their state
 *                                (?warehouse=, required; &commodity=&grade=)
 * GET  /ledger                   movements (?warehouse=&farmer=&commodity=&kind=&from=&to=)
 * POST /adjustments              correct stock, with reason and authoriser
 */
export function ledgerRouter(ledger: LedgerService): Router {
  const router = Router();

  router.get('/warehouses/:warehouseId/stock', async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    assertOwnWarehouse(req, warehouseId);
    res.json(await ledger.warehouseStock(warehouseId));
  });

  router.get('/farmers/:farmerId/balance', async (req, res) => {
    const farmerId = uuidParam(req.params.farmerId, 'Farmer');
    const items = await ledger.farmerBalances(farmerId, queryUuid(req.query, 'warehouse'));
    res.json({ farmer_id: farmerId, items });
  });

  router.get('/farmers/:farmerId/lots', async (req, res) => {
    const farmerId = uuidParam(req.params.farmerId, 'Farmer');
    const warehouseId = queryUuid(req.query, 'warehouse');
    if (warehouseId === undefined) throw invalidQuery('warehouse', 'warehouse is required');
    const commodity = queryString(req.query, 'commodity');
    if (commodity !== undefined && !isCommodity(commodity)) {
      throw invalidQuery('commodity', `commodity must be one of ${COMMODITIES.join(', ')}`);
    }
    const items = await ledger.farmerLotList(farmerId, {
      warehouseId,
      commodity,
      grade: queryString(req.query, 'grade'),
    });
    res.json({ farmer_id: farmerId, warehouse_id: warehouseId, items });
  });

  router.get('/ledger', async (req, res) => {
    const commodity = queryString(req.query, 'commodity');
    if (commodity !== undefined && !isCommodity(commodity)) {
      throw invalidQuery('commodity', `commodity must be one of ${COMMODITIES.join(', ')}`);
    }
    const kind = queryString(req.query, 'kind');
    if (kind !== undefined && !(MOVEMENT_KINDS as readonly string[]).includes(kind)) {
      throw invalidQuery('kind', `kind must be one of ${MOVEMENT_KINDS.join(', ')}`);
    }
    res.json(
      await ledger.history({
        warehouseId: queryUuid(req.query, 'warehouse'),
        farmerId: queryUuid(req.query, 'farmer'),
        commodity,
        kind: kind as MovementKind | undefined,
        from: queryDate(req.query, 'from'),
        to: queryDate(req.query, 'to'),
        limit: queryLimit(req.query, 50, 200),
        cursor: queryString(req.query, 'cursor'),
      }),
    );
  });

  router.post('/adjustments', async (req, res) => {
    const body = orThrow(checkShape(adjustmentBody, req.body), 'Adjustment is invalid');
    const outcome = await ledger.adjust({
      adjustmentId: body.adjustment_id,
      warehouseId: body.warehouse_id,
      farmerId: body.farmer_id,
      commodity: body.commodity,
      grade: body.grade,
      bagsDelta: body.bags_delta,
      kgDelta: body.kg_delta,
      reasonCode: body.reason_code,
      notes: body.notes,
      recordedBy: body.recorded_by,
      authorisedBy: body.authorised_by,
      depositId: body.deposit_id ?? undefined,
    });
    res.status(outcome.kind === 'created' ? 201 : 200).json({
      adjustment: outcome.adjustment,
      duplicate: outcome.kind === 'duplicate',
    });
  });

  return router;
}
