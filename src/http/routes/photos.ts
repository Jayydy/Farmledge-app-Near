import express, { Router } from 'express';

import type { PhotoService } from '../../services/photos.js';
import { assertActor } from '../auth.js';
import { ValidationError } from '../errors.js';
import { queryUuid } from '../parse.js';
import { uuidParam } from './params.js';

/**
 * POST /deposits/:depositId/photos?uploaded_by=   raw image body (JPEG, PNG or WebP)
 * GET  /deposits/:depositId/photos                 list a deposit's photos
 * GET  /deposits/:depositId/photos/:photoId        the image itself
 *
 * The body is the image bytes with its Content-Type, not multipart: simpler
 * for the tablet and needs no multipart parser.
 */
export function photosRouter(photos: PhotoService, maxBytes: number): Router {
  const router = Router();
  const rawBody = express.raw({ type: () => true, limit: maxBytes });

  router.post('/deposits/:depositId/photos', rawBody, async (req, res) => {
    const uploadedBy = queryUuid(req.query, 'uploaded_by');
    if (uploadedBy === undefined) {
      throw new ValidationError('Request is invalid', {
        details: [{ code: 'required', field: 'uploaded_by', message: 'uploaded_by is required' }],
      });
    }
    assertActor(req, { custodianId: uploadedBy, custodianField: 'uploaded_by' });
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    const outcome = await photos.upload({
      depositId: req.params.depositId,
      uploadedBy,
      contentType: contentType ?? '',
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    res.status(outcome.created ? 201 : 200).json({
      photo: outcome.photo,
      duplicate: !outcome.created,
    });
  });

  router.get('/deposits/:depositId/photos', async (req, res) => {
    res.json({ items: await photos.list(req.params.depositId) });
  });

  router.get('/deposits/:depositId/photos/:photoId', async (req, res) => {
    const photoId = uuidParam(req.params.photoId, 'Photo');
    const { photo, data } = await photos.read(req.params.depositId, photoId);
    res
      .type(photo.content_type)
      .set({
        'Cache-Control': 'private, max-age=86400, immutable',
        ETag: `"${photo.sha256}"`,
        'X-Content-Type-Options': 'nosniff',
      })
      .send(data);
  });

  return router;
}
