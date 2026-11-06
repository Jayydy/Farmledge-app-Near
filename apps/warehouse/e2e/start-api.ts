/**
 * Starts the real API for the end-to-end tests: a throwaway `test`
 * database (created on TEST_DATABASE_URL's server, as the API's own tests
 * do), migrated with the API's migrations, seeded from scripts/seed-dev.sql,
 * with the demo custodian's PIN set through the API's own `set-pin` CLI.
 * The API runs with AUTH_REQUIRED=true. Dropped again on exit.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

import pg from 'pg';

import { E2E, STATE_FILE } from './env';

const REPO = path.resolve(import.meta.dirname, '../../..');
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://farmledge:farmledge@localhost:5433/postgres';
const name = `farmledge_e2e_${Date.now().toString(36)}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${name}`;
const photoDir = mkdtempSync(path.join(tmpdir(), 'farmledge-e2e-photos-'));

async function admin(sql: string) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const env = {
  ...process.env,
  ...parseEnv(readFileSync(path.join(REPO, '.env.example'), 'utf8')),
  FARMLEDGE_ENV: 'test',
  DATABASE_URL: url.toString(),
  PORT: String(E2E.apiPort),
  LOG_LEVEL: 'warn',
  AUTH_REQUIRED: 'true',
  PHOTO_STORAGE_DIR: photoDir,
};

function run(args: string[], input?: string) {
  const result = spawnSync('npm', ['run', '--silent', ...args], {
    cwd: REPO,
    env,
    input,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`npm run ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`);
}

await admin(`CREATE DATABASE ${name}`);
let api: ReturnType<typeof spawn> | undefined;
const cleanup = async () => {
  api?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  rmSync(photoDir, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(0));
  });
}

try {
  run(['migrate']);
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(readFileSync(path.join(import.meta.dirname, '../scripts/seed-dev.sql'), 'utf8'));
  await db.end();
  run(['set-pin', '--', `--phone=${E2E.custodianPhone}`], `${E2E.pin}\n`);
  writeFileSync(STATE_FILE, JSON.stringify({ databaseUrl: url.toString() }));
  api = spawn('npx', ['tsx', 'src/main.ts'], { cwd: REPO, env, stdio: 'inherit' });
  api.on('exit', (code) => {
    console.error(`API exited (${code})`);
    void cleanup().finally(() => process.exit(code ?? 1));
  });
} catch (err) {
  console.error(err);
  await cleanup();
  process.exit(1);
}
