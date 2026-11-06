import { Router } from 'express';

import { addDays, businessDate } from '../../domain/dates.js';
import type { ProvisionService } from '../../services/provisions.js';
import type { ReportService } from '../../services/reports.js';
import type { StorageFeeService } from '../../services/storageFees.js';
import { invalidQuery, queryDate } from '../parse.js';
import { uuidParam } from './params.js';

/** Default report window: the 30 days ending today. */
const DEFAULT_PERIOD_DAYS = 30;

/**
 * Under /warehouses/:id/reports/ (dates are business dates, YYYY-MM-DD):
 * daily?date=  intake and dispatch for one day (default today)
 * outstanding-fees
 * audits?from=&to=
 * shrinkage?from=&to=
 * platform-fees?from=&to=
 * Current stock by commodity and grade is GET /warehouses/:id/stock.
 */
export function reportsRouter(
  reports: ReportService,
  fees: StorageFeeService,
  provisions: ProvisionService,
  timeZone: string,
  clock: () => Date,
): Router {
  const router = Router();
  const today = () => businessDate(clock(), timeZone);
  const period = (query: unknown) => {
    const to = queryDate(query, 'to') ?? today();
    const from = queryDate(query, 'from') ?? addDays(to, -(DEFAULT_PERIOD_DAYS - 1));
    if (from > to) throw invalidQuery('from', 'from must not be after to');
    return { from, to };
  };
  const base = '/warehouses/:warehouseId/reports';

  router.get(`${base}/daily`, async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    res.json(await reports.daily(warehouseId, queryDate(req.query, 'date') ?? today()));
  });

  router.get(`${base}/outstanding-fees`, async (req, res) => {
    res.json(await fees.outstandingByFarmer(uuidParam(req.params.warehouseId, 'Warehouse')));
  });

  router.get(`${base}/audits`, async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    const { from, to } = period(req.query);
    res.json(await reports.audits(warehouseId, from, to));
  });

  router.get(`${base}/shrinkage`, async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    const { from, to } = period(req.query);
    res.json(await reports.shrinkage(warehouseId, from, to));
  });

  router.get(`${base}/platform-fees`, async (req, res) => {
    const warehouseId = uuidParam(req.params.warehouseId, 'Warehouse');
    const { from, to } = period(req.query);
    res.json(await provisions.platformFeeReport(warehouseId, from, to));
  });

  return router;
}
