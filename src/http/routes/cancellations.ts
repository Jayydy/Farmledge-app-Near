import { Router } from 'express';
import { z } from 'zod';

import type { CancellationService } from '../../services/cancellations.js';
import { parseBody, uuid } from '../parse.js';

const cancelBody = z.object({
  /** A custodian of the deposit's warehouse (within the window) or its owner. */
  cancelled_by: uuid(),
  reason: z.string(),
});

/**
 * POST /deposits/:depositId/cancel   cancel a deposit recorded by mistake;
 * reverses its stock and every storage fee it caused.
 */
export function cancellationsRouter(cancellations: CancellationService): Router {
  const router = Router();

  router.post('/deposits/:depositId/cancel', async (req, res) => {
    const body = parseBody(cancelBody, req.body);
    const cancellation = await cancellations.cancel(req.params.depositId, {
      cancelledBy: body.cancelled_by,
      reason: body.reason,
    });
    res.status(201).json({ cancellation });
  });

  return router;
}
