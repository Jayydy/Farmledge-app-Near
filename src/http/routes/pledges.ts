import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { PledgeService } from '../../services/pledges.js';
import type { ProofService } from '../../services/proofs.js';
import { NotFoundError, NotImplementedError, ValidationError } from '../errors.js';
import { checkShape, orThrow, uuid } from '../parse.js';
import { uuidParam } from './params.js';

const pledgeBody = z.object({
  /** Client-generated idempotency key: a retry with the same id returns that pledge's state. */
  pledge_id: uuid().optional(),
  deposit_id: z.string(),
  /** The lender's own Stellar account. We never hold its key. */
  lender: z.string(),
  kg: z.number(),
  loan_ref: z.string(),
  due_date: z.string(),
  grace_period_seconds: z.number(),
  requested_by: uuid(),
  verifier_id: uuid(),
  farmer_confirmed: z.boolean(),
});

const signatureBody = z.object({
  /** The SorobanAuthorizationEntry from step 1, signed by the lender, base64 XDR. */
  signed_entry_xdr: z.string(),
});

/**
 * POST /pledges                          step 1: freeze, mint, prepare the lock; returns what the lender signs
 * POST /pledges/:id/lender-signature     step 2: the lender's signed authorisation; submits the lock
 * GET  /pledges/:id                      one pledge
 *
 * Gated by LENDING_ENABLED, like the rest of lending.
 */
export function pledgesRouter(pledges: PledgeService, enabled: boolean): Router {
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
  router.use('/pledges', gate);

  router.post('/pledges', async (req, res) => {
    const body = orThrow(checkShape(pledgeBody, req.body), 'Pledge is invalid');
    const dueDate = new Date(body.due_date);
    if (Number.isNaN(dueDate.getTime())) {
      throw new ValidationError('Pledge is invalid', {
        details: [
          {
            code: 'invalid_due_date',
            field: 'due_date',
            message: 'due_date must be an ISO timestamp',
          },
        ],
      });
    }
    const pledge = await pledges.pledge({
      pledgeId: body.pledge_id,
      depositId: body.deposit_id,
      lender: body.lender,
      kg: body.kg,
      loanRef: body.loan_ref,
      dueDate,
      gracePeriodSeconds: body.grace_period_seconds,
      requestedBy: body.requested_by,
      verifierId: body.verifier_id,
      farmerConfirmed: body.farmer_confirmed,
    });
    // 202: the mint's outcome is not known yet ("still resolving"). Never a
    // failure: follow it with GET /pledges/:id, or retry with the same pledge_id.
    res.status(pledge.status === 'minting' ? 202 : 201).json({ pledge });
  });

  router.post('/pledges/:pledgeId/lender-signature', async (req, res) => {
    const body = orThrow(checkShape(signatureBody, req.body), 'Lender signature is invalid');
    const pledge = await pledges.submitLenderSignature(
      uuidParam(req.params.pledgeId, 'Pledge'),
      body.signed_entry_xdr,
    );
    res.json({ pledge });
  });

  router.get('/pledges/:pledgeId', async (req, res) => {
    res.json({ pledge: await pledges.get(uuidParam(req.params.pledgeId, 'Pledge')) });
  });

  return router;
}

/**
 * Public, no login: what a farmer's SMS link opens. These serve the proof
 * files; checking them never goes through Farmledge (docs/events.md).
 *
 * GET /proofs/:token                       one bundle
 * GET /proofs/statements/:token            a monthly statement's bundles
 * GET /proofs/later-days/:warehouse?after= anchored days after `after`, for old bundles
 */
export function proofsRouter(proofs: ProofService): Router {
  const router = Router();

  router.get('/proofs/statements/:token', async (req, res) => {
    const statement = await proofs.statementByToken(req.params.token);
    if (statement === null) throw new NotFoundError('Statement not found');
    res.json(statement);
  });

  router.get('/proofs/later-days/:warehouse', async (req, res) => {
    const after = Number(req.query.after ?? 0);
    res.json({
      later_days: await proofs.laterDays(req.params.warehouse, Number.isFinite(after) ? after : 0),
    });
  });

  router.get('/proofs/:token', async (req, res) => {
    const bundle = await proofs.byToken(req.params.token);
    if (bundle === null) throw new NotFoundError('Proof not found');
    res.setHeader(
      'content-disposition',
      `attachment; filename="farmledge-proof-${req.params.token}.json"`,
    );
    res.json(bundle);
  });

  return router;
}
