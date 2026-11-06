import type pg from 'pg';

/** Runs `fn` in a transaction on one pooled client: commits on success, rolls back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres error codes the services react to. */
export const PgErrorCode = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
} as const;

export function isPgError(err: unknown, code: string): err is pg.DatabaseError {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}
