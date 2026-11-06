import type { Server } from 'node:http';
import path from 'node:path';

import type pg from 'pg';

import { createAdapters } from './adapters.js';
import type { Config } from './config/index.js';
import { assertDatabaseEnvironment } from './db/environmentGuard.js';
import { assertChainDeployment } from './services/chainDeployment.js';
import { createPool } from './db/pool.js';
import { createApp } from './http/app.js';
import type { Logger } from './logger.js';
import { LocalDiskPhotoStore } from './storage/localDiskPhotoStore.js';

export interface RunningServer {
  server: Server;
  pool: pg.Pool;
  /** Stops accepting connections, lets in-flight requests finish, then closes the pool. */
  stop(): Promise<void>;
}

/**
 * Starts the API. Refuses to listen unless the database belongs to the
 * configured environment.
 */
export async function startServer(config: Config, logger: Logger): Promise<RunningServer> {
  const pool = createPool(config.database.url, logger);
  let adapters;
  try {
    await assertDatabaseEnvironment(pool, config.environment);
    // Refuses to start when a switch asks for an adapter this build lacks.
    adapters = createAdapters(config, pool, logger);
    // README reset step 3: never start against a contract this database is not bound to.
    if (config.features.chainEnabled) await assertChainDeployment(pool, config);
  } catch (err) {
    await pool.end();
    throw err;
  }

  // One directory per environment, so test and live photos never mix either.
  const photoStore = new LocalDiskPhotoStore(
    path.resolve(config.photos.storageDir, config.environment),
  );
  const app = createApp({ config, db: pool, logger, photoStore, adapters });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(config.server.port, (err?: Error) => {
      if (err) reject(err);
      else resolve(listening);
    });
  });
  logger.info({ port: config.server.port, environment: config.environment }, 'server listening');

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= shutdown(server, pool, config.server.shutdownTimeoutMs, logger);
    return stopping;
  };

  return { server, pool, stop };
}

async function shutdown(
  server: Server,
  pool: pg.Pool,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  logger.info('shutting down');
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  // Keep-alive sockets with no request in flight would otherwise hold close() open.
  server.closeIdleConnections();
  const forceClose = setTimeout(() => {
    logger.warn({ timeoutMs }, 'shutdown timeout reached; closing remaining connections');
    server.closeAllConnections();
  }, timeoutMs);

  await closed;
  clearTimeout(forceClose);
  await pool.end();
  logger.info('shutdown complete');
}
