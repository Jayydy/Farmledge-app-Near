import { Router } from 'express';

import type { FarmledgeEnvironment } from '../../config/index.js';
import { readDatabaseEnvironment } from '../../db/environmentGuard.js';
import type { Queryable } from '../../db/pool.js';
import { ServiceUnavailableError } from '../errors.js';

/**
 * GET /health: 200 only when the database answers and still belongs to this
 * process's environment. Anything else is a 503, so load balancers stop
 * routing to the instance.
 */
export function healthRouter(db: Queryable, environment: FarmledgeEnvironment): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    let databaseEnvironment: FarmledgeEnvironment | null;
    try {
      databaseEnvironment = await readDatabaseEnvironment(db);
    } catch (err) {
      throw new ServiceUnavailableError('Database is unreachable', { cause: err });
    }
    if (databaseEnvironment !== environment) {
      throw new ServiceUnavailableError('Database environment does not match this service');
    }

    res.set('Cache-Control', 'no-store').json({ status: 'ok', environment, database: 'ok' });
  });

  return router;
}
