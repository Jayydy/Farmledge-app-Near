import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type express from 'express';
import pg from 'pg';
import request from 'supertest';

import { createAdapters, type Adapters } from '../../src/adapters.js';
import type { ChainClient } from '../../src/chain/chainClient.js';
import type { Config } from '../../src/config/index.js';
import { createApp } from '../../src/http/app.js';
import { createLogger } from '../../src/logger.js';
import { AlertService } from '../../src/services/alerts.js';
import { AnchoringService } from '../../src/services/anchoring.js';
import { assertChainDeployment } from '../../src/services/chainDeployment.js';
import { IndexerService } from '../../src/services/indexer.js';
import { KeepAliveService } from '../../src/services/keepAlive.js';
import { PledgeService } from '../../src/services/pledges.js';
import { ProofService } from '../../src/services/proofs.js';
import { ReconciliationService } from '../../src/services/reconciliation.js';
import { MockSmsGateway } from '../../src/sms/mockSmsGateway.js';
import { LocalDiskPhotoStore } from '../../src/storage/localDiskPhotoStore.js';
import { loadFixtures, type Fixtures } from '../fixtures/index.js';
import { depositBody, dispatchBody } from './api.js';
import { testConfig } from './env.js';
import { FakeChain, FakeNearChain, FAKE_NEAR_CONTRACT } from './fakeChain.js';
import { createMigratedDatabase, type TestDatabase } from './testDatabase.js';

const DAY_MS = 86_400_000;

