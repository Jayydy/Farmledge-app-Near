import type pg from 'pg';

import type { ChainClient } from '../chain/chainClient.js';
import type { Config } from '../config/index.js';
import type { Queryable } from '../db/pool.js';
import { warehouseSymbol } from '../domain/book.js';
import type { AlertService } from './alerts.js';
import { archiveCoverage } from './indexer.js';

/** Open while a Testnet reset (or a vanished contract) is unresolved: every chain writer stops. */
export const RESET_ALERT_KEY = 'chain_reset_detected';

export class ChainDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainDeploymentError';
  }
}

/**
 * README "After a Testnet reset", step 3: the application refuses to start
 * against a contract id it was not configured for. The first start records
 * the configured deployment; a different contract id afterwards needs the
 * reset procedure (`npm run chain-reset`), never just an edited .env.
 */
export async function assertChainDeployment(db: Queryable, config: Config): Promise<void> {
  const { rows } = await db.query<{
    contract_id: string;
    network_passphrase: string;
    rpc_url: string;
  }>(
    `SELECT contract_id, network_passphrase, rpc_url FROM chain_deployments WHERE status = 'current'`,
  );
  const current = rows[0];
  if (current === undefined) {
    await db.query(
      `INSERT INTO chain_deployments (contract_id, network_passphrase, rpc_url, start_ledger, status)
       VALUES ($1, $2, $3, $4, 'current')`,
      [
        config.chain.contractId,
        config.chain.networkPassphrase,
        config.chain.rpcUrl,
        config.chain.startLedger,
      ],
    );
    return;
  }
  if (
    current.contract_id !== config.chain.contractId ||
    current.network_passphrase !== config.chain.networkPassphrase
  ) {
    throw new ChainDeploymentError(
      `this database is bound to contract ${current.contract_id} on "${current.network_passphrase}", ` +
        `but RECEIPT_CONTRACT_ID is ${config.chain.contractId}; switch contracts with npm run chain-reset`,
    );
  }
}

/** True while a reset is unresolved; anchor, mint, lock and keep-alive jobs check it first. */
export async function chainHalted(db: Queryable): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM alerts WHERE alert_key = $1 AND resolved_at IS NULL',
    [RESET_ALERT_KEY],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * README step 1: detect a reset. The contract instance is gone, or the
 * network's latest ledger is far below the deployment's start ledger.
 * Either one halts every writer until the reset procedure has run.
 */
export async function detectReset(
  chain: ChainClient,
  config: Config,
  alerts: AlertService,
): Promise<{ reset: boolean; reason: string | null }> {
  const latest = await chain.latestLedger();
  let reason: string | null = null;
  if (latest.sequence < config.chain.startLedger) {
    reason = `the network's latest ledger ${latest.sequence} is below the deployment's start ledger ${config.chain.startLedger}`;
  } else if (!(await chain.instanceExists())) {
    reason = `the contract instance ${config.chain.contractId} no longer exists`;
  }
  if (reason === null) return { reset: false, reason: null };
  await alerts.raise({
    key: RESET_ALERT_KEY,
    severity: 'urgent',
    category: 'chain',
    message: `Testnet reset detected: ${reason}. Anchor, mint, lock and keep-alive are stopped; follow the README reset procedure.`,
    details: { contract_id: config.chain.contractId, latest_ledger: latest.sequence },
  });
  return { reset: true, reason };
}

/**
 * INV-2: the pre-claim gate. A mint for `warehouseId` may proceed only if
 * its gate row on the current contract says `verified`, with the time it
 * was verified. There is no other open state: "nothing to claim" is a
 * verification too (protocol #10). A missing row is a closed gate. This is
 * the only place the rule is checked.
 */
export async function preclaimGateOpen(
  db: Queryable,
  contractId: string,
  warehouseId: string,
): Promise<{ open: boolean; reason: string }> {
  const { rows } = await db.query<{ status: string | null; verified_at: Date | null }>(
    `SELECT g.status, g.verified_at
       FROM chain_deployments d
       LEFT JOIN preclaim_gates g ON g.contract_id = d.contract_id AND g.warehouse_id = $2
      WHERE d.contract_id = $1 AND d.status = 'current'`,
    [contractId, warehouseId],
  );
  const row = rows[0];
  if (row === undefined)
    return { open: false, reason: 'the contract is not the current deployment' };
  if (row.status === 'verified' && row.verified_at !== null) {
    return { open: true, reason: `pre-claim verified at ${row.verified_at.toISOString()}` };
  }
  return {
    open: false,
    reason:
      row.status === null
        ? 'no pre-claim gate is recorded for this warehouse'
        : `the warehouse's pre-claim is ${row.status}`,
  };
}

