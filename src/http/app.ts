import express from 'express';
import type pg from 'pg';

import { createAdapters, type Adapters } from '../adapters.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../logger.js';
import { AdminService } from '../services/admin.js';
import { AuditService } from '../services/audits.js';
import { AuthService } from '../services/auth.js';
import { CancellationService } from '../services/cancellations.js';
import { DepositService } from '../services/deposits.js';
import { DispatchService } from '../services/dispatches.js';
import { FarmerService } from '../services/farmers.js';
import { LedgerService } from '../services/ledger.js';
import { NotificationService } from '../services/notifications.js';
import { PhotoService } from '../services/photos.js';
import { ProvisionService } from '../services/provisions.js';
import { ReportService } from '../services/reports.js';
import { ScaleSampleService } from '../services/scaleSamples.js';
import { AlertService } from '../services/alerts.js';
import { PledgeService } from '../services/pledges.js';
import { ProofService } from '../services/proofs.js';
import { StorageFeeService } from '../services/storageFees.js';
import type { PhotoStore } from '../storage/photoStore.js';
import { requireStaff, staffAuth } from './auth.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { requestLogger } from './requestLogger.js';
import { adminRouter } from './routes/admin.js';
import { auditsRouter } from './routes/audits.js';
import { authRouter } from './routes/auth.js';
import { cancellationsRouter } from './routes/cancellations.js';
import { depositsRouter } from './routes/deposits.js';
import { dispatchesRouter } from './routes/dispatches.js';
import { farmersRouter } from './routes/farmers.js';
import { healthRouter } from './routes/health.js';
import { ledgerRouter } from './routes/ledger.js';
import { lendingRouter } from './routes/lending.js';
import { photosRouter } from './routes/photos.js';
import { pledgesRouter, proofsRouter } from './routes/pledges.js';
import { provisionsRouter } from './routes/provisions.js';
import { reportsRouter } from './routes/reports.js';
import { scaleSamplesRouter } from './routes/scaleSamples.js';
import { storageFeesRouter } from './routes/storageFees.js';

export interface AppDependencies {
  config: Config;
  db: pg.Pool;
  logger: Logger;
  photoStore: PhotoStore;
  /** Port implementations; built from config when omitted (tests inject their own). */
  adapters?: Adapters;
  /** Current time; injectable so tests can pin "now". */
  clock?: () => Date;
}

export function createApp({
  config,
  db,
  logger,
  photoStore,
  adapters = createAdapters(config, db, logger),
  clock = () => new Date(),
}: AppDependencies): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger(logger));
  // Room for a full offline batch (100 deposits is ~40 kB).
  app.use(express.json({ limit: '256kb' }));

  const notifications = new NotificationService(db, adapters.sms, logger);
  const fees = new StorageFeeService(db, config, notifications, clock);
  const provisions = new ProvisionService(db, config);

  app.use(healthRouter(db, config.environment));

  // Staff sessions (D41): a bearer token, when sent, must be valid; the
  // tablet's intake, dispatch and farmer-balance routes need one when
  // AUTH_REQUIRED is on.
  const auth = new AuthService(db, config.auth.sessionTtlHours, clock);
  app.use(staffAuth(auth));
  app.use(authRouter(auth));
  const staff = requireStaff(config.auth.required);
  app.post(['/farmers', '/deposits', '/deposits/batch'], staff);
  app.post(['/deposits/:depositId/scale-samples', '/deposits/:depositId/photos'], staff);
  app.get(['/farmers', '/deposits/:depositId', '/deposits/:depositId/slip'], staff);
  app.post(['/dispatches', '/dispatches/plan', '/warehouses/:warehouseId/dispatch-blocked'], staff);
  app.get(
    ['/dispatches', '/dispatches/:dispatchId', '/dispatches/:dispatchId/delivery-note'],
    staff,
  );
  app.get(
    ['/farmers/:farmerId/balance', '/farmers/:farmerId/statement', '/farmers/:farmerId/lots'],
    staff,
  );
  // Stock audit and the daily summary (D57).
  app.post(['/audits', '/audits/:auditId/lines', '/audits/:auditId/complete'], staff);
  app.get(
    [
      '/audits/:auditId/report',
      '/deposits',
      '/warehouses/:warehouseId/stock',
      '/warehouses/:warehouseId/dispatch-blocked',
    ],
    staff,
  );

  app.use(farmersRouter(new FarmerService(db)));
  app.use(photosRouter(new PhotoService(db, photoStore), config.photos.maxBytes));
  app.use(scaleSamplesRouter(new ScaleSampleService(db, config, adapters.keys, clock)));
  app.use(depositsRouter(new DepositService(db, config, notifications, adapters.keys, clock)));
  app.use(cancellationsRouter(new CancellationService(db, config, adapters.keys, clock)));
  app.use(auditsRouter(new AuditService(db, config, clock)));
  app.use(ledgerRouter(new LedgerService(db, config, adapters.pricing, adapters.keys, clock)));
  app.use(
    dispatchesRouter(
      new DispatchService(
        db,
        config,
        adapters.confirmation,
        adapters.keys,
        notifications,
        logger,
        clock,
      ),
    ),
  );
  app.use(storageFeesRouter(fees));
  app.use(
    reportsRouter(new ReportService(db, config), fees, provisions, config.businessTimeZone, clock),
  );
  app.use(provisionsRouter(provisions, config));
  app.use(lendingRouter(adapters.lending, config.features.lendingEnabled));
  const alerts = new AlertService(db, logger, clock);
  app.use(
    pledgesRouter(
      new PledgeService(
        db,
        adapters.chain,
        adapters.keys,
        adapters.confirmation,
        alerts,
        logger,
        clock,
      ),
      config.features.lendingEnabled,
    ),
  );
  app.use(
    proofsRouter(new ProofService(db, adapters.chain, adapters.sms, config, alerts, logger, clock)),
  );
  app.use(adminRouter(new AdminService(db, clock)));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
