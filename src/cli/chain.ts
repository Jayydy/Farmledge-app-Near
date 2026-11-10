import path from 'node:path';

import type pg from 'pg';

import { createAdapters } from '../adapters.js';
import { addressFor, OPERATOR_SUBJECT, subjectOf } from '../chain/addresses.js';
import type { ChainClient } from '../chain/chainClient.js';
import { NearChainClient } from '../chain/nearChainClient.js';
import { loadConfig, type Config } from '../config/index.js';
import { assertDatabaseEnvironment } from '../db/environmentGuard.js';
import { createPool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { warehouseSymbol } from '../domain/book.js';
import type { KeyService } from '../keys/keyService.js';
import { createLogger, type Logger } from '../logger.js';
import { AlertService } from '../services/alerts.js';
import { AnchoringService } from '../services/anchoring.js';
import { backup, verifyBackup } from '../services/archiveBackup.js';
import {
  assertChainDeployment,
  detectReset,
  RESET_ALERT_KEY,
} from '../services/chainDeployment.js';
import { IndexerService } from '../services/indexer.js';
import { indexJob } from '../services/jobs.js';
import { KeepAliveService } from '../services/keepAlive.js';
import { PledgeService } from '../services/pledges.js';
import { ProofService } from '../services/proofs.js';
import { ReconciliationService } from '../services/reconciliation.js';

/**
 * `npm run chain -- <job>`: the data_version 3 jobs, each run from cron.
 *
 *   index           every 5 min: archive new events, the A6 mint reconciliation, the
 *                   missed-anchor check (urgent at 2 h), and an hourly anchor retry
 *   anchor          daily after 00:00 UTC: close and anchor each warehouse's days, in order
 *   proofs          hourly: deliver bundles, issue statements, retry, alert on late ones
 *   keepalive       daily: extend_ttl_batch for live receipts; alert at 14 days of TTL
 *   resolve-pending every 5 min, and at startup: settle mints left pending by a crash
 *   verify-archive  after any outage, and daily: gap check, re-fetch, reconcile
 *   detect-reset    every 5 min on Testnet: stop all writers if the contract vanished
 *   backup          daily: archive + books to ARCHIVE_BACKUP_DIR, then verify the copy
 *   rebuild         rebuild projections from the archive
 *   setup [--fund]  print the addresses to register on-chain; --fund: Friendbot (Testnet)
 *   reset --contract=C… --start-ledger=N --confirm   README "After a Testnet reset", steps 3-7
 */
const [job, ...args] = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.database.url, logger);
  try {
    await assertDatabaseEnvironment(pool, config.environment);
    if (job === 'reset') {
      await reset(pool, config, logger);
      return;
    }
    const adapters = createAdapters(config, pool, logger);
    if (job === 'setup') {
      await setup(pool, adapters.keys, config, args.includes('--fund'), adapters.chain);
      return;
    }
    if (!config.features.chainEnabled)
      throw new Error('CHAIN_ENABLED=false: the chain jobs need the contract');
    await assertChainDeployment(pool, config);
    const alerts = new AlertService(pool, logger);
    const chain = adapters.chain;
    const indexer = new IndexerService(pool, chain, alerts, logger, config.chain.startLedger);
    const reconciliation = new ReconciliationService(pool, chain, alerts);
    switch (job) {
      case 'index': {
        const anchoring = new AnchoringService(pool, chain, adapters.keys, alerts, logger);
        console.log(JSON.stringify(await indexJob({ indexer, reconciliation, anchoring })));
        return;
      }
      case 'anchor': {
        const reports = await new AnchoringService(
          pool,
          chain,
          adapters.keys,
          alerts,
          logger,
        ).runDaily();
        await indexer.ingest();
        const findings = await reconciliation.checkMints();
        console.log(JSON.stringify({ reports, mint_findings: findings.length }));
        return;
      }
      case 'proofs': {
        // The real SMS adapter is chosen in createAdapters; the jobs use the same one.
        const proofs = new ProofService(pool, chain, adapters.sms, config, alerts, logger);
        const delivered = await proofs.deliverAnchored();
        const statements = await proofs.issueStatements();
        await proofs.sendQueued();
        await proofs.checkDeliveries();
        console.log(JSON.stringify({ delivered, statements }));
        return;
      }
      case 'keepalive':
        console.log(JSON.stringify(await new KeepAliveService(pool, chain, alerts, logger).run()));
        return;
      case 'resolve-pending':
        await new PledgeService(
          pool,
          chain,
          adapters.keys,
          adapters.confirmation,
          alerts,
          logger,
        ).resolvePending();
        return;
      case 'verify-archive':
        console.log(JSON.stringify(await indexer.verifyNoGaps()));
        return;
      case 'detect-reset':
        console.log(JSON.stringify(await detectReset(chain, config, alerts)));
        return;
      case 'backup': {
        const dir = path.resolve(config.archive.backupDir, config.environment);
        const manifest = await backup(pool, dir, new Date());
        const problems = await verifyBackup(dir, manifest);
        if (problems.length > 0) {
          await alerts.raise({
            key: `backup_unverified:${manifest.file}`,
            severity: 'page',
            category: 'backup',
            message: 'The archive backup did not verify',
            details: { problems },
          });
          throw new Error(`backup did not verify: ${problems.join('; ')}`);
        }
        console.log(JSON.stringify(manifest));
        return;
      }
      case 'rebuild':
        console.log(JSON.stringify({ replayed: await indexer.rebuild() }));
        return;
      case 'near:deploy-check': {
        const exists = await chain.instanceExists();
        const latest = await chain.latestLedger();
        console.log(
          JSON.stringify({
            backend: chain.backend,
            contract_id: chain.contractId,
            network_id: chain.networkId,
            instance_exists: exists,
            latest_block: latest.sequence,
          }),
        );
        if (!exists) throw new Error(`contract ${chain.contractId} does not exist on ${chain.networkId}`);
        return;
      }
      case 'near:fund-subjects':
        await setup(pool, adapters.keys, config, true, chain);
        return;
      default:
        console.error(
          'Usage: chain <index|anchor|proofs|keepalive|resolve-pending|verify-archive|detect-reset|backup|rebuild|setup|reset|near:deploy-check|near:fund-subjects>',
        );
        process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

/** Prints what the protocol admin must register; with --fund, creates the accounts on Testnet. */
async function setup(
  pool: pg.Pool,
  keys: KeyService,
  config: Config,
  fund: boolean,
  chain?: ChainClient,
): Promise<void> {
  const backend = config.chain.backend;
  const operator = await addressFor(keys, OPERATOR_SUBJECT, backend);
  const warehouses = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM warehouses WHERE status = 'active' ORDER BY code`,
  );
  const lines: string[] = [`operator (submits and pays): ${operator}`];
  const toFund = [operator];
  const subjects = [OPERATOR_SUBJECT];
  for (const w of warehouses.rows) {
    lines.push(`add_warehouse ${warehouseSymbol(w.code)}`);
    const custodians = await pool.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM custodians WHERE warehouse_id = $1 AND status = 'active' ORDER BY created_at`,
      [w.id],
    );
    for (const c of custodians.rows) {
      const subject = subjectOf.custodian(c.id);
      const address = await addressFor(keys, subject, backend);
      lines.push(`  add_custodian ${warehouseSymbol(w.code)} ${address}   (${c.full_name})`);
      toFund.push(address);
      subjects.push(subject);
    }
  }
  const verifiers = await pool.query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM verifiers WHERE status = 'active' ORDER BY created_at`,
  );
  for (const v of verifiers.rows) {
    const subject = subjectOf.verifier(v.id);
    const address = await addressFor(keys, subject, backend);
    lines.push(`add_verifier ${address}   (${v.full_name})`);
    toFund.push(address);
    subjects.push(subject);
  }
  const farmers = await pool.query<{ id: string }>('SELECT id FROM farmers ORDER BY created_at');
  for (const f of farmers.rows) {
    const subject = subjectOf.farmer(f.id);
    toFund.push(await addressFor(keys, subject, backend));
    subjects.push(subject);
  }
  console.log(`Contract ${config.chain.contractId}\n${lines.join('\n')}`);
  if (fund) {
    if (backend === 'near') {
      if (!(chain instanceof NearChainClient)) {
        throw new Error('NEAR subject funding requires CHAIN_ENABLED=true and NearChainClient');
      }
      for (const subject of subjects) {
        if (subject === OPERATOR_SUBJECT) continue;
        const res = await chain.fundSubject(subject);
        console.log(
          `near ${res.subject} (${res.accountId}): ${res.funded ? 'funded' : 'already funded / skipped'}`,
        );
      }
      return;
    }
    if (!/Test SDF/.test(config.chain.networkPassphrase))
      throw new Error('--fund is for Testnet only');
    for (const address of toFund) {
      let status = 0;
      for (let attempt = 1; attempt <= 5 && status !== 200 && status !== 400; attempt++) {
        status = await fetch(`https://friendbot.stellar.org/?addr=${address}`).then(
          (res) => res.status,
          () => 0,
        );
        if (status !== 200 && status !== 400) {
          await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
        }
      }
      // 400: the account already exists.
      console.log(
        `friendbot ${address}: ${status === 200 || status === 400 ? 'funded' : `failed (${String(status)})`}`,
      );
    }
  }
}