/** Records a `pending` (closed) gate for the warehouse, if none exists. */
export async function ensurePreclaimGate(
  db: Queryable,
  contractId: string,
  warehouseId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO preclaim_gates (contract_id, warehouse_id, status)
     SELECT contract_id, $2, 'pending' FROM chain_deployments WHERE contract_id = $1
     ON CONFLICT (contract_id, warehouse_id) DO NOTHING`,
    [contractId, warehouseId],
  );
}

/**
 * INV-2, step 5 of "Pre-claiming at cutover", and protocol #10: a pending
 * gate becomes `verified`, with `verified_at` and `verified_by`, only when
 *
 * - every number on the list is claimed on-chain (`is_claimed`);
 * - the archived `preclaimed` events for the warehouse are exactly the list;
 * - the archive can stand for every event: it covers the contract's start
 *   ledger to its cursor without a hole, and the cursor is recent.
 *
 * The list may be empty: with no predecessor contract there is nothing to
 * claim, and with one, an empty list (not an unbuilt one) means the
 * predecessor holds no live lots of the warehouse. "Verified empty" is then
 * a timestamped check, never the same as "never checked".
 *
 * Residual inference: "no `preclaimed` event" is read from the archive up to
 * its cursor, which can trail the network by MAX_INDEXER_STALENESS_LEDGERS.
 * An event in those last ledgers is missed here; the indexer pages on any
 * `preclaimed` event when it archives it.
 */
export async function verifyPreclaim(
  pool: pg.Pool,
  chain: ChainClient,
  warehouseId: string,
  verifiedBy: string,
  now: Date = new Date(),
): Promise<{ verified: boolean; problems: string[] }> {
  const { rows } = await pool.query<{
    deposit_nos: string[] | null;
    status: string;
    code: string;
    predecessor: string | null;
  }>(
    `SELECT g.deposit_nos, g.status, w.code, d.predecessor_contract_id AS predecessor
       FROM preclaim_gates g
       JOIN warehouses w ON w.id = g.warehouse_id
       JOIN chain_deployments d ON d.contract_id = g.contract_id
      WHERE g.contract_id = $1 AND g.warehouse_id = $2`,
    [chain.contractId, warehouseId],
  );
  const gate = rows[0];
  if (gate === undefined) return { verified: false, problems: ['no pre-claim gate recorded'] };
  if (gate.status !== 'pending') {
    return { verified: false, problems: [`the gate is ${gate.status}, not pending`] };
  }
  const problems: string[] = [];
  if (gate.deposit_nos === null && gate.predecessor !== null) {
    problems.push(
      `the pre-claim list has not been built from the predecessor contract ${gate.predecessor}`,
    );
  }
  const list = (gate.deposit_nos ?? []).map(Number).sort((a, b) => a - b);
  const symbol = warehouseSymbol(gate.code);
  for (const no of list) {
    if (!(await chain.isClaimed(symbol, no)))
      problems.push(`deposit ${no} is not claimed on-chain`);
  }
  const coverage = await archiveCoverage(
    pool,
    chain.contractId,
    (await chain.latestLedger()).sequence,
  );
  if (!coverage.complete) {
    problems.push(
      coverage.holes.length > 0
        ? `the event archive has holes (${coverage.holes.map(([a, b]) => `${a}..${b}`).join(', ')}): it cannot show which preclaimed events exist`
        : 'the event archive is not up to date: it cannot show which preclaimed events exist',
    );
  }
  const events = await pool.query<{ deposit_no: string }>(
    `SELECT value->>'deposit_no' AS deposit_no FROM events_archive
      WHERE contract_id = $1 AND event_type = 'preclaimed' AND topics->>1 = $2`,
    [chain.contractId, symbol],
  );
  const archived = events.rows.map((row) => Number(row.deposit_no)).sort((a, b) => a - b);
  if (archived.length !== list.length || archived.some((no, i) => no !== list[i])) {
    problems.push(
      `the archived preclaimed events (${archived.length}) are not exactly the list (${list.length})`,
    );
  }
  if (problems.length > 0) return { verified: false, problems };
  await pool.query(
    `UPDATE preclaim_gates SET status = 'verified', verified_at = $4, verified_by = $3
      WHERE contract_id = $1 AND warehouse_id = $2 AND status = 'pending'`,
    [chain.contractId, warehouseId, verifiedBy, now],
  );
  return { verified: true, problems: [] };
}

/**
 * With no predecessor contract there is nothing to pre-claim, so a pending
 * gate is verified empty (protocol #10) the first time a mint needs it,
 * through the same checks as any verification. Returns why it is still
 * closed, if it is.
 */
export async function verifyGateWithoutPredecessor(
  pool: pg.Pool,
  chain: ChainClient,
  warehouseId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT g.status FROM preclaim_gates g
       JOIN chain_deployments d ON d.contract_id = g.contract_id
      WHERE g.contract_id = $1 AND g.warehouse_id = $2 AND d.predecessor_contract_id IS NULL`,
    [chain.contractId, warehouseId],
  );
  if (rows[0]?.status !== 'pending') return [];
  return (await verifyPreclaim(pool, chain, warehouseId, 'system: no predecessor contract', now))
    .problems;
}
