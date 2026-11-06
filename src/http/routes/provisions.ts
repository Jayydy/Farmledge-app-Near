import { Router } from 'express';
import { z } from 'zod';

import { COMMODITIES, type Config } from '../../config/index.js';
import { isCommodity, MAX_NOTES_LENGTH } from '../../domain/deposit.js';
import { MAX_PHOTOS_PER_DEPOSIT, PHOTO_TYPES } from '../../domain/photo.js';
import { bpsToMoisturePercent } from '../../domain/units.js';
import type { ProvisionService } from '../../services/provisions.js';
import { grade, invalidQuery, parseBody, queryString, uuid } from '../parse.js';
import { uuidParam } from './params.js';

const priceBody = z.object({
  commodity: z.string(),
  grade: grade().nullish(),
  price_per_tonne_ngn: z.number(),
  effective_from: z.string(),
  entered_by: uuid(),
});

const termsBody = z.object({
  model: z.string(),
  per_bag_rate_ngn: z.number().nullish(),
  effective_from: z.string(),
  set_by: uuid(),
});

/**
 * GET  /features                              switches the tablet needs to know
 * POST /prices, GET /prices?commodity=        manual prices (reports only)
 * POST /warehouses/:id/platform-fee-terms     what Farmledge charges the warehouse
 * GET  /warehouses/:id/platform-fee-terms
 */
export function provisionsRouter(provisions: ProvisionService, config: Config): Router {
  const router = Router();

  router.get('/features', (_req, res) => {
    res.json({
      lending_enabled: config.features.lendingEnabled,
      chain_enabled: config.features.chainEnabled,
      confirmation_mode: config.features.confirmationMode,
      weight_mode: config.features.weightMode,
      release_authority: config.features.releaseAuthority,
      grading: { scheme: config.grading.scheme, grades: config.grading.grades },
      sms_gateway: config.adapters.smsGateway,
      pricing_provider: config.adapters.pricingProvider,
      business_timezone: config.businessTimeZone,
      auth_required: config.auth.required,
      // The intake rules, so the tablet can check a deposit offline (D42).
      intake: {
        commodities: COMMODITIES.map((commodity) => {
          const { bagSizeKg, moistureBps } = config.commodities[commodity];
          return {
            code: commodity,
            bag_size_kg: bagSizeKg,
            moisture_pct: {
              min: bpsToMoisturePercent(moistureBps.min),
              max: bpsToMoisturePercent(moistureBps.max),
            },
          };
        }),
        bag_count_max: config.intake.bagCountMax,
        bag_count_confirm_above: config.intake.bagCountConfirmAbove,
        offline_review_after_hours: config.intake.offlineReviewAfterHours,
        offline_reject_after_hours: config.intake.offlineRejectAfterHours,
        notes_max_length: MAX_NOTES_LENGTH,
        photos: {
          max_per_deposit: MAX_PHOTOS_PER_DEPOSIT,
          max_bytes: config.photos.maxBytes,
          types: PHOTO_TYPES,
        },
      },
    });
  });

  router.post('/prices', async (req, res) => {
    const body = parseBody(priceBody, req.body);
    const price = await provisions.addPrice({
      commodity: body.commodity,
      grade: body.grade ?? undefined,
      pricePerTonneNgn: body.price_per_tonne_ngn,
      effectiveFrom: body.effective_from,
      enteredBy: body.entered_by,
    });
    res.status(201).json({ price });
  });

  router.get('/prices', async (req, res) => {
    const commodity = queryString(req.query, 'commodity');
    if (commodity !== undefined && !isCommodity(commodity)) {
      throw invalidQuery('commodity', `commodity must be one of ${COMMODITIES.join(', ')}`);
    }
    res.json({ items: await provisions.listPrices(commodity) });
  });

  router.post('/warehouses/:warehouseId/platform-fee-terms', async (req, res) => {
    const body = parseBody(termsBody, req.body);
    const terms = await provisions.setPlatformFeeTerms(
      uuidParam(req.params.warehouseId, 'Warehouse'),
      {
        model: body.model,
        perBagRateNgn: body.per_bag_rate_ngn ?? undefined,
        effectiveFrom: body.effective_from,
        setBy: body.set_by,
      },
    );
    res.status(201).json({ terms });
  });

  router.get('/warehouses/:warehouseId/platform-fee-terms', async (req, res) => {
    const items = await provisions.listPlatformFeeTerms(
      uuidParam(req.params.warehouseId, 'Warehouse'),
    );
    res.json({ items });
  });

  return router;
}
