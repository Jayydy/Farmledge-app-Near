import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { preclaimGateOpen, verifyPreclaim } from '../../src/services/chainDeployment.js';
import { middayOf, startChainHarness, type ChainHarness } from '../helpers/chainHarness.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { anchoredLot, DAY, lotState, pledge, sqlError } from './helpers.js';

describe.each(['stellar', 'near'] as const)('INV-2 the pre-claim gate (%s)', (backend) => {
  const OLD_CONTRACT =
    backend === 'near'
      ? 'old-receipt.farmledge.testnet'
      : 'CDLSGBNISQ7F3ROSEE5MHAZEZYNUV5LOGQA2EWTP4BPODLQT4G2LZJW3';
  let h: ChainHarness;
  let fake: FakeChain;
  beforeEach(async () => {
    h = await startChainHarness({ start: middayOf(DAY), backend });
    fake = h.chain as FakeChain;
  });
  afterEach(async () => {
    await h.close();
  });

  const archivePreclaimed = async (numbers: number[]) => {
    for (const [i, no] of numbers.entries()) {
      await h.pool.query(
        `INSERT INTO events_archive (event_id, contract_id, ledger, ledger_closed_at, tx_hash, tx_index,
                                     op_index, event_index, event_type, topics, value, topic_xdr,
                                     value_xdr, in_successful_contract_call)
         VALUES ($1, $2, 10, now(), $3, 0, 0, $4, 'preclaimed', '["preclaimed","KN_DAWANAU"]',
                 $5, '{}', '', true)`,
        [`e${i}`, fake.contractId, 'a'.repeat(64), i, JSON.stringify({ deposit_no: String(no) })],
      );
    }
  };

  const withPredecessor = () =>
    h.pool.query(
      `UPDATE chain_deployments SET predecessor_contract_id = $2 WHERE contract_id = $1`,
      [fake.contractId, OLD_CONTRACT],
    );

  it('refuses to mint while a predecessor’s lots are not verified pre-claimed, and freezes nothing', async () => {
    const lot = await anchoredLot(h);
    await withPredecessor();
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'preclaim_gate_closed' } });
    expect(fake.receipts.size).toBe(0);
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
    const gate = await h.pool.query<{ status: string }>('SELECT status FROM preclaim_gates');
    expect(gate.rows).toEqual([{ status: 'pending' }]);
  });

  it('is closed when no gate is recorded at all (fail closed)', async () => {
    const { rows } = await h.pool.query<{ id: string }>('SELECT id FROM warehouses LIMIT 1');
    const gate = await preclaimGateOpen(h.pool, fake.contractId, rows[0]?.id ?? '');
    expect(gate).toEqual({
      open: false,
      reason: 'no pre-claim gate is recorded for this warehouse',
    });
  });

  it('has no open state but verified, and no verification without a time and a verifier (database rule)', async () => {
    const notRequired = await sqlError(
      h,
      `INSERT INTO preclaim_gates (contract_id, warehouse_id, status) VALUES ($1, $2, 'not_required')`,
      [fake.contractId, h.fixtures.warehouseId],
    );
    expect(notRequired.constraint).toBe('preclaim_gates_status_check');
    const unverified = await sqlError(
      h,
      `INSERT INTO preclaim_gates (contract_id, warehouse_id, status) VALUES ($1, $2, 'verified')`,
      [fake.contractId, h.fixtures.warehouseId],
    );
    expect(unverified.constraint).toBe('preclaim_gates_verified');
  });

  it('with no predecessor, verifies the gate empty, with its time, before the first mint is submitted', async () => {
    const lot = await anchoredLot(h);
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(201);
    // The freeze, which comes before the mint is signed, is at max_time − 300 s.
    const { rows } = await h.pool.query<{
      status: string;
      verified_by: string;
      verified_at: Date;
      max_time: Date;
    }>(
      `SELECT g.status, g.verified_by, g.verified_at, m.max_time
         FROM preclaim_gates g, mint_requests m`,
    );
    expect(rows).toEqual([
      {
        status: 'verified',
        verified_by: 'system: no predecessor contract',
        verified_at: h.clock.now(),
        max_time: new Date(h.clock.now().getTime() + 300_000),
      },
    ]);
  });

  it('does not verify an empty gate while the archive has a hole or trails the network', async () => {
    const lot = await anchoredLot(h);
    // A hole: the cursor claims every ledger, but no range was ever archived.
    await h.pool.query(
      `UPDATE indexer_cursors SET start_ledger = 1, cursor_ledger = $2 WHERE contract_id = $1`,
      [fake.contractId, fake.ledger],
    );
    const holed = await pledge(h, lot.depositId);
    expect(holed.status).toBe(409);
    expect(holed.body).toMatchObject({
      error: {
        code: 'preclaim_gate_closed',
        details: [expect.stringMatching(/^the event archive has holes \(1\.\.\d+\)/) as string],
      },
    });
    await h.pool.query(
      `INSERT INTO indexed_ranges (contract_id, from_ledger, to_ledger, event_count)
       VALUES ($1, 1, $2, 0)`,
      [fake.contractId, fake.ledger],
    );
    fake.ledger += 1_000; // the network moved on; the archive did not
    const behind = await pledge(h, lot.depositId);
    expect(behind.body).toMatchObject({
      error: {
        details: [
          'the event archive is not up to date: it cannot show which preclaimed events exist',
        ],
      },
    });
    expect((await lotState(h, lot.depositId))?.frozen_for_mint).toBeNull();
    const gate = await h.pool.query<{ status: string }>('SELECT status FROM preclaim_gates');
    expect(gate.rows).toEqual([{ status: 'pending' }]);
  });

  it('does not verify an empty gate when a preclaimed event exists for the warehouse', async () => {
    await h.indexer.ingest();
    await h.pool.query(
      `INSERT INTO preclaim_gates (contract_id, warehouse_id, status) VALUES ($1, $2, 'pending')`,
      [fake.contractId, h.fixtures.warehouseId],
    );
    await archivePreclaimed([903]);
    expect(await verifyPreclaim(h.pool, fake, h.fixtures.warehouseId, 'ops')).toEqual({
      verified: false,
      problems: ['the archived preclaimed events (1) are not exactly the list (0)'],
    });
  });

  it('with a predecessor, takes an empty list as verified only once it has been built', async () => {
    await h.indexer.ingest();
    await withPredecessor();
    await h.pool.query(
      `INSERT INTO preclaim_gates (contract_id, warehouse_id, status) VALUES ($1, $2, 'pending')`,
      [fake.contractId, h.fixtures.warehouseId],
    );
    expect(await verifyPreclaim(h.pool, fake, h.fixtures.warehouseId, 'ops')).toEqual({
      verified: false,
      problems: [
        `the pre-claim list has not been built from the predecessor contract ${OLD_CONTRACT}`,
      ],
    });
    await h.pool.query(`UPDATE preclaim_gates SET deposit_nos = '{}'`);
    expect(await verifyPreclaim(h.pool, fake, h.fixtures.warehouseId, 'ops')).toEqual({
      verified: true,
      problems: [],
    });
  });

  it('opens only when every listed number is claimed on-chain and the archived preclaimed events are exactly the list', async () => {
    const lot = await anchoredLot(h);
    await withPredecessor();
    await h.pool.query(
      `INSERT INTO preclaim_gates (contract_id, warehouse_id, status, deposit_nos)
       VALUES ($1, $2, 'pending', '{901,902}')`,
      [fake.contractId, h.fixtures.warehouseId],
    );
    expect((await verifyPreclaim(h.pool, fake, h.fixtures.warehouseId, 'ops')).verified).toBe(
      false,
    );

    fake.claimed.add('KN_DAWANAU:901');
    fake.claimed.add('KN_DAWANAU:902');
    const missingEvent = await verifyPreclaim(h.pool, fake, h.fixtures.warehouseId, 'ops');
    expect(missingEvent.problems).toEqual([
      'the archived preclaimed events (0) are not exactly the list (2)',
    ]);

    await archivePreclaimed([901, 902]);
    expect(await verifyPreclaim(h.pool, fake, h.fixtures.warehouseId, 'ops')).toEqual({
      verified: true,
      problems: [],
    });
    const res = await pledge(h, lot.depositId);
    expect(res.status).toBe(201);
  });

  it('stays closed when the archived events match the list but one number is not claimed on-chain (verifyPreclaim)', async () => {
    await h.indexer.ingest();
    await withPredecessor();
    await h.pool.query(
      `INSERT INTO preclaim_gates (contract_id, warehouse_id, status, deposit_nos)
       VALUES ($1, $2, 'pending', '{901,902}')`,
      [fake.contractId, h.fixtures.warehouseId],
    );
    await archivePreclaimed([901, 902]);
    fake.claimed.add('KN_DAWANAU:901'); // 902 never landed on-chain

    expect(await verifyPreclaim(h.pool, fake, h.fixtures.warehouseId, 'ops')).toEqual({
      verified: false,
      problems: ['deposit 902 is not claimed on-chain'],
    });
    const gate = await h.pool.query<{ status: string }>('SELECT status FROM preclaim_gates');
    expect(gate.rows).toEqual([{ status: 'pending' }]);
  });
});