/**
 * README "What the backend must do after a reset", steps 3-7, once protocol
 * ops have redeployed (step 2): bind the database to the new contract,
 * retire the old one, and lift the halt. The event archive of the old
 * contract is kept (events.md: never prune; see docs/decisions.md D38).
 * The indexer starts at the new start ledger, the keep-alive list is the new
 * contract's (empty until it mints), and the books are re-anchored on the
 * new contract from the database by the next `anchor` run, a fresh chain
 * per warehouse. Nothing is re-minted (step 8). Re-fund keys with `setup --fund`.
 */
async function reset(pool: pg.Pool, config: Config, logger: Logger): Promise<void> {
  const contract = flag('contract');
  const startLedger = Number(flag('start-ledger'));
  if (contract === undefined || !Number.isSafeInteger(startLedger) || !args.includes('--confirm')) {
    throw new Error('Usage: chain reset --contract=<id> --start-ledger=N --confirm');
  }
  if (config.chain.contractId !== contract || config.chain.startLedger !== startLedger) {
    const vars =
      config.chain.backend === 'near'
        ? 'NEAR_CONTRACT_ID and NEAR_CONTRACT_START_BLOCK'
        : 'RECEIPT_CONTRACT_ID and RECEIPT_CONTRACT_START_LEDGER';
    throw new Error(`set ${vars} to the new deployment first`);
  }
  const adapters = createAdapters(config, pool, logger);
  if (!(await adapters.chain.instanceExists())) {
    throw new Error(`contract ${contract} does not exist on ${config.chain.networkId}`);
  }
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE chain_deployments SET status = 'retired', retired_at = now(),
              retired_reason = 'Testnet reset: replaced by ' || $1
        WHERE status = 'current' AND contract_id <> $1`,
      [contract],
    );
    await client.query(
      `INSERT INTO chain_deployments (chain, contract_id, network_passphrase, rpc_url, start_ledger, status)
       VALUES ($1, $2, $3, $4, $5, 'current')
       ON CONFLICT (contract_id) DO NOTHING`,
      [config.chain.backend, contract, config.chain.networkId, config.chain.rpcUrl, startLedger],
    );
    await client.query(
      `INSERT INTO indexer_cursors (contract_id, start_ledger, cursor_ledger)
       VALUES ($1, $2::bigint, $2::bigint - 1) ON CONFLICT (contract_id) DO NOTHING`,
      [contract, startLedger],
    );
    await client.query(
      'UPDATE alerts SET resolved_at = now() WHERE alert_key = $1 AND resolved_at IS NULL',
      [RESET_ALERT_KEY],
    );
  });
  console.log(
    `Bound to ${contract} from ledger ${startLedger}. Next: chain setup --fund, register roles, chain anchor.`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
