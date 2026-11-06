import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { LendingService } from '../../lending/lendingService.js';
import { NotImplementedError } from '../errors.js';
import { parseBody, uuid } from '../parse.js';
import { uuidParam } from './params.js';

const lockBody = z.object({
  deposit_id: z.string(),
  lender_ref: z.string(),
  amount_ngn: z.number(),
  requested_by: uuid(),
});
const actionBody = z.object({ requested_by: uuid() });

/**
 * Lending (provision a). With LENDING_ENABLED=false every route answers 501
 * `feature_disabled` before looking at the request. With it on, requests are
 * validated and reach the LendingService, which in this build answers 501
 * `not_implemented`.
 *
 * POST /lending/locks                        lock a receipt as collateral
 * POST /lending/locks/:lockId/unlock         release it on repayment
 * POST /lending/locks/:lockId/recovery       start recovery on default
 * POST /lending/recoveries/:id/complete      close a recovery after sale
 */
export function lendingRouter(lending: LendingService, enabled: boolean): Router {
  const router = Router();

  const gate: RequestHandler = (_req, _res, next) => {
    if (!enabled) {
      next(
        new NotImplementedError('Lending is switched off (LENDING_ENABLED=false)', {
          code: 'feature_disabled',
        }),
      );
      return;
    }
    next();
  };
  router.use('/lending', gate);

  router.post('/lending/locks', async (req, res) => {
    const body = parseBody(lockBody, req.body);
    await lending.lock({
      depositId: body.deposit_id,
      lenderRef: body.lender_ref,
      amountNgn: body.amount_ngn,
      requestedBy: body.requested_by,
    });
    res.status(201).end();
  });

  router.post('/lending/locks/:lockId/unlock', async (req, res) => {
    const body = parseBody(actionBody, req.body);
    await lending.unlock(uuidParam(req.params.lockId, 'Lock'), { requestedBy: body.requested_by });
    res.end();
  });

  router.post('/lending/locks/:lockId/recovery', async (req, res) => {
    const body = parseBody(actionBody, req.body);
    await lending.startRecovery(uuidParam(req.params.lockId, 'Lock'), {
      requestedBy: body.requested_by,
    });
    res.end();
  });

  router.post('/lending/recoveries/:recoveryId/complete', async (req, res) => {
    const body = parseBody(actionBody, req.body);
    await lending.completeRecovery(uuidParam(req.params.recoveryId, 'Recovery'), {
      requestedBy: body.requested_by,
    });
    res.end();
  });

  return router;
}
