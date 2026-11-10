import { randomUUID } from 'node:crypto';

import pg from 'pg';

import type { FarmledgeEnvironment } from '../../src/config/index.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Tests never touch a real database. Each suite creates its own throwaway
 * `farmledge_test_*` database on the server at TEST_DATABASE_URL and drops
 * it afterwards. The default matches docker-compose.yml.
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_ADMIN_URL ??
  'postgresql://farmledge:farmledge@localhost:5433/postgres';
const PREFIX = 'farmledge_test_';

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `${PREFIX}${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name}`));

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;

  return {
    name,
    url: url.toString(),
    drop: () =>
      withAdmin(async (admin) => {
        // A pool's end() can resolve before Postgres has closed its backends;
        // forcing the drop then kills them and the client reports 57P01 as an
        // unhandled error. Wait (briefly) for them to go; FORCE stays as backstop.
        for (let i = 0; i < 100; i++) {
          const { rows } = await admin.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
            [name],
          );
          if ((rows[0]?.n ?? 0) === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }),
  };
}

/** A throwaway database, already migrated and stamped with `environment`. */
export async function createMigratedDatabase(
  environment: FarmledgeEnvironment,
): Promise<TestDatabase> {
  const db = await createTestDatabase();
  await runMigrations({ databaseUrl: db.url, environment, direction: 'up' });
  return db;
}
