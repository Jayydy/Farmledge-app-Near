import { Router, type Request } from 'express';
import { z } from 'zod';

import type { AuditService } from '../../services/audits.js';
import { assertActor, staffOf } from '../auth.js';
import { NotFoundError } from '../errors.js';
import { grade, parseBody, uuid } from '../parse.js';
import { uuidParam } from './params.js';

const startBody = z.object({
  warehouse_id: uuid(),
  /** A verifier conducting the count (D44); optional since D57. */
  conducted_by: uuid().nullish(),
  /** The custodian entering the figures: the signed-in one, with a session (D57). */
  entered_by: uuid().nullish(),
  counted_by: z.string(),
  witnessed_by: z.string(),
  started_at: z.string().nullish(),
  notes: z.string().nullish(),
});

const lineBody = z.object({
  commodity: z.string(),
  grade: grade(),
  counted_bags: z.number(),
  counted_kg: z.number().nullish(),
  notes: z.string().nullish(),
});

/**
 * POST /audits                    start a physical stock count
 * POST /audits/:auditId/lines     record one commodity and grade counted
 * POST /audits/:auditId/complete  close the audit to further lines
 * GET  /audits/:auditId/report    recorded vs counted, with differences
 *
 * With a session, an audit is entered by the signed-in custodian at their
 * own warehouse, and another warehouse's audit is not found (D57).
 */
export function auditsRouter(audits: AuditService): Router {
  const router = Router();

  router.post('/audits', async (req, res) => {
    const body = parseBody(startBody, req.body);
    if (staffOf(req) !== undefined) {
      assertActor(req, {
        custodianId: body.entered_by ?? '',
        custodianField: 'entered_by',
        warehouseId: body.warehouse_id,
      });
    }
    const audit = await audits.start({
      warehouseId: body.warehouse_id,
      conductedBy: body.conducted_by ?? undefined,
      enteredBy: body.entered_by ?? undefined,
      countedBy: body.counted_by,
      witnessedBy: body.witnessed_by,
      startedAt: body.started_at ?? undefined,
      notes: body.notes ?? undefined,
    });
    res.status(201).json({ audit });
  });

  router.post('/audits/:auditId/lines', async (req, res) => {
    const auditId = await ownAudit(req, req.params.auditId, audits);
    const body = parseBody(lineBody, req.body);
    const line = await audits.addLine(auditId, {
      commodity: body.commodity,
      grade: body.grade,
      countedBags: body.counted_bags,
      countedKg: body.counted_kg ?? undefined,
      notes: body.notes ?? undefined,
    });
    res.status(201).json({ line });
  });

  router.post('/audits/:auditId/complete', async (req, res) => {
    const audit = await audits.complete(await ownAudit(req, req.params.auditId, audits));
    res.json({ audit });
  });

  router.get('/audits/:auditId/report', async (req, res) => {
    res.json(await audits.report(await ownAudit(req, req.params.auditId, audits)));
  });

  return router;
}

/** The audit id from the path; with a session, only an audit at its warehouse. */
async function ownAudit(req: Request, id: string, audits: AuditService): Promise<string> {
  const auditId = uuidParam(id, 'Audit');
  const session = staffOf(req);
  if (session !== undefined && (await audits.warehouseOf(auditId)) !== session.warehouseId) {
    throw new NotFoundError('Audit not found');
  }
  return auditId;
}
