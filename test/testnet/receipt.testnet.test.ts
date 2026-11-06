import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addressFor, OPERATOR_SUBJECT, subjectOf } from '../../src/chain/addresses.js';
import { ContractCallError, ContractError } from '../../src/chain/chainClient.js';
import { SorobanChainClient } from '../../src/chain/sorobanChainClient.js';
import { utcDay } from '../../src/domain/book.js';
import type { LeafJson } from '../../src/domain/merkle.js';
import { createLogger } from '../../src/logger.js';
import type { ProofBundle } from '../../src/services/proofs.js';
import {
  archiveWarehouseAdded,
  startChainHarness,
  type ChainHarness,
} from '../helpers/chainHarness.js';
import { lenderSigns } from '../helpers/fakeChain.js';
import { deployInstance, fund, invoke, localDevKeypair, PASSPHRASE, RPC_URL } from './stellar.js';
import { verifyProofScript } from '../helpers/verifyProof.js';

/**
 * Against a throwaway instance of the real v3 Wasm on Testnet, deployed per
 * run, so no test anchor ever lands in the real deployment's books.
 * Opt-in: TESTNET=1 npm test -- test/testnet
 */
const SECRET = 'local-dev-only-not-a-secret-change-me-0000';
const DAY_MS = 86_400_000;
const SCRIPT = verifyProofScript();

interface PledgeResponse {
  pledge: {
    pledge_id: string;
    status: string;
    receipt_id: string | null;
    lender_authorization: { entry_xdr: string; valid_until_ledger: number } | null;
  };
}

