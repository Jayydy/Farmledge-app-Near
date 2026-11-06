import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertDatabaseEnvironment,
  DatabaseNotInitialisedError,
  EnvironmentMismatchError,
  readDatabaseEnvironment,
} from '../src/db/environmentGuard.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { startServer } from '../src/server.js';
import { loadFixtures } from './fixtures/index.js';
import { testConfig } from './helpers/env.js';
import {
  createMigratedDatabase,
  createTestDatabase,
  type TestDatabase,
} from './helpers/testDatabase.js';

const logger = createLogger('silent');

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('environment guard', () => {
  let testDb: TestDatabase;
  // A throwaway database stamped `live`, standing in for a real live database.
  let liveDb: TestDatabase;
  let blankDb: TestDatabase;

  beforeAll(async () => {
    [testDb, liveDb, blankDb] = await Promise.all([
      createMigratedDatabase('test'),
      createMigratedDatabase('live'),
      createTestDatabase(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([testDb.drop(), liveDb.drop(), blankDb.drop()]);
  });

  it('accepts a database that matches the configured environment', async () => {
    await withClient(testDb.url, async (client) => {
      await expect(assertDatabaseEnvironment(client, 'test')).resolves.toBeUndefined();
    });
    await withClient(liveDb.url, async (client) => {
      await expect(assertDatabaseEnvironment(client, 'live')).resolves.toBeUndefined();
    });
  });

  it('blocks a test config against a live database', async () => {
    await withClient(liveDb.url, async (client) => {
      const check = assertDatabaseEnvironment(client, 'test');
      await expect(check).rejects.toBeInstanceOf(EnvironmentMismatchError);
      await expect(check).rejects.toMatchObject({ expected: 'test', actual: 'live' });
    });
  });

  it('blocks a live config against a test database', async () => {
    await withClient(testDb.url, async (client) => {
      await expect(assertDatabaseEnvironment(client, 'live')).rejects.toMatchObject({
        name: 'EnvironmentMismatchError',
        expected: 'live',
        actual: 'test',
      });
    });
  });

  it('blocks a database that has never been migrated', async () => {
    await withClient(blankDb.url, async (client) => {
      await expect(assertDatabaseEnvironment(client, 'test')).rejects.toBeInstanceOf(
        DatabaseNotInitialisedError,
      );
    });
  });

  describe('startServer', () => {
    it('refuses to start with a test config against a live database', async () => {
      await expect(startServer(testConfig(liveDb.url, 'test'), logger)).rejects.toBeInstanceOf(
        EnvironmentMismatchError,
      );
    });

    it('refuses to start with a live config against a test database', async () => {
      await expect(startServer(testConfig(testDb.url, 'live'), logger)).rejects.toBeInstanceOf(
        EnvironmentMismatchError,
      );
    });

    it('refuses to start against an unmigrated database', async () => {
      await expect(startServer(testConfig(blankDb.url, 'test'), logger)).rejects.toBeInstanceOf(
        DatabaseNotInitialisedError,
      );
    });
  });

  describe('migrations', () => {
    it('refuses to migrate a live database with a test config', async () => {
      await expect(
        runMigrations({ databaseUrl: liveDb.url, environment: 'test', direction: 'up' }),
      ).rejects.toBeInstanceOf(EnvironmentMismatchError);
    });

    it('refuses to migrate a test database with a live config', async () => {
      await expect(
        runMigrations({ databaseUrl: testDb.url, environment: 'live', direction: 'up' }),
      ).rejects.toBeInstanceOf(EnvironmentMismatchError);
      await withClient(testDb.url, async (client) => {
        expect(await readDatabaseEnvironment(client)).toBe('test');
      });
    });

    it('refuses to roll back a live database', async () => {
      await expect(
        runMigrations({ databaseUrl: liveDb.url, environment: 'live', direction: 'down' }),
      ).rejects.toThrow('Refusing to roll back a live database');
    });
  });

  it('refuses to load test fixtures into a live database', async () => {
    await withClient(liveDb.url, async (client) => {
      await expect(loadFixtures(client)).rejects.toThrow(
        'Refusing to load fixtures into a live database',
      );
      const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM farmers');
      expect(rows[0]?.count).toBe('0');
    });
  });
});
