import { Router } from 'express';
import { z } from 'zod';

import type { AdminService } from '../../services/admin.js';
import { parseBody, uuid } from '../parse.js';

const ownerBody = z.object({
  warehouse_id: uuid(),
  /** The Farmledge admin making the assignment. */
  assigned_by: uuid(),
  reason: z.string(),
  /** Promote this custodian of the warehouse; or give full_name and phone. */
  custodian_id: uuid().optional(),
  full_name: z.string().optional(),
  phone: z.string().optional(),
});

/**
 * POST /admin/warehouse-owners   create a warehouse owner, or promote a
 * custodian to owner (Farmledge admin only); the assignment is logged.
 */
export function adminRouter(admin: AdminService): Router {
  const router = Router();

  router.post('/admin/warehouse-owners', async (req, res) => {
    const body = parseBody(ownerBody, req.body);
    const created = await admin.createWarehouseOwner({
      warehouseId: body.warehouse_id,
      assignedBy: body.assigned_by,
      reason: body.reason,
      custodianId: body.custodian_id,
      fullName: body.full_name,
      phone: body.phone,
    });
    res.status(201).json(created);
  });

  return router;
}
