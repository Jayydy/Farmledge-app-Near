import { readdirSync } from 'node:fs';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readDatabaseEnvironment } from '../src/db/environmentGuard.js';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js';
import { insertDeposit, loadFixtures, type Fixtures } from './fixtures/index.js';
import { createTestDatabase, type TestDatabase } from './helpers/testDatabase.js';

const MIGRATION_NAMES = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => file.replace(/\.sql$/, ''))
  .sort();

const TABLES = [
  'alerts',
  'audit_lines',
  'audits',
  'book_anchors',
  'book_days',
  'book_entries',
  'chain_anchors',
  'chain_deployments',
  'chain_intents',
  'chain_receipts',
  'chain_registry',
  'chain_transactions',
  'custodians',
  'db_environment',
  'deposit_cancellations',
  'deposit_photos',
  'deposits',
  'dispatch_blocked_events',
  'dispatches',
  'document_sequences',
  'events_archive',
  'farmer_confirmations',
  'farmer_statements',
  'farmer_warehouses',
  'farmers',
  'fee_accrual_runs',
  'fee_payment_reversals',
  'fee_payments',
  'indexed_ranges',
  'indexer_cursors',
  'job_runs',
  'keepalive_runs',
  'key_signature_log',
  'lot_movements',
  'manual_prices',
  'mint_requests',
  'notifications',
  'pgmigrations',
  'platform_admins',
  'pledges',
  'preclaim_gates',
  'proof_deliveries',
  'receipts',
  'role_assignments',
  'scale_samples',
  'staff_sessions',
  'stock_adjustments',
  'stock_movements',
  'storage_fee_accruals',
  'storage_fee_schedules',
  'verifier_warehouses',
  'verifiers',
  'warehouse_deposit_numbers',
  'warehouse_owners',
  'warehouse_platform_fee_terms',
  'warehouse_shrinkage_tolerances',
  'warehouses',
];

async function listTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