/** A mutable clock all services share, so a test can walk through days. */
export class TestClock {
  constructor(private at: Date) {}
  now = (): Date => new Date(this.at);
  set(at: Date): void {
    this.at = new Date(at);
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}

/** Midday UTC of day `day`. */
export const middayOf = (day: number) => new Date(day * DAY_MS + 12 * 3_600_000);

export interface ChainHarness {
  app: express.Express;
  pool: pg.Pool;
  fixtures: Fixtures;
  config: Config;
  adapters: Adapters;
  clock: TestClock;
  chain: ChainClient;
  sms: MockSmsGateway;
  alerts: AlertService;
  anchoring: AnchoringService;
  pledges: PledgeService;
  proofs: ProofService;
  indexer: IndexerService;
  keepAlive: KeepAliveService;
  reconciliation: ReconciliationService;
  /** A scale lot of `bags` bags, every bag weighed at 5 kg under the estimate, recorded at the clock's time. */
  scaleLot(bags?: number): Promise<{ depositId: string; depositNo: number }>;
  dispatch(overrides?: Record<string, unknown>): Promise<request.Response>;
  close(): Promise<void>;
}

/**
 * The real app and the data_version 3 services against a throwaway test
 * database, with `chain` (a FakeChain unless given) as the contract.
 */
export async function startChainHarness(options: {
  start: Date;
  backend?: 'stellar' | 'near';
  chain?: (h: { adapters: Adapters; clock: TestClock }) => ChainClient;
  env?: Record<string, string>;
  /**
   * When the contract registered each fixture warehouse (an archived
   * warehouse_added): `start` unless given, null for never. Only with the
   * default FakeChain.
   */
  onChain?: Partial<Record<'warehouseId' | 'otherWarehouseId', Date | null>>;
}): Promise<ChainHarness> {
  const db: TestDatabase = await createMigratedDatabase('test');
  const pool = new pg.Pool({ connectionString: db.url, max: 20 });
  const client = await pool.connect();
  let fixtures: Fixtures;
  try {
    fixtures = await loadFixtures(client);
    // The warehouses are registered here when the test's story starts.
    await client.query('UPDATE warehouses SET created_at = $1', [options.start]);
  } finally {
    client.release();
  }
  const photoDir = await mkdtemp(path.join(tmpdir(), 'farmledge-photos-'));
  const isNear = options.backend === 'near' || options.env?.CHAIN_BACKEND === 'near';
  const config = testConfig(db.url, 'test', {
    WEIGHT_MODE: 'scale_required',
    LENDING_ENABLED: 'true',
    // Lending on means receipts carry claims: paper release authority is refused (D56).
    RELEASE_AUTHORITY: 'farmledge',
    ...(isNear
      ? {
          CHAIN_BACKEND: 'near',
          NEAR_NETWORK: 'testnet',
          NEAR_RPC_URL: 'https://rpc.testnet.near.org',
          NEAR_CONTRACT_ID: FAKE_NEAR_CONTRACT,
          NEAR_CONTRACT_START_BLOCK: '4917586',
        }
      : {}),
    ...options.env,
  });
  const logger = createLogger('silent');
  const clock = new TestClock(options.start);
  const sms = new MockSmsGateway(logger);
  const base = createAdapters(config, pool, logger);
  const chain =
    options.chain?.({ adapters: base, clock }) ??
    (isNear ? new FakeNearChain(base.keys, clock.now) : new FakeChain(base.keys, clock.now));
  const adapters: Adapters = { ...base, sms, chain };
  const configForChain = {
    ...config,
    chain: {
      ...config.chain,
      backend: chain.backend,
      contractId: chain.contractId,
      networkId: chain.networkId,
      networkPassphrase: chain.networkPassphrase,
    },
  };
  await assertChainDeployment(pool, configForChain);
  if (options.chain === undefined) {
    // ... and on the contract, from when their books are anchored (D53).
    for (const key of ['warehouseId', 'otherWarehouseId'] as const) {
      const at = options.onChain?.[key] === undefined ? options.start : options.onChain[key];
      if (at !== null) await archiveWarehouseAdded(pool, chain.contractId, fixtures[key], at);
    }
  }

  const alerts = new AlertService(pool, logger, clock.now);
  const app = createApp({
    config,
    db: pool,
    logger,
    photoStore: new LocalDiskPhotoStore(photoDir),
    adapters,
    clock: clock.now,
  });
  const harness: ChainHarness = {
    app,
    pool,
    fixtures,
    config,
    adapters,
    clock,
    chain,
    sms,
    alerts,
    anchoring: new AnchoringService(pool, chain, base.keys, alerts, logger, clock.now),
    pledges: new PledgeService(
      pool,
      chain,
      base.keys,
      base.confirmation,
      alerts,
      logger,
      clock.now,
    ),
    proofs: new ProofService(pool, chain, sms, config, alerts, logger, clock.now),
    indexer: new IndexerService(pool, chain, alerts, logger, config.chain.startLedger),
    keepAlive: new KeepAliveService(pool, chain, alerts, logger, clock.now),
    reconciliation: new ReconciliationService(pool, chain, alerts),
    async scaleLot(bags = 20) {
      const body = depositBody(fixtures, { bag_count: bags });
      const res = await request(app).post('/deposits').send(body);
      if (res.status !== 201)
        throw new Error(`deposit failed: ${res.status} ${JSON.stringify(res.body)}`);
      const sample = await request(app)
        .post(`/deposits/${body.deposit_id}/scale-samples`)
        .send({ bags_weighed: bags, total_kg: bags * 100 - 5, recorded_by: fixtures.custodianId });
      if (sample.status !== 201)
        throw new Error(`scale sample failed: ${JSON.stringify(sample.body)}`);
      const deposit = res.body as { deposit: { deposit_no: number } };
      return { depositId: body.deposit_id, depositNo: deposit.deposit.deposit_no };
    },
    dispatch(overrides = {}) {
      return request(app).post('/dispatches').send(dispatchBody(fixtures, overrides));
    },
    async close() {
      await pool.end();
      await db.drop();
      await rm(photoDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/**
 * Archives the contract's warehouse_added for a warehouse, as the indexer
 * would: the registration its books are anchored from (D53).
 */
export async function archiveWarehouseAdded(
  pool: pg.Pool,
  contractId: string,
  warehouseId: string,
  at: Date,
): Promise<void> {
  const { rows } = await pool.query<{ code: string }>('SELECT code FROM warehouses WHERE id = $1', [
    warehouseId,
  ]);
  const symbol = (rows[0]?.code ?? '').replaceAll('-', '_');
  const eventId = `warehouse_added:${contractId}:${symbol}:${at.getTime()}`;
  await pool.query(
    `INSERT INTO events_archive (event_id, contract_id, ledger, ledger_closed_at, tx_hash, tx_index,
                                 op_index, event_index, event_type, topics, value, topic_xdr,
                                 value_xdr, in_successful_contract_call)
     VALUES ($1, $2, 1, $3, $4, 0, 0, 0, 'warehouse_added', $5, $6, '{}', '', true)`,
    [
      eventId,
      contractId,
      at,
      createHash('sha256').update(eventId).digest('hex'),
      JSON.stringify(['warehouse_added', symbol]),
      JSON.stringify({ warehouse_id: symbol, added_at: String(Math.floor(at.getTime() / 1000)) }),
    ],
  );
}
