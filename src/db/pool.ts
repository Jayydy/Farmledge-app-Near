import pg from 'pg';

import type { Logger } from '../logger.js';

export type Queryable = Pick<pg.Pool | pg.ClientBase, 'query'>;

export function createPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });
  // Without a listener, an error on an idle client (e.g. Postgres restarts)
  // would crash the process. The pool discards the client and reconnects.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle database client error');
  });
  return pool;
}
