import { describe, expect, it } from 'vitest';

import { EVENT_TOPICS } from '../../../src/chain/chainClient.js';
import {
  FARMLEDGE_EVENT_VERSION,
  FARMLEDGE_STANDARD,
  fetchNearEvents,
  KNOWN_NEAR_EVENTS,
  NEP297_PREFIX,
  parseNep297Events,
} from '../../../src/chain/nearEvents.js';
import type { NearRpc, NearTxStatusResponse } from '../../../src/chain/nearRpc.js';

const CONTRACT = 'farmledge-receipt.team.testnet';
const TX_HASH = '9c2fK6v8bN3mL5pQ7rS1tU4wX2yZ8aB6cD4eF2gH1jK3';
const BLOCK_HEIGHT = 185_000_042;
const BLOCK_TS_NS = '1791400000000000000'; // 1_791_400_000 seconds

function makeEventLog(event: string, data: unknown): string {
  return `${NEP297_PREFIX}${JSON.stringify({
    standard: FARMLEDGE_STANDARD,
    version: FARMLEDGE_EVENT_VERSION,
    event,
    data,
  })}`;
}

describe('NEAR NEP-297 event parser and fetcher (test/chain/near/events.test.ts)', () => {
  const samplePayloads: Record<string, Record<string, unknown>> = {
    anchored: {
      warehouse_id: 'KN_DAWANAU',
      day: 20_733,
      leaves: 3,
      root: 'aa'.repeat(32),
      prev_head: '00'.repeat(32),
      head: 'bb'.repeat(32),
      custodian: '11'.repeat(32),
    },
    minted: {
      receipt_id: '1',
      warehouse_id: 'KN_DAWANAU',
      deposit_no: '1',
      deposit_id: '1fcffeee-3b9a-4c21-9d55-0a7c2e8b6f10',
      owner: '22'.repeat(32),
      commodity: 'MAIZE_WHITE',
      grade: '1',
      weight_kg: '1995',
      bag_count: 20,
      moisture_bps: 1250,
      weight_source: 'Scale',
      anchor_day: 20_733,
      leaf_hash: 'cc'.repeat(32),
    },
    preclaimed: {
      warehouse_id: 'KN_DAWANAU',
      deposit_no: '9',
    },
    split: {
      parent_id: '1',
      taken_id: '2',
      taken_weight_kg: '500',
      remaining_weight_kg: '1495',
      taken_bag_count: 5,
      remaining_bag_count: 15,
    },
    exited: {
      receipt_id: '2',
      warehouse_id: 'KN_DAWANAU',
      weight_kg: '500',
      exit_weight_kg: '498',
    },
    revoked: {
      receipt_id: '3',
      warehouse_id: 'KN_DAWANAU',
      reason: 'duplicate_intake',
    },
    ttl_extended: {
      receipt_id: '1',
      warehouse_id: 'KN_DAWANAU',
      live_until: 200_000_000,
    },
    locked: {
      receipt_id: '1',
      lender: 'lender.testnet',
      weight_kg: '1995',
      loan_ref: 'dd'.repeat(32),
      due_date: '1799000000',
      grace_period: '86400',
    },
    unlocked: {
      receipt_id: '1',
      lender: 'lender.testnet',
      weight_kg: '1995',
      from_recovery: false,
    },
    due_extended: {
      receipt_id: '1',
      lender: 'lender.testnet',
      old_due_date: '1799000000',
      new_due_date: '1800000000',
    },
    recovery_started: {
      receipt_id: '1',
      lender: 'lender.testnet',
      warehouse_id: 'KN_DAWANAU',
      started_at: '1801000000',
    },
    recovery_completed: {
      receipt_id: '1',
      lender: 'lender.testnet',
      sale_id: '1',
      buyer: 'buyer.testnet',
      sale_ref: 'SALE-001',
    },
    settlement_recorded: {
      sale_id: '1',
      lender: 'lender.testnet',
      settlement_ref: 'SETTLE-001',
    },
    warehouse_added: { warehouse_id: 'KN_DAWANAU' },
    warehouse_removed: { warehouse_id: 'KN_DAWANAU' },
    custodian_added: { warehouse_id: 'KN_DAWANAU', custodian: '11'.repeat(32) },
    custodian_removed: { warehouse_id: 'KN_DAWANAU', custodian: '11'.repeat(32) },
    verifier_added: { verifier: '33'.repeat(32) },
    verifier_removed: { verifier: '33'.repeat(32) },
    recovery_operator_added: { operator: '44'.repeat(32) },
    recovery_operator_removed: { operator: '44'.repeat(32) },
    mint_proposed: {
      warehouse_id: 'KN_DAWANAU',
      deposit_no: '1',
      custodian: '11'.repeat(32),
      not_after: 1791400300,
    },
    lock_offered: {
      receipt_id: '1',
      lender: 'lender.testnet',
      amount_kg: '1995',
      expires_at: 1791486400,
    },
  };

  it('covers all 21 v3 events plus the 2 NEAR intent events', () => {
    expect(Object.keys(samplePayloads).sort()).toEqual([...KNOWN_NEAR_EVENTS].sort());
    expect(KNOWN_NEAR_EVENTS.size).toBe(23);
  });

  it.each(Object.entries(samplePayloads))(
    'parses %s into a deterministic ChainEvent with matching topics and fields',
    (eventName, payload) => {
      const logLine = makeEventLog(eventName, [payload]);
      const parsed = parseNep297Events([logLine], {
        blockHeight: BLOCK_HEIGHT,
        blockTimestampNs: BLOCK_TS_NS,
        txHash: TX_HASH,
        contractId: CONTRACT,
      });

      expect(parsed).toHaveLength(1);
      const ev = parsed[0];
      if (ev === undefined) throw new Error('expected event');
      expect(ev.id).toBe(`${BLOCK_HEIGHT}-${TX_HASH}-0-0`);
      expect(ev.ledger).toBe(BLOCK_HEIGHT);
      expect(ev.ledgerClosedAt).toBe(new Date(1_791_400_000 * 1000).toISOString());
      expect(ev.txHash).toBe(TX_HASH);
      expect(ev.raw).toBe(logLine);
      expect(ev.decoded.name).toBe(eventName);
      expect(ev.decoded.fields).toEqual(payload);

      const expectedTopicFields = EVENT_TOPICS[eventName] ?? [];
      expect(ev.decoded.topics).toEqual([
        eventName,
        ...expectedTopicFields.map((f) => payload[f] ?? null),
      ]);
    },
  );

  it('emits one ChainEvent per element in data[] and ignores non-farmledge or malformed logs', () => {
    const logs = [
      'plain log line without EVENT_JSON prefix',
      'EVENT_JSON:{not-valid-json',
      `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{}] })}`,
      `EVENT_JSON:${JSON.stringify({ standard: FARMLEDGE_STANDARD, version: '2.0.0', event: 'minted', data: [{}] })}`,
      makeEventLog('verifier_added', [{ verifier: 'v1.testnet' }, { verifier: 'v2.testnet' }]),
    ];

    const events = parseNep297Events(logs, {
      blockHeight: BLOCK_HEIGHT,
      blockTimestampNs: BLOCK_TS_NS,
      txHash: TX_HASH,
      contractId: CONTRACT,
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe(`${BLOCK_HEIGHT}-${TX_HASH}-4-0`);
    expect(events[0]?.decoded.fields).toEqual({ verifier: 'v1.testnet' });
    expect(events[1]?.id).toBe(`${BLOCK_HEIGHT}-${TX_HASH}-4-1`);
    expect(events[1]?.decoded.fields).toEqual({ verifier: 'v2.testnet' });
  });

  it('fetches activity from the indexer and extracts contract logs via txStatus', async () => {
    const logLine = makeEventLog('anchored', [samplePayloads.anchored]);
    const fakeTx: NearTxStatusResponse = {
      status: { SuccessValue: '' },
      transaction: {
        hash: TX_HASH,
        signer_id: 'custodian.testnet',
        public_key: 'ed25519:11111111111111111111111111111111',
        nonce: 1,
        receiver_id: CONTRACT,
        actions: [],
      },
      transaction_outcome: {
        id: TX_HASH,
        outcome: {
          executor_id: 'custodian.testnet',
          logs: [],
          receipt_ids: ['r1'],
          status: { SuccessReceiptId: 'r1' },
        },
      },
      receipts_outcome: [
        {
          id: 'r1',
          outcome: {
            executor_id: CONTRACT,
            logs: [logLine],
            receipt_ids: [],
            status: { SuccessValue: '' },
          },
        },
      ],
    };

    const rpc: NearRpc = {
      status: () =>
        Promise.resolve({
          sync_info: {
            latest_block_hash: '11111111111111111111111111111111',
            latest_block_height: BLOCK_HEIGHT + 10,
            latest_block_time: new Date(1_791_400_010 * 1000).toISOString(),
            earliest_block_height: 100,
          },
        }),
      block: () =>
        Promise.resolve({
          header: {
            height: BLOCK_HEIGHT,
            hash: '22222222222222222222222222222222',
            timestamp: Number(BLOCK_TS_NS),
            timestamp_nanosec: BLOCK_TS_NS,
          },
        }),
      viewAccount: () => Promise.resolve(null),
      viewAccessKey: () => Promise.reject(new Error('unused')),
      callFunction: () => Promise.reject(new Error('unused')),
      sendTxAsync: () => Promise.reject(new Error('unused')),
      txStatus: (hash) => Promise.resolve(hash === TX_HASH ? fakeTx : null),
    };

    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              tx_hash: TX_HASH,
              signer_id: 'custodian.testnet',
              block_height: BLOCK_HEIGHT,
              block_timestamp: BLOCK_TS_NS,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const page = await fetchNearEvents(rpc, {
      contractId: CONTRACT,
      indexerUrl: 'https://api.testnet.kitwallet.app',
      startLedger: BLOCK_HEIGHT - 5,
      endLedger: BLOCK_HEIGHT + 5,
      fetchFn: fakeFetch,
    });

    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.decoded.name).toBe('anchored');
    expect(page.events[0]?.decoded.fields.warehouse_id).toBe('KN_DAWANAU');
    expect(page.coveredThrough).toBe(BLOCK_HEIGHT + 4);
  });
});
