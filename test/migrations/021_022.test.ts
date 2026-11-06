import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { insertDeposit, loadFixtures, type Fixtures } from '../fixtures/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDatabase.js';

const STELLAR_CONTRACT = 'CBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN';
const STELLAR_PREDECESSOR = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const STELLAR_LENDER = 'GBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAI2';
const STELLAR_TX_HASH = 'a'.repeat(64);

const NEAR_CONTRACT = 'farmledge-receipt.team.testnet';
const NEAR_IMPLICIT = 'b'.repeat(64);
const NEAR_TX_HASH_44 = '9'.repeat(44);
const NEAR_TX_HASH_43 = 'H'.repeat(43);

describe('migrations 021 & 022 (NEAR backend)', () => {
  describe('up -> down -> up lifecycle', () => {
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

    const up = (count?: number) =>
      runMigrations({
        databaseUrl: db.url,
        environment: 'test',
        direction: 'up',
        ...(count === undefined ? {} : { count }),
      });

    const down = (count: number) =>
      runMigrations({
        databaseUrl: db.url,
        environment: 'test',
        direction: 'down',
        count,
      });

    it('runs up -> down(2) -> up cleanly on a database seeded with Stellar rows', async () => {
      await up();
      const fixtures = await loadFixtures(client);
      await insertDeposit(client, fixtures, { depositId: 'dep-mig-0001' });

      await client.query(
        `INSERT INTO chain_deployments (contract_id, network_passphrase, rpc_url, start_ledger,
                                        predecessor_contract_id, status)
         VALUES ($1, 'Test SDF Network ; September 2015', 'https://rpc.example', 100, $2, 'current')`,
        [STELLAR_CONTRACT, STELLAR_PREDECESSOR],
      );
      await client.query(
        `INSERT INTO chain_transactions (contract_id, purpose, subject, tx_hash, envelope_xdr, max_time)
         VALUES ($1, 'anchor', 'anchor:test', $2, 'xdr-data', now() + interval '5 minutes')`,
        [STELLAR_CONTRACT, STELLAR_TX_HASH],
      );
      await client.query(
        `INSERT INTO pledges (deposit_id, warehouse_id, lender_address, kg, loan_ref, due_date,
                              grace_period_seconds, requested_by, verifier_id, status)
         VALUES ('dep-mig-0001', $1, $2, 500, 'loan-001', now() + interval '30 days', 86400,
                 $3, $4, 'awaiting_lender_signature')`,
        [fixtures.warehouseId, STELLAR_LENDER, fixtures.custodianId, fixtures.verifierId],
      );
      await client.query(
        `INSERT INTO receipts (deposit_id, contract_id, chain_receipt_id, mint_tx_hash)
         VALUES ('dep-mig-0001', $1, 1, $2)`,
        [STELLAR_CONTRACT, STELLAR_TX_HASH],
      );

      const rolledBack = await down(2);
      expect(rolledBack).toEqual(['022_near_pending_intents', '021_chain_backend']);

      const reapplied = await up();
      expect(reapplied).toEqual(['021_chain_backend', '022_near_pending_intents']);
    });

    it('fails down migration loudly when NEAR rows exist', async () => {
      await client.query(
        `INSERT INTO chain_deployments (chain, contract_id, network_passphrase, rpc_url,
                                        start_ledger, status, retired_at)
         VALUES ('near', $1, 'near:testnet', 'https://rpc.testnet.near.org', 1, 'retired', now())`,
        [NEAR_CONTRACT],
      );
      await client.query(
        `INSERT INTO chain_transactions (chain, contract_id, purpose, subject, tx_hash,
                                         envelope_xdr, envelope_encoding, signer_nonce, max_time)
         VALUES ('near', $1, 'mint_propose', 'mint:near-1', $2, 'Ym9yc2g=', 'borsh_b64', 42,
                 now() + interval '5 minutes')`,
        [NEAR_CONTRACT, NEAR_TX_HASH_44],
      );

      // 022 down must fail because purpose = 'mint_propose' exists.
      await expect(down(1)).rejects.toThrow();

      await client.query(`DELETE FROM chain_transactions WHERE chain = 'near'`);
      expect(await down(1)).toEqual(['022_near_pending_intents']);

      // 021 down must fail because a NEAR deployment row exists.
      await expect(down(1)).rejects.toThrow();

      await client.query(`DELETE FROM chain_deployments WHERE chain = 'near'`);
      expect(await down(1)).toEqual(['021_chain_backend']);
      expect(await up()).toEqual(['021_chain_backend', '022_near_pending_intents']);
    });
  });

  describe('relaxed and chain-aware CHECK constraints', () => {
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

    beforeEach(async () => {
      await client.query('BEGIN');
      fixtures = await loadFixtures(client);
      await insertDeposit(client, fixtures, { depositId: 'dep-chk-0001' });
    });

    afterEach(async () => {
      await client.query('ROLLBACK');
    });

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

    describe('chain_deployments', () => {
      const insertDeployment = (
        chain: string,
        contractId: string,
        predecessor: string | null = null,
      ) =>
        `INSERT INTO chain_deployments (chain, contract_id, network_passphrase, rpc_url,
                                        start_ledger, predecessor_contract_id, status, retired_at)
         VALUES ('${chain}', '${contractId}', 'net', 'https://rpc.example', 1,
                 ${predecessor === null ? 'NULL' : `'${predecessor}'`}, 'retired', now())`;

      it('accepts valid Stellar and NEAR contract IDs (named and implicit)', async () => {
        await client.query(insertDeployment('stellar', STELLAR_CONTRACT, STELLAR_PREDECESSOR));
        await client.query(insertDeployment('near', NEAR_CONTRACT, NEAR_IMPLICIT));
        await client.query(insertDeployment('near', NEAR_IMPLICIT, null));
      });

      it.each([
        ['near', STELLAR_CONTRACT, 'Stellar C… address on near chain'],
        ['stellar', NEAR_CONTRACT, 'NEAR account on stellar chain'],
        ['near', NEAR_CONTRACT, STELLAR_PREDECESSOR],
        ['stellar', STELLAR_CONTRACT, NEAR_CONTRACT],
        ['near', 'a', 'too short (1 char)'],
        ['near', 'a'.repeat(65), 'too long (65 chars)'],
        ['near', 'Upper.testnet', 'uppercase characters'],
        ['near', '.leading.testnet', 'leading dot'],
        ['near', 'trailing.testnet.', 'trailing dot'],
        ['solana', NEAR_CONTRACT, 'unknown chain'],
      ])('rejects invalid deployment (%s, %s, %s)', async (chain, contractId, third) => {
        const pred = third === STELLAR_PREDECESSOR || third === NEAR_CONTRACT ? third : null;
        const err = await failure(insertDeployment(chain, contractId, pred));
        expect(err.code).toBe('23514');
      });
    });

    describe('chain_transactions', () => {
      const insertTx = (
        chain: string,
        txHash: string,
        purpose = 'anchor',
        encoding = 'xdr',
        nonce: number | null = null,
      ) =>
        client.query(
          `INSERT INTO chain_transactions (chain, contract_id, purpose, subject, tx_hash,
                                           envelope_xdr, envelope_encoding, signer_nonce, max_time)
           VALUES ($1, $2, $3, 'subj', $4, 'env', $5, $6, now() + interval '5 minutes')`,
          [chain, NEAR_CONTRACT, purpose, txHash, encoding, nonce],
        );

      it('accepts Stellar 64-hex and NEAR 43/44-char base58 tx hashes, new purposes, and nonce', async () => {
        await insertTx('stellar', STELLAR_TX_HASH, 'mint', 'xdr', null);
        await insertTx('near', NEAR_TX_HASH_43, 'mint_propose', 'borsh_b64', 1);
        await insertTx('near', NEAR_TX_HASH_44, 'mint_approve', 'borsh_b64', 2);
        await insertTx('near', '5'.repeat(44), 'lock_accept', 'borsh_b64', 999);
      });

      it.each([
        ['near', STELLAR_TX_HASH, 'anchor', 'borsh_b64', 'Stellar hex on near chain'],
        ['stellar', NEAR_TX_HASH_44, 'anchor', 'xdr', 'NEAR base58 on stellar chain'],
        ['near', '0'.repeat(44), 'anchor', 'borsh_b64', 'invalid base58 char 0'],
        ['near', 'O'.repeat(44), 'anchor', 'borsh_b64', 'invalid base58 char O'],
        ['near', 'I'.repeat(44), 'anchor', 'borsh_b64', 'invalid base58 char I'],
        ['near', 'l'.repeat(44), 'anchor', 'borsh_b64', 'invalid base58 char l'],
        ['near', '9'.repeat(42), 'anchor', 'borsh_b64', 'too short base58 (42)'],
        ['near', '9'.repeat(45), 'anchor', 'borsh_b64', 'too long base58 (45)'],
        ['near', NEAR_TX_HASH_44, 'unknown_purpose', 'borsh_b64', 'invalid purpose'],
        ['near', NEAR_TX_HASH_44, 'anchor', 'json', 'invalid envelope_encoding'],
      ])('rejects invalid tx (%s, %s, %s, %s: %s)', async (chain, hash, purpose, enc, _label) => {
        const err = await failure(
          `INSERT INTO chain_transactions (chain, contract_id, purpose, subject, tx_hash,
                                           envelope_xdr, envelope_encoding, max_time)
           VALUES ($1, $2, $3, 'subj', $4, 'env', $5, now() + interval '5 minutes')`,
          [chain, NEAR_CONTRACT, purpose, hash, enc],
        );
        expect(err.code).toBe('23514');
      });
    });

    describe('pledges', () => {
      const pledgeSql = `INSERT INTO pledges (deposit_id, warehouse_id, lender_address, kg, loan_ref, due_date,
                                              grace_period_seconds, requested_by, verifier_id, status,
                                              lender_offer_tx_hash)
                         VALUES ($1, $2, $3, 100, 'ref-1', now() + interval '10 days', 0, $4, $5, $6, $7)`;

      const pledgeParams = (
        depositId: string,
        lender: string,
        status = 'minting',
        offerHash: string | null = null,
      ) => [
        depositId,
        fixtures.warehouseId,
        lender,
        fixtures.custodianId,
        fixtures.verifierId,
        status,
        offerHash,
      ];

      it('accepts Stellar G… and NEAR lender addresses, awaiting_lender_offer, and lender_offer_tx_hash', async () => {
        await client.query(
          pledgeSql,
          pledgeParams('dep-chk-0001', STELLAR_LENDER, 'awaiting_lender_signature', null),
        );
        await insertDeposit(client, fixtures, { depositId: 'dep-chk-0002' });
        await client.query(
          pledgeSql,
          pledgeParams(
            'dep-chk-0002',
            'lender.testnet',
            'awaiting_lender_offer',
            NEAR_TX_HASH_44,
          ),
        );
        await insertDeposit(client, fixtures, { depositId: 'dep-chk-0003' });
        await client.query(
          pledgeSql,
          pledgeParams('dep-chk-0003', NEAR_IMPLICIT, 'awaiting_lender_offer', null),
        );
      });

      it.each([
        [STELLAR_CONTRACT, 'minting', null, 'Stellar C… contract id instead of G…'],
        ['x', 'minting', null, 'too short NEAR account'],
        ['a'.repeat(65), 'minting', null, 'too long NEAR account'],
        ['BadLender.testnet', 'minting', null, 'uppercase NEAR account'],
        ['lender.testnet', 'unknown_status', null, 'unknown status'],
        ['lender.testnet', 'awaiting_lender_offer', 'not-a-base58-hash!', 'invalid offer tx hash'],
      ])('rejects invalid pledge (%s, %s, %s: %s)', async (lender, status, offerHash, _label) => {
        const err = await failure(
          pledgeSql,
          pledgeParams('dep-chk-0001', lender, status, offerHash),
        );
        expect(err.code).toBe('23514');
      });
    });

    describe('receipts.mint_tx_hash and dispatches.chain_tx_hash', () => {
      it('accepts 64-hex and 43/44-char base58 on receipts and dispatches, and rejects garbage', async () => {
        await client.query(
          `INSERT INTO receipts (deposit_id, mint_tx_hash) VALUES ('dep-chk-0001', $1)`,
          [NEAR_TX_HASH_44],
        );
        const badReceipt = await failure(
          `INSERT INTO receipts (deposit_id, parent_receipt_id, mint_tx_hash)
           SELECT 'dep-chk-0001', id, 'bad-hash' FROM receipts WHERE deposit_id = 'dep-chk-0001'`,
        );
        expect(badReceipt.code).toBe('23514');

        const conf = await client.query<{ id: string }>(
          `INSERT INTO farmer_confirmations (farmer_id, action, subject_id, mode, status, decided_at)
           VALUES ($1, 'dispatch', gen_random_uuid(), 'tablet', 'approved', now()) RETURNING id`,
          [fixtures.farmerId],
        );
        const dispatchSql = `INSERT INTO dispatches (id, warehouse_id, farmer_id, custodian_id, commodity,
                                                     grading_scheme, grade, bag_count, book_kg, exit_weight_kg,
                                                     delivery_note_no, status, confirmation_id, chain_tx_hash,
                                                     dispatched_at)
                             VALUES (gen_random_uuid(), $1, $2, $3, 'MAIZE_WHITE', 'provisional', '1', 1, 100, 100,
                                     $4, 'completed', $5, $6, now())`;
        await client.query(dispatchSql, [
          fixtures.warehouseId,
          fixtures.farmerId,
          fixtures.custodianId,
          'DN-1',
          conf.rows[0]?.id,
          STELLAR_TX_HASH,
        ]);
        await client.query(dispatchSql, [
          fixtures.warehouseId,
          fixtures.farmerId,
          fixtures.custodianId,
          'DN-2',
          conf.rows[0]?.id,
          NEAR_TX_HASH_43,
        ]);
        const badDispatch = await failure(dispatchSql, [
          fixtures.warehouseId,
          fixtures.farmerId,
          fixtures.custodianId,
          'DN-3',
          conf.rows[0]?.id,
          'invalid-tx-hash',
        ]);
        expect(badDispatch.code).toBe('23514');
      });
    });
  });
});
