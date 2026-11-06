import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import type { FarmledgeEnvironment } from '../config/index.js';
import {
  DatabaseNotInitialisedError,
  EnvironmentMismatchError,
  readDatabaseEnvironment,
} from './environmentGuard.js';

// Same relative location from src/db/ and dist/db/.
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);
const MIGRATIONS_TABLE = 'pgmigrations';

export interface MigrateOptions {
  databaseUrl: string;
  environment: FarmledgeEnvironment;
  direction: 'up' | 'down';
  /** Number of migrations to apply or roll back. Defaults: all up, one down. */
  count?: number;
  log?: (message: string) => void;
}

/**
 * Runs migrations after checking the database's environment. A fresh
 * database is stamped with `environment` by the first migration; an existing
 * one must already match it.
 */
export async function runMigrations(options: MigrateOptions): Promise<string[]> {
  const { databaseUrl, environment, direction, count, log = () => undefined } = options;

  if (direction === 'down' && environment === 'live') {
    throw new Error('Refusing to roll back a live database. Write a forward migration instead.');
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const actual = await readDatabaseEnvironment(client);
    if (actual === null) {
      if (await hasMigrationHistory(client)) {
        throw new DatabaseNotInitialisedError(
          `${MIGRATIONS_TABLE} has entries but db_environment is missing; inspect this database by hand.`,
        );
      }
      if (direction === 'down') {
        return [];
      }
    } else if (actual !== environment) {
      throw new EnvironmentMismatchError(environment, actual);
    }

    // Read by 001_environment_identity.sql when stamping a fresh database.
    await client.query(`SELECT set_config('farmledge.environment', $1, false)`, [environment]);

    const applied = await runner({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      migrationsTable: MIGRATIONS_TABLE,
      direction,
      ...(count === undefined ? {} : { count }),
      checkOrder: true,
      verbose: false,
      log,
    });
    return applied.map((migration) => migration.name);
  } finally {
    await client.end();
  }
}

async function hasMigrationHistory(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${MIGRATIONS_TABLE}`],
  );
  if (rows[0]?.exists !== true) {
    return false;
  }
  const history = await client.query(`SELECT 1 FROM ${MIGRATIONS_TABLE} LIMIT 1`);
  return history.rowCount !== 0;
}
