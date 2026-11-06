import type { FarmledgeEnvironment } from '../config/index.js';
import type { Queryable } from './pool.js';

export class EnvironmentMismatchError extends Error {
  constructor(
    readonly expected: FarmledgeEnvironment,
    readonly actual: FarmledgeEnvironment,
  ) {
    super(
      `Refusing to run: FARMLEDGE_ENV is "${expected}" but the database belongs to "${actual}". ` +
        'Test and live data must never mix; point DATABASE_URL at the right database.',
    );
    this.name = 'EnvironmentMismatchError';
  }
}

export class DatabaseNotInitialisedError extends Error {
  constructor(detail: string) {
    super(`Refusing to run: ${detail}`);
    this.name = 'DatabaseNotInitialisedError';
  }
}

/**
 * Returns the environment the database was created for, or null if it has
 * never been migrated.
 */
export async function readDatabaseEnvironment(db: Queryable): Promise<FarmledgeEnvironment | null> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('public.db_environment') IS NOT NULL AS exists`,
  );
  if (rows[0]?.exists !== true) {
    return null;
  }
  const result = await db.query<{ environment: FarmledgeEnvironment }>(
    'SELECT environment FROM db_environment',
  );
  const environment = result.rows[0]?.environment;
  if (environment === undefined) {
    throw new DatabaseNotInitialisedError('db_environment exists but has no row.');
  }
  return environment;
}

/** Throws unless the database belongs to `expected`. */
export async function assertDatabaseEnvironment(
  db: Queryable,
  expected: FarmledgeEnvironment,
): Promise<void> {
  const actual = await readDatabaseEnvironment(db);
  if (actual === null) {
    throw new DatabaseNotInitialisedError(
      'the database has no environment identity. Run `npm run migrate` first.',
    );
  }
  if (actual !== expected) {
    throw new EnvironmentMismatchError(expected, actual);
  }
}