describe('migrations', () => {
  let db: TestDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  const up = () => runMigrations({ databaseUrl: db.url, environment: 'test', direction: 'up' });

  it('applies every migration to a fresh database', async () => {
    expect(await up()).toEqual(MIGRATION_NAMES);
    expect(await listTables(client)).toEqual(TABLES);
  });

  it('stamps the database with its environment', async () => {
    expect(await readDatabaseEnvironment(client)).toBe('test');
  });

  it('is a no-op when already up to date', async () => {
    expect(await up()).toEqual([]);
  });

  it('rolls everything back and re-applies cleanly', async () => {
    const rolledBack = await runMigrations({
      databaseUrl: db.url,
      environment: 'test',
      direction: 'down',
      count: Infinity,
    });
    expect(rolledBack).toEqual([...MIGRATION_NAMES].reverse());
    expect(await listTables(client)).toEqual(['pgmigrations']);

    expect(await up()).toEqual(MIGRATION_NAMES);
    expect(await listTables(client)).toEqual(TABLES);
  });

  it('gives every data table an environment column with the guard trigger', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND t.table_name NOT IN ('pgmigrations', 'db_environment')
         AND (
           NOT EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_name = t.table_name AND c.column_name = 'environment'
                         AND c.is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM pg_trigger tr
                          WHERE tr.tgrelid = t.table_name::regclass
                            AND tr.tgname = 'enforce_environment')
         )`,
    );
    expect(rows).toEqual([]);
  });

  it('creates the lookup indexes', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexes = rows.map((row) => row.indexname);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'farmers_phone_key',
        'deposits_deposit_id_key',
        'deposits_warehouse_id_idx',
        'deposits_farmer_id_idx',
        'deposits_status_idx',
        'custodians_warehouse_id_idx',
        'audits_warehouse_id_status_idx',
        'scale_samples_deposit_id_idx',
        'notifications_to_phone_idx',
        'notifications_status_idx',
        'farmer_warehouses_warehouse_id_idx',
        'deposits_warehouse_created_idx',
        'deposits_needs_review_idx',
      ]),
    );
  });
});

describe('schema rules', () => {
  let db: TestDatabase;
  let client: pg.Client;
  let fixtures: Fixtures;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations({ databaseUrl: db.url, environment: 'test', direction: 'up' });
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  // Each test runs in a transaction that is rolled back, so tests stay independent.
  beforeEach(async () => {
    await client.query('BEGIN');
    fixtures = await loadFixtures(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  /** Runs `sql` in a savepoint and returns the Postgres error it raises. */
  async function failure(sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
    await client.query('SAVEPOINT attempt');
    try {
      await client.query(sql, params);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      if (err instanceof pg.DatabaseError) return err;
      throw err;
    }
    throw new Error(`expected query to fail: ${sql}`);
  }

  async function depositFailure(input: Parameters<typeof insertDeposit>[2]) {
    await client.query('SAVEPOINT attempt');
    try {
      await insertDeposit(client, fixtures, input);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      if (err instanceof pg.DatabaseError) return err;
      throw err;
    }
    throw new Error('expected deposit insert to fail');
  }

  describe('environment stamping', () => {
    it('stamps new rows with the database environment', async () => {
      const deposit = await insertDeposit(client, fixtures, { depositId: 'dep-env-0001' });
      expect(deposit.environment).toBe('test');

      const { rows } = await client.query<{ environment: string }>(
        'SELECT DISTINCT environment FROM farmers UNION SELECT environment FROM warehouses',
      );
      expect(rows).toEqual([{ environment: 'test' }]);
    });

    it('rejects a row that claims another environment', async () => {
      const err = await failure(
        `INSERT INTO verifiers (full_name, phone, environment) VALUES ('X', '+2348000000099', 'live')`,
      );
      expect(err.message).toBe('row environment live does not match database environment test');
    });

    it('rejects moving an existing row to another environment', async () => {
      const err = await failure(`UPDATE farmers SET environment = 'live' WHERE id = $1`, [
        fixtures.farmerId,
      ]);
      expect(err.code).toBe('23514');
    });

    it.each([
      `UPDATE db_environment SET environment = 'live'`,
      'DELETE FROM db_environment',
      'TRUNCATE db_environment',
    ])('keeps the database identity immutable: %s', async (sql) => {
      const err = await failure(sql);
      expect(err.message).toBe('db_environment is immutable');
    });
  });

  describe('deposits', () => {
    it('derives estimated_weight_kg from bag count and bag size', async () => {
      const deposit = await insertDeposit(client, fixtures, {
        depositId: 'dep-weight-0001',
        bagCount: 20,
        bagSizeKg: 100,
      });
      expect(deposit.estimated_weight_kg).toBe('2000');
      expect(deposit.status).toBe('recorded');
    });

    it('does not allow estimated_weight_kg to be written directly', async () => {
      const err = await failure(
        `UPDATE deposits SET estimated_weight_kg = 1 WHERE deposit_id = 'dep-weight-0001'`,
      );
      expect(err.code).toBe('428C9');
    });

    it('rejects a duplicate deposit_id', async () => {
      await insertDeposit(client, fixtures, { depositId: 'dep-dup-0001' });
      const err = await depositFailure({ depositId: 'dep-dup-0001' });
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('deposits_deposit_id_key');
    });

    it('rejects a farmer not registered at the warehouse', async () => {
      await client.query('DELETE FROM farmer_warehouses WHERE farmer_id = $1', [fixtures.farmerId]);
      const err = await depositFailure({ depositId: 'dep-unreg-0001' });
      expect(err.constraint).toBe('deposits_farmer_registered_fk');
    });

    it('limits a deposit to 3 photos', async () => {
      await insertDeposit(client, fixtures, { depositId: 'dep-photo-0001' });
      const insertPhoto = `INSERT INTO deposit_photos
        (deposit_id, storage_key, content_type, size_bytes, sha256, uploaded_by)
        VALUES ('dep-photo-0001', $1, 'image/jpeg', 10, $2, $3)`;
      for (const n of [1, 2, 3]) {
        const sha = String(n).repeat(64);
        await client.query(insertPhoto, [`k${n}.jpg`, sha, fixtures.custodianId]);
      }
      const err = await failure(insertPhoto, ['k4.jpg', '4'.repeat(64), fixtures.custodianId]);
      expect(err.message).toBe('deposit dep-photo-0001 already has 3 photos');
    });

    it('accepts only known review reasons', async () => {
      await insertDeposit(client, fixtures, { depositId: 'dep-review-0001' });
      await client.query(
        `UPDATE deposits SET review_reasons = '{late_capture}' WHERE deposit_id = 'dep-review-0001'`,
      );
      const err = await failure(
        `UPDATE deposits SET review_reasons = '{looks_odd}' WHERE deposit_id = 'dep-review-0001'`,
      );
      expect(err.constraint).toBe('deposits_review_reasons_known');
    });

    it('rejects a custodian from a different warehouse', async () => {
      const err = await depositFailure({
        depositId: 'dep-cust-0001',
        custodianId: fixtures.otherCustodianId,
      });
      expect(err.code).toBe('23503');
    });

    it.each([
      { depositId: 'short', label: 'a malformed deposit_id' },
      { depositId: 'dep-bags-0001', bagCount: 0, label: 'zero bags' },
      { depositId: 'dep-src-0001', weightSource: 'guess', label: 'an unknown weight_source' },
    ])('rejects $label', async ({ label: _label, ...input }) => {
      const err = await depositFailure(input);
      expect(err.code).toBe('23514');
    });

    it('rejects an unknown status', async () => {
      await insertDeposit(client, fixtures, { depositId: 'dep-status-0001' });
      const err = await failure(
        `UPDATE deposits SET status = 'lost' WHERE deposit_id = 'dep-status-0001'`,
      );
      expect(err.code).toBe('23514');
    });

    it('rejects moisture outside 0 to 10000 basis points', async () => {
      await insertDeposit(client, fixtures, { depositId: 'dep-moist-0001' });
      const err = await failure(
        `UPDATE deposits SET moisture_bps = 10001 WHERE deposit_id = 'dep-moist-0001'`,
      );
      expect(err.code).toBe('23514');
    });

    describe('weight to mint', () => {
      const insertSample = `INSERT INTO scale_samples
        (deposit_id, bags_weighed, total_kg, recorded_by, recorded_at)
        VALUES ($1, $2, $3, $4, now())`;
      const addSample = (depositId: string, bags: number, kg: string) =>
        client.query(insertSample, [depositId, bags, kg, fixtures.custodianId]);
      const sampleFailure = (depositId: string, bags: number, kg: string) =>
        failure(insertSample, [depositId, bags, kg, fixtures.custodianId]);
      const weightOf = async (depositId: string) => {
        const { rows } = await client.query<{
          estimated_weight_kg: string;
          bags_weighed: string;
          weight_kg: string | null;
        }>(
          `SELECT estimated_weight_kg, bags_weighed, weight_kg
           FROM deposit_weights WHERE deposit_id = $1`,
          [depositId],
        );
        return rows[0];
      };

      it('uses the bag estimate for bag-estimate deposits', async () => {
        await insertDeposit(client, fixtures, { depositId: 'dep-bagw-0001', bagCount: 7 });
        expect(await weightOf('dep-bagw-0001')).toEqual({
          estimated_weight_kg: '700',
          bags_weighed: '0',
          weight_kg: '700',
        });
      });

      it('uses the scale total, rounded down, once every bag is weighed', async () => {
        await insertDeposit(client, fixtures, {
          depositId: 'dep-scale-0001',
          bagCount: 10,
          weightSource: 'scale',
        });
        await addSample('dep-scale-0001', 6, '592.70');
        expect(await weightOf('dep-scale-0001')).toEqual({
          estimated_weight_kg: '1000',
          bags_weighed: '6',
          weight_kg: null,
        });

        await addSample('dep-scale-0001', 4, '394.90');
        expect(await weightOf('dep-scale-0001')).toEqual({
          estimated_weight_kg: '1000',
          bags_weighed: '10',
          weight_kg: '987',
        });
      });

      it('rejects samples covering more bags than the deposit has', async () => {
        await insertDeposit(client, fixtures, {
          depositId: 'dep-over-0001',
          bagCount: 5,
          weightSource: 'scale',
        });
        await addSample('dep-over-0001', 5, '500.00');
        const err = await sampleFailure('dep-over-0001', 1, '100.00');
        expect(err.code).toBe('23514');
      });

      it('accepts spot-check samples on a bag-estimate deposit without changing its weight', async () => {
        await insertDeposit(client, fixtures, { depositId: 'dep-spot-0001', bagCount: 10 });
        await addSample('dep-spot-0001', 3, '285.40');
        expect(await weightOf('dep-spot-0001')).toEqual({
          estimated_weight_kg: '1000',
          bags_weighed: '3',
          weight_kg: '1000',
        });
        const err = await sampleFailure('dep-spot-0001', 8, '800.00');
        expect(err.code).toBe('23514');
      });
    });

    it('updates updated_at on change', async () => {
      await insertDeposit(client, fixtures, { depositId: 'dep-upd-0001' });
      // now() is fixed within a transaction, so backdate the row to see the trigger move it.
      await client.query(
        `UPDATE deposits SET updated_at = now() - interval '1 day' WHERE deposit_id = 'dep-upd-0001'`,
      );
      const { rows } = await client.query<{ fresh: boolean }>(
        `UPDATE deposits SET status = 'submitted' WHERE deposit_id = 'dep-upd-0001'
         RETURNING updated_at = now() AS fresh`,
      );
      expect(rows[0]?.fresh).toBe(true);
    });
  });

  describe('receipts', () => {
    it('allows chain fields to stay null and only one root receipt per deposit', async () => {
      await insertDeposit(client, fixtures, { depositId: 'dep-rcpt-0001' });
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO receipts (deposit_id) VALUES ('dep-rcpt-0001') RETURNING id`,
      );
      const rootId = rows[0]?.id;

      await client.query(
        `INSERT INTO receipts (deposit_id, parent_receipt_id) VALUES ('dep-rcpt-0001', $1)`,
        [rootId],
      );
      const err = await failure(`INSERT INTO receipts (deposit_id) VALUES ('dep-rcpt-0001')`);
      expect(err.constraint).toBe('receipts_one_root_per_deposit_idx');
    });
  });

  describe('farmers', () => {
    it('requires a consent date when consent is given', async () => {
      const err = await failure(
        `INSERT INTO farmers (full_name, phone, lookup_consent) VALUES ('A', '+2348000000010', true)`,
      );
      expect(err.constraint).toBe('farmers_consent_has_date');
    });

    it('requires data consent for new farmers', async () => {
      const err = await failure(
        `INSERT INTO farmers (full_name, phone) VALUES ('A', '+2348000000011')`,
      );
      expect(err.constraint).toBe('farmers_data_consent_required');
    });

    it('requires the registering custodian to work at the warehouse', async () => {
      const err = await failure(
        `INSERT INTO farmer_warehouses (farmer_id, warehouse_id, registered_by) VALUES ($1, $2, $3)`,
        [fixtures.farmerId, fixtures.otherWarehouseId, fixtures.custodianId],
      );
      expect(err.code).toBe('23503');
    });

    it('rejects a phone number not in E.164 form', async () => {
      const err = await failure(
        `INSERT INTO farmers (full_name, phone) VALUES ('A', '08012345678')`,
      );
      expect(err.code).toBe('23514');
    });
  });

  describe('role assignments', () => {
    it('refuses an owner created without a logged assignment', async () => {
      const err = await failure(
        `INSERT INTO warehouse_owners (warehouse_id, full_name, phone)
         VALUES ('${fixtures.warehouseId}', 'Unlogged Owner', '+2348000000099');
         SET CONSTRAINTS require_role_assignment IMMEDIATE`,
      );
      expect(err.message).toMatch(/without a role assignment/);
    });

    it('refuses an admin created without a logged assignment', async () => {
      const err = await failure(
        `INSERT INTO platform_admins (full_name, phone) VALUES ('Unlogged Admin', '+2348000000098');
         SET CONSTRAINTS require_role_assignment IMMEDIATE`,
      );
      expect(err.message).toMatch(/without a role assignment/);
    });

    it('never lets an admin be assigned through the API, or an owner through the CLI', async () => {
      const err = await failure(
        `INSERT INTO role_assignments (role, owner_id, warehouse_id, assigned_via, operator,
                                       reason, assigned_at)
         VALUES ('warehouse_owner', $1, $2, 'cli', 'someone', 'shortcut', now())`,
        [fixtures.ownerId, fixtures.warehouseId],
      );
      expect(err.constraint).toBe('role_assignments_source');
    });

    it('keeps the log append-only', async () => {
      const err = await failure(`UPDATE role_assignments SET reason = 'rewritten'`);
      expect(err.message).toMatch(/append-only/);
    });
  });

  describe('audits', () => {
    it('computes variance between recorded and counted stock', async () => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audits (warehouse_id, conducted_by, counted_by, witnessed_by, started_at)
         VALUES ($1, $2, 'Musa Bello', 'Hauwa Sani', now()) RETURNING id`,
        [fixtures.warehouseId, fixtures.verifierId],
      );
      const lines = await client.query<{ variance_bags: number; variance_kg: string }>(
        `INSERT INTO audit_lines (audit_id, commodity, grading_scheme, grade, recorded_bags,
                                  recorded_kg, counted_bags, counted_kg)
         VALUES ($1, 'MAIZE_WHITE', 'provisional', '1', 200, 20000, 198, 19750.5)
         RETURNING variance_bags, variance_kg`,
        [rows[0]?.id],
      );
      expect(lines.rows).toEqual([{ variance_bags: -2, variance_kg: '-249.50' }]);
    });

    it('requires completed_at exactly when an audit is completed', async () => {
      const err = await failure(
        `INSERT INTO audits (warehouse_id, conducted_by, counted_by, witnessed_by, status, started_at)
         VALUES ($1, $2, 'Musa Bello', 'Hauwa Sani', 'completed', now())`,
        [fixtures.warehouseId, fixtures.verifierId],
      );
      expect(err.constraint).toBe('audits_completed_has_date');
    });

    it('names who counted and witnessed, and a custodian or verifier, on every new audit', async () => {
      const unnamed = await failure(
        `INSERT INTO audits (warehouse_id, conducted_by, started_at) VALUES ($1, $2, now())`,
        [fixtures.warehouseId, fixtures.verifierId],
      );
      expect(unnamed.constraint).toBe('audits_counted_and_witnessed');
      const nobody = await failure(
        `INSERT INTO audits (warehouse_id, counted_by, witnessed_by, started_at)
         VALUES ($1, 'Musa Bello', 'Hauwa Sani', now())`,
        [fixtures.warehouseId],
      );
      expect(nobody.constraint).toBe('audits_has_actor');
      const elsewhere = await failure(
        `INSERT INTO audits (warehouse_id, entered_by, counted_by, witnessed_by, started_at)
         VALUES ($1, $2, 'Musa Bello', 'Hauwa Sani', now())`,
        [fixtures.warehouseId, fixtures.otherCustodianId],
      );
      expect(elsewhere.constraint).toBe('audits_custodian_at_warehouse');
    });
  });
});
