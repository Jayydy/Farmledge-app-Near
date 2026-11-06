import http from 'node:http';
import type { AddressInfo } from 'node:net';

import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { startServer, type RunningServer } from '../src/server.js';
import { testConfig } from './helpers/env.js';
import type { ErrorBody } from './helpers/http.js';
import { createMigratedDatabase, type TestDatabase } from './helpers/testDatabase.js';

const logger = createLogger('silent');

describe('HTTP server', () => {
  let db: TestDatabase;
  let running: RunningServer;

  beforeAll(async () => {
    db = await createMigratedDatabase('test');
    running = await startServer(testConfig(db.url, 'test'), logger);
  });

  afterAll(async () => {
    await running.stop();
    await db.drop();
  });

  it('reports healthy when the database is reachable and matches', async () => {
    const res = await request(running.server).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', environment: 'test', database: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('assigns a request ID, or reuses a well-formed incoming one', async () => {
    const generated = await request(running.server).get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const reused = await request(running.server).get('/health').set('X-Request-Id', 'tablet-42');
    expect(reused.headers['x-request-id']).toBe('tablet-42');
  });

  it('returns a typed 404 for unknown routes', async () => {
    const res = await request(running.server).get('/nope').set('X-Request-Id', 'req-404');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'not_found', message: 'No route for GET /nope' },
      requestId: 'req-404',
    });
  });

  it('returns a typed 400 for malformed JSON', async () => {
    const res = await request(running.server)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toEqual({
      code: 'validation_failed',
      message: 'Request body is not valid JSON',
    });
  });
});

describe('health check without a database', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    // Nothing listens on port 1, so every query fails fast.
    pool = new pg.Pool({
      connectionString: 'postgresql://farmledge:farmledge@127.0.0.1:1/farmledge',
      connectionTimeoutMillis: 1_000,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reports 503 when the database is unreachable', async () => {
    const config = testConfig('postgresql://farmledge:farmledge@127.0.0.1:1/farmledge', 'test');
    const photoStore = { put: () => Promise.resolve(), get: () => Promise.resolve(null) };
    const app = createApp({ config, db: pool, logger, photoStore });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect((res.body as ErrorBody).error).toEqual({
      code: 'service_unavailable',
      message: 'Database is unreachable',
    });
  });
});

describe('graceful shutdown', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedDatabase('test');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('closes the server and the pool, and is safe to call twice', async () => {
    const running = await startServer(testConfig(db.url, 'test'), logger);
    await request(running.server).get('/health').expect(200);

    await Promise.all([running.stop(), running.stop()]);

    expect(running.server.listening).toBe(false);
    expect(running.pool.ended).toBe(true);
  });

  it('lets an in-flight request finish before closing', async () => {
    const running = await startServer(testConfig(db.url, 'test'), logger);
    const address = running.server.address() as AddressInfo;

    // Lock db_environment from another session so /health blocks mid-request.
    const locker = new pg.Client({ connectionString: db.url });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE db_environment IN ACCESS EXCLUSIVE MODE');

    const response = fetch(`http://127.0.0.1:${address.port}/health`);
    await waitForLockWaiter(locker);

    const stopped = running.stop();
    let stopSettled = false;
    void stopped.then(() => (stopSettled = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopSettled).toBe(false);

    await locker.query('COMMIT');
    await locker.end();

    expect((await response).status).toBe(200);
    await stopped;
    expect(running.server.listening).toBe(false);
  });

  it('does not wait for idle keep-alive connections', async () => {
    const running = await startServer(testConfig(db.url, 'test'), logger);
    const address = running.server.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true });

    await new Promise<void>((resolve, reject) => {
      http
        .get({ port: address.port, path: '/health', agent }, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });

    const started = Date.now();
    await running.stop();
    agent.destroy();
    // Well under SHUTDOWN_TIMEOUT_MS (2000 in tests): the idle socket was closed straight away.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

async function waitForLockWaiter(observer: pg.Client): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { rows } = await observer.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_locks
       WHERE NOT granted AND relation = 'db_environment'::regclass`,
    );
    if (rows[0]?.waiting !== '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('health query never blocked on the lock');
}
