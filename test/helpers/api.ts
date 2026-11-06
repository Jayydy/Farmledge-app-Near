import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type express from 'express';
import pg from 'pg';

import { createAdapters, type Adapters } from '../../src/adapters.js';
import type { Config } from '../../src/config/index.js';
import { createApp } from '../../src/http/app.js';
import { createLogger } from '../../src/logger.js';
import { MockSmsGateway } from '../../src/sms/mockSmsGateway.js';
import { LocalDiskPhotoStore } from '../../src/storage/localDiskPhotoStore.js';
import { loadFixtures, type Fixtures } from '../fixtures/index.js';
import { testConfig } from './env.js';
import { createMigratedDatabase, type TestDatabase } from './testDatabase.js';

export interface TestApi {
  app: express.Express;
  pool: pg.Pool;
  fixtures: Fixtures;
  photoDir: string;
  config: Config;
  adapters: Adapters;
  /** Every SMS the app "sent". */
  sms: MockSmsGateway;
  close(): Promise<void>;
}

export interface TestApiOptions {
  /** Environment variable overrides, e.g. `{ LENDING_ENABLED: 'true' }`. */
  env?: Record<string, string>;
  /** Pins the app's "now". */
  clock?: () => Date;
}

/**
 * The real app against a throwaway migrated `test` database with fixtures
 * loaded, and photos stored in a temporary directory.
 */
export async function startTestApi(options: TestApiOptions = {}): Promise<TestApi> {
  const db: TestDatabase = await createMigratedDatabase('test');
  const pool = new pg.Pool({ connectionString: db.url, max: 20 });
  const client = await pool.connect();
  let fixtures: Fixtures;
  try {
    fixtures = await loadFixtures(client);
  } finally {
    client.release();
  }
  const photoDir = await mkdtemp(path.join(tmpdir(), 'farmledge-photos-'));
  const config = testConfig(db.url, 'test', options.env);
  const logger = createLogger('silent');
  const sms = new MockSmsGateway(logger);
  const adapters = { ...createAdapters(config, pool, logger), sms };
  const app = createApp({
    config,
    db: pool,
    logger,
    photoStore: new LocalDiskPhotoStore(photoDir),
    adapters,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  return {
    app,
    pool,
    fixtures,
    photoDir,
    config,
    adapters,
    sms,
    close: async () => {
      await pool.end();
      await db.drop();
      await rm(photoDir, { recursive: true, force: true });
    },
  };
}

/** A valid POST /deposits body; override any field. */
export function depositBody(
  fixtures: Fixtures,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { deposit_id: string } {
  return {
    deposit_id: randomUUID(),
    farmer_id: fixtures.farmerId,
    warehouse_id: fixtures.warehouseId,
    custodian_id: fixtures.custodianId,
    verifier_id: fixtures.verifierId,
    commodity: 'MAIZE_WHITE',
    grade: 1,
    moisture_pct: 12.5,
    bag_count: 20,
    ...overrides,
  };
}

/** A valid POST /dispatches body; override any field. */
export function dispatchBody(
  fixtures: Fixtures,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { dispatch_id: string } {
  return {
    dispatch_id: randomUUID(),
    warehouse_id: fixtures.warehouseId,
    farmer_id: fixtures.farmerId,
    custodian_id: fixtures.custodianId,
    commodity: 'MAIZE_WHITE',
    grade: '1',
    bag_count: 5,
    farmer_confirmed: true,
    // Unweighed unless a test weighs it: then the reason must be left out (D54).
    ...(overrides.exit_weight_kg === undefined || overrides.exit_weight_kg === null
      ? { not_weighed_reason: 'No scale at this warehouse' }
      : {}),
    ...overrides,
  };
}

/** A valid POST /adjustments body; override any field. */
export function adjustmentBody(
  fixtures: Fixtures,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { adjustment_id: string } {
  return {
    adjustment_id: randomUUID(),
    warehouse_id: fixtures.warehouseId,
    farmer_id: fixtures.farmerId,
    commodity: 'MAIZE_WHITE',
    grade: '1',
    bags_delta: -1,
    kg_delta: -100,
    reason_code: 'spoilage',
    notes: 'Rat damage in bay 3',
    recorded_by: fixtures.custodianId,
    authorised_by: fixtures.verifierId,
    ...overrides,
  };
}