describe.skipIf(process.env.TESTNET !== '1')('receipt contract v3 on Testnet', () => {
  let h: ChainHarness;
  let chain: SorobanChainClient;
  let contractId: string;
  let startLedger: number;
  const admin = Keypair.random();
  const lender = Keypair.random();
  const today = utcDay(new Date());
  const lots: Record<'a' | 'b', { depositId: string; depositNo: number }> = {} as never;
  const kp = (subject: string) => localDevKeypair(SECRET, 'test', subject);

  beforeAll(async () => {
    await fund(admin.publicKey());
    ({ contractId, ledger: startLedger } = await deployInstance(admin));
    h = await startChainHarness({
      // Two days ago, midday UTC: lots go into day today-2.
      start: new Date(Date.now() - 2 * DAY_MS),
      env: { RECEIPT_CONTRACT_ID: contractId, RECEIPT_CONTRACT_START_LEDGER: String(startLedger) },
      chain: ({ adapters }) => {
        chain = new SorobanChainClient(
          {
            rpcUrl: RPC_URL,
            networkPassphrase: PASSPHRASE,
            contractId,
            operatorSubject: OPERATOR_SUBJECT,
            pollTimeoutMs: 120_000,
          },
          adapters.keys,
          createLogger('silent'),
        );
        return chain;
      },
    });
    const keys = h.adapters.keys;
    const custodian = await addressFor(keys, subjectOf.custodian(h.fixtures.custodianId));
    const verifier = await addressFor(keys, subjectOf.verifier(h.fixtures.verifierId));
    const farmer = await addressFor(keys, subjectOf.farmer(h.fixtures.farmerId));
    for (const a of [
      await addressFor(keys, OPERATOR_SUBJECT),
      custodian,
      verifier,
      farmer,
      lender.publicKey(),
    ]) {
      await fund(a);
    }
    const sym = xdr.ScVal.scvSymbol('KN_DAWANAU');
    await invoke(contractId, 'add_warehouse', [sym], admin);
    await invoke(
      contractId,
      'add_custodian',
      [sym, Address.fromString(custodian).toScVal()],
      admin,
    );
    await invoke(contractId, 'add_verifier', [Address.fromString(verifier).toScVal()], admin);
    // Books start on the day the contract registered the warehouse (D53).
    // A ledger cannot be backdated to the story's start two days ago, so
    // this stands in for the warehouse_added the contract would have
    // archived then; the contract accepts anchors of earlier days.
    await archiveWarehouseAdded(h.pool, contractId, h.fixtures.warehouseId, h.clock.now());
  }, 600_000);

  afterAll(async () => {
    await h.close();
  });

  it('anchors two days in order and the contract confirms our head', async () => {
    lots.a = await h.scaleLot(20);
    lots.b = await h.scaleLot(10);
    h.clock.set(new Date(Date.now() - DAY_MS));
    await h.anchoring.runWarehouse(h.fixtures.warehouseId);
    h.clock.set(new Date());
    const reports = await h.anchoring.runWarehouse(h.fixtures.warehouseId);
    expect(reports.at(-1), JSON.stringify(reports)).toMatchObject({
      day: today - 1,
      anchored: true,
    });
    const head = await chain.getAnchor('KN_DAWANAU');
    const ours = await h.pool.query<{ head: Buffer }>(
      'SELECT head FROM book_anchors WHERE contract_id = $1 ORDER BY day DESC LIMIT 1',
      [contractId],
    );
    expect(head?.day).toBe(today - 1);
    expect(head?.head.equals(ours.rows[0]?.head ?? Buffer.alloc(0))).toBe(true);
    // The contract's own leaf_hash agrees with ours.
    const entry = await h.pool.query<{
      content: object;
      salt: Buffer;
      day: number;
      idx: number;
      leaf_hash: Buffer;
    }>(
      `SELECT content, salt, day, idx, leaf_hash FROM book_entries WHERE kind = 2 AND day = $1 LIMIT 1`,
      [today - 1],
    );
    const e = entry.rows[0];
    const leaf = {
      ...e?.content,
      day: e?.day,
      index: e?.idx,
      salt: e?.salt.toString('hex'),
    } as LeafJson;
    expect((await chain.leafHash(leaf)).equals(e?.leaf_hash ?? Buffer.alloc(0))).toBe(true);
  }, 600_000);

  it('rejects a mint whose leaf is not from the latest anchored day (StaleLeaf)', async () => {
    const old = await h.pool.query<{
      content: object;
      salt: Buffer;
      day: number;
      idx: number;
      proof: string[];
    }>(
      `SELECT content, salt, day, idx, proof FROM book_entries WHERE deposit_id = $1 AND kind = 2 AND day = $2`,
      [lots.a.depositId, today - 2],
    );
    const o = old.rows[0];
    const err = await chain
      .mintFromAnchor(h.pool, {
        custodianSubject: subjectOf.custodian(h.fixtures.custodianId),
        verifierSubject: subjectOf.verifier(h.fixtures.verifierId),
        leaf: {
          ...o?.content,
          day: o?.day,
          index: o?.idx,
          salt: o?.salt.toString('hex'),
        } as LeafJson,
        proof: (o?.proof ?? []).map((p) => Buffer.from(p, 'hex')),
        subject: 'test:stale',
        maxTimeSeconds: 300,
        notAfter: Math.floor(Date.now() / 1000) + 300,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractCallError);
    expect((err as ContractCallError).contractError).toBe(ContractError.StaleLeaf);
  }, 300_000);

  it('releases the freeze after a failed mint', async () => {
    const stranger = await h.pool.query<{ id: string }>(
      `INSERT INTO verifiers (full_name, phone) VALUES ('Unregistered', '+2348000000099') RETURNING id`,
    );
    // Assigned here (D44), so the request reaches the contract, which doesn't know them.
    await h.pool.query(
      `INSERT INTO verifier_warehouses (verifier_id, warehouse_id)
       SELECT $1, warehouse_id FROM deposits WHERE deposit_id = $2`,
      [stranger.rows[0]?.id, lots.b.depositId],
    );
    const res = await request(h.app)
      .post('/pledges')
      .send(pledgeBody(lots.b.depositId, 900, stranger.rows[0]?.id ?? ''));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: {
        code: 'contract_refused',
        details: { contract_error: ContractError.VerifierNotRegistered },
      },
    });
    const lot = await h.pool.query('SELECT frozen_for_mint FROM deposits WHERE deposit_id = $1', [
      lots.b.depositId,
    ]);
    expect(lot.rows).toEqual([{ frozen_for_mint: null }]);
  }, 300_000);

  it('mints from the latest anchored leaf, then locks with the lender’s own signature and the owner’s', async () => {
    const res = await request(h.app)
      .post('/pledges')
      .send(pledgeBody(lots.a.depositId, 1995, h.fixtures.verifierId));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { pledge } = res.body as PledgeResponse;
    expect(pledge.status).toBe('awaiting_lender_signature');
    const auth = pledge.lender_authorization;
    if (auth === null) throw new Error('no lender authorization');
    const signed = await lenderSigns(auth.entry_xdr, lender, auth.valid_until_ledger);
    const locked = await request(h.app)
      .post(`/pledges/${pledge.pledge_id}/lender-signature`)
      .send({ signed_entry_xdr: signed });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body).toMatchObject({ pledge: { status: 'locked' } });
    const receipt = await chain.getReceipt(BigInt(pledge.receipt_id ?? 0));
    expect(receipt).toMatchObject({
      status: 'Locked',
      lender: lender.publicKey(),
      weightKg: 1995n,
      weightSource: 'Scale',
    });
  }, 600_000);

  it('rejects a duplicate pledge of one lot, in the backend and on-chain', async () => {
    const again = await request(h.app)
      .post('/pledges')
      .send(pledgeBody(lots.a.depositId, 100, h.fixtures.verifierId));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'lot_already_pledged' } });
    // Straight to the contract with the same anchored leaf: the claim bitmap refuses it.
    const leafRow = await h.pool.query<{
      content: object;
      salt: Buffer;
      day: number;
      idx: number;
      proof: string[];
    }>(
      `SELECT content, salt, day, idx, proof FROM book_entries WHERE deposit_id = $1 AND kind = 2 AND day = $2`,
      [lots.a.depositId, today - 1],
    );
    const l = leafRow.rows[0];
    const err = await chain
      .mintFromAnchor(h.pool, {
        custodianSubject: subjectOf.custodian(h.fixtures.custodianId),
        verifierSubject: subjectOf.verifier(h.fixtures.verifierId),
        leaf: {
          ...l?.content,
          day: l?.day,
          index: l?.idx,
          salt: l?.salt.toString('hex'),
        } as LeafJson,
        proof: (l?.proof ?? []).map((p) => Buffer.from(p, 'hex')),
        subject: 'test:duplicate',
        maxTimeSeconds: 300,
        notAfter: Math.floor(Date.now() / 1000) + 300,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractCallError);
    expect((err as ContractCallError).contractError).toBe(ContractError.DuplicateDepositId);
  }, 300_000);

  it('keep-alive extends live receipts and skips finished ones', async () => {
    // Lot B: mint it, then exit it whole (custodian and owner sign), so it is Exited.
    const res = await request(h.app)
      .post('/pledges')
      .send(pledgeBody(lots.b.depositId, 900, h.fixtures.verifierId));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const receiptB = BigInt((res.body as PledgeResponse).pledge.receipt_id ?? 0);
    const custodian = kp(subjectOf.custodian(h.fixtures.custodianId));
    const owner = kp(subjectOf.farmer(h.fixtures.farmerId));
    await invoke(
      contractId,
      'exit',
      [
        nativeToScVal(receiptB, { type: 'u64' }),
        Address.fromString(custodian.publicKey()).toScVal(),
        nativeToScVal(995n, { type: 'u64' }),
        nativeToScVal(990n, { type: 'u64' }),
      ],
      custodian,
      [custodian, owner],
    );
    await h.indexer.ingest();
    const report = await h.keepAlive.run();
    expect(report.sent).toEqual(['1']);
    expect(report.skippedFinished).toBe(1);
    expect(report.lowTtl).toEqual([]);
    await h.indexer.ingest();
    const extended = await h.pool.query<{ receipt_id: string }>(
      `SELECT value->>'receipt_id' AS receipt_id FROM events_archive WHERE event_type = 'ttl_extended'`,
    );
    expect(extended.rows).toEqual([{ receipt_id: '1' }]);
  }, 600_000);

  it('indexes every event, and a rebuild from the archive reproduces the projections exactly', async () => {
    await h.indexer.ingest();
    const snapshot = async () => ({
      receipts: (await h.pool.query('SELECT * FROM chain_receipts ORDER BY receipt_id')).rows.map(
        stripTimes,
      ),
      anchors: (await h.pool.query('SELECT * FROM chain_anchors ORDER BY day')).rows.map(
        stripTimes,
      ),
      registry: (
        await h.pool.query('SELECT * FROM chain_registry ORDER BY role, address')
      ).rows.map(stripTimes),
    });
    const before = await snapshot();
    expect(before.anchors).toHaveLength(2);
    expect(before.receipts.map((r) => [r.receipt_id, r.status])).toEqual([
      ['1', 'Locked'],
      ['2', 'Exited'],
    ]);
    await h.indexer.rebuild();
    expect(await snapshot()).toEqual(before);
    const gaps = await h.indexer.verifyNoGaps();
    expect(gaps).toEqual({ holes: [], refetched: 0, problems: [] });
    expect(await h.reconciliation.checkMints()).toEqual([]);
  }, 600_000);

  it('delivers bundles that the standalone verifier checks against public Testnet RPC', async () => {
    expect(await h.proofs.deliverAnchored()).toBeGreaterThan(0);
    const { rows } = await h.pool.query<{ bundle: ProofBundle }>(
      `SELECT bundle FROM proof_deliveries ORDER BY created_at LIMIT 1`,
    );
    const file = path.join(tmpdir(), `bundle-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(rows[0]?.bundle));
    const out = execFileSync('python3', [SCRIPT, file, '--rpc', RPC_URL]).toString();
    expect(out).toMatch(/^OK: /m);
  }, 300_000);

  function pledgeBody(depositId: string, kg: number, verifierId: string) {
    return {
      deposit_id: depositId,
      lender: lender.publicKey(),
      kg,
      loan_ref: `LOAN-${depositId.slice(0, 8)}`,
      due_date: new Date(Date.now() + 90 * DAY_MS).toISOString(),
      grace_period_seconds: 86_400,
      requested_by: h.fixtures.custodianId,
      verifier_id: verifierId,
      farmer_confirmed: true,
    };
  }
});

function stripTimes(row: Record<string, unknown>) {
  const rest = { ...row };
  delete rest.created_at;
  delete rest.updated_at;
  return rest;
}
