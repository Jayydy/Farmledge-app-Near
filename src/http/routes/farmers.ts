import { Router } from 'express';
import { z } from 'zod';

import type { FarmerService } from '../../services/farmers.js';
import { assertActor, signedInStaff } from '../auth.js';
import { ValidationError } from '../errors.js';
import { parseBody, queryLimit, queryString, queryUuid, uuid } from '../parse.js';
import { uuidParam } from './params.js';

const registerBody = z.object({
  full_name: z.string(),
  phone: z.string(),
  warehouse_id: uuid(),
  registered_by: uuid(),
  consent: z.boolean(),
  lookup_consent: z.boolean().nullish(),
});

const DIRECTORY_PAGE_SIZE = 500;
const DIRECTORY_MAX_PAGE_SIZE = 1000;

/**
 * POST /farmers: register a farmer at a warehouse.
 * GET /farmers?phone=: find a farmer by phone, written any common way.
 * GET /warehouses/:id/farmers: the warehouse's farmers (id, phone, name) for
 *   the tablet's offline cache. Always needs a session at that warehouse (D43).
 */
export function farmersRouter(farmers: FarmerService): Router {
  const router = Router();

  router.post('/farmers', async (req, res) => {
    const body = parseBody(registerBody, req.body);
    assertActor(req, {
      custodianId: body.registered_by,
      custodianField: 'registered_by',
      warehouseId: body.warehouse_id,
    });
    const { farmer, farmerCreated } = await farmers.register({
      fullName: body.full_name,
      phone: body.phone,
      warehouseId: body.warehouse_id,
      registeredBy: body.registered_by,
      consent: body.consent,
      lookupConsent: body.lookup_consent ?? undefined,
    });
    res.status(201).json({ farmer, farmer_created: farmerCreated });
  });

  router.get('/farmers', async (req, res) => {
    const phone = queryString(req.query, 'phone');
    if (phone === undefined) {
      throw new ValidationError('Request is invalid', {
        details: [{ code: 'required', field: 'phone', message: 'phone is required' }],
      });
    }
    res.json({ items: await farmers.findByPhone(phone) });
  });

  router.get('/warehouses/:warehouseId/farmers', async (req, res) => {
    const session = signedInStaff(req);
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    assertActor(req, {
      custodianId: session.custodianId,
      custodianField: 'session',
      warehouseId,
      warehouseField: 'warehouse',
    });
    res
      .set('Cache-Control', 'no-store')
      .json(
        await farmers.listAtWarehouse(
          warehouseId,
          queryLimit(req.query, DIRECTORY_PAGE_SIZE, DIRECTORY_MAX_PAGE_SIZE),
          queryUuid(req.query, 'cursor'),
        ),
      );
  });

  return router;
}
