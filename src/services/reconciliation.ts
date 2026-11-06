import type pg from 'pg';

import type { ChainClient } from '../chain/chainClient.js';
import { cutoffOf } from '../domain/book.js';
import type { AlertService } from './alerts.js';

export interface MintFinding {
  receiptId: string;
  warehouse: string;
  depositNo: string;
  check:
    | 'on_chain_order'
    | 'db_movement'
    | 'book_dispatch'
    | 'forward_balance'
    | 'unknown_leaf'
    | 'balance_drift';
  detail: string;
  lender: string | null;
}

/**
 * The A6 reconciliation (storage-strategy "The freshness invariant";
 * backend-requirements §5), run after every anchor and after indexing. The
 * contract cannot see a dispatch recorded after its anchored day's cutoff,
 * so this is how a broken freeze (INV-1) or an off-chain exit of a minted
 * lot (INV-6) is caught within a day. For every minted receipt:
 *
 * - on_chain_order: no archived `anchored` event for the warehouse, in a
 *   ledger before the mint's, has a day later than `minted.anchor_day`
 *   (the contract guarantees it; this guards a contract or indexer defect);
 * - db_movement: no movement of the lot recorded after `anchor_day`'s cutoff
 *   and at or before `minted_at`, in the database;
 * - book_dispatch: the same in the anchored books themselves (dispatch leaves
 *   of later days with `at ≤ minted_at`), checkable without the database;
 * - forward_balance: the lot's first balance leaf after the mint carries the
 *   receipt id and its kg equals the receipt's weight less on-chain exits;
 * - balance_drift: the latest anchored balance of a minted lot equals the
 *   on-chain weight of its live receipts (grain moved outside the contract
 *   otherwise);
 * - unknown_leaf: the minted leaf hash is one of our own anchored leaves.
 *
 * Every finding pages and names the lender holding the receipt, if any.
 */
export class ReconciliationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: ChainClient,
    private readonly alerts: AlertService,
  ) {}

  async checkMints(): Promise<MintFinding[]> {
    const contractId = this.chain.contractId;
    const findings: MintFinding[] = [];
    const { rows: mints } = await this.pool.query<{
      receipt_id: string;
      warehouse_symbol: string;
      deposit_no: string;
      anchor_day: number;
      leaf_hash: string;
      minted_ledger: string;
      minted_at: string;
      weight_kg: string;
      lender: string | null;
    }>(
      `SELECT receipt_id, warehouse_symbol, deposit_no, anchor_day, leaf_hash, minted_ledger,
              minted_at, initial_weight_kg AS weight_kg,
              (SELECT string_agg(DISTINCT c.lender, ',') FROM chain_receipts c
                WHERE c.contract_id = r.contract_id AND c.deposit_no = r.deposit_no
                  AND c.warehouse_symbol = r.warehouse_symbol AND c.lender IS NOT NULL) AS lender
         FROM chain_receipts r
        WHERE contract_id = $1 AND minted_ledger IS NOT NULL
        ORDER BY receipt_id`,
      [contractId],
    );
    for (const m of mints) {
      const add = (check: MintFinding['check'], detail: string) =>
        findings.push({
          receiptId: m.receipt_id,
          warehouse: m.warehouse_symbol,
          depositNo: m.deposit_no,
          check,
          detail,
          lender: m.lender,
        });
      const mintedAt = new Date(Number(m.minted_at) * 1000);

      const later = await this.pool.query<{ day: number }>(
        `SELECT day FROM chain_anchors WHERE contract_id = $1 AND warehouse_symbol = $2
            AND ledger < $3 AND day > $4 ORDER BY day LIMIT 1`,
        [contractId, m.warehouse_symbol, m.minted_ledger, m.anchor_day],
      );
      if (later.rows[0] !== undefined) {
        add(
          'on_chain_order',
          `day ${later.rows[0].day} was anchored before the mint, after anchor_day ${m.anchor_day}`,
        );
      }

      const lot = await this.pool.query<{ deposit_id: string; warehouse_id: string }>(
        `SELECT d.deposit_id, d.warehouse_id FROM deposits d JOIN warehouses w ON w.id = d.warehouse_id
          WHERE replace(w.code, '-', '_') = $1 AND d.deposit_no = $2`,
        [m.warehouse_symbol, m.deposit_no],
      );
      const lotRow = lot.rows[0];
      if (lotRow === undefined) {
        add('unknown_leaf', `no lot ${m.deposit_no} at ${m.warehouse_symbol} in the database`);
        continue;
      }
      const ours = await this.pool.query(
        `SELECT 1 FROM book_entries WHERE leaf_hash = decode($1, 'hex') AND deposit_id = $2
            AND day = $3 AND kind = 2`,
        [m.leaf_hash, lotRow.deposit_id, m.anchor_day],
      );
      if ((ours.rowCount ?? 0) === 0) {
        add(
          'unknown_leaf',
          `the minted leaf ${m.leaf_hash} is not our balance leaf for day ${m.anchor_day}`,
        );
      }

      const moved = await this.pool.query<{ kind: string; recorded_at: Date }>(
        `SELECT sm.kind, lm.recorded_at FROM lot_movements lm
           JOIN stock_movements sm ON sm.id = lm.stock_movement_id
          WHERE lm.deposit_id = $1 AND lm.recorded_at >= $2 AND lm.recorded_at <= $3
          ORDER BY lm.recorded_at LIMIT 1`,
        [lotRow.deposit_id, cutoffOf(m.anchor_day), mintedAt],
      );
      if (moved.rows[0] !== undefined) {
        add(
          'db_movement',
          `a ${moved.rows[0].kind} was recorded ${moved.rows[0].recorded_at.toISOString()}, between the cutoff and the mint`,
        );
      }

      const dispatchLeaf = await this.pool.query<{ day: number }>(
        `SELECT day FROM book_entries WHERE deposit_id = $1 AND kind = 1 AND day > $2
            AND (content->>'at')::bigint <= $3 ORDER BY day LIMIT 1`,
        [lotRow.deposit_id, m.anchor_day, Number(m.minted_at)],
      );
      if (dispatchLeaf.rows[0] !== undefined) {
        add(
          'book_dispatch',
          `day ${dispatchLeaf.rows[0].day}'s books show a dispatch at or before the mint`,
        );
      }

      const exits = await this.pool.query<{ exited: string | null; live: string | null }>(
        `SELECT sum(weight_kg) FILTER (WHERE status = 'Exited') AS exited,
                sum(weight_kg) FILTER (WHERE status IN ('Active', 'Locked', 'Recovery')) AS live
           FROM chain_receipts WHERE contract_id = $1 AND warehouse_symbol = $2 AND deposit_no = $3`,
        [contractId, m.warehouse_symbol, m.deposit_no],
      );
      const firstAfter = await this.pool.query<{ day: number; receipt_id: string; kg: string }>(
        `SELECT b.day, b.content->>'receipt_id' AS receipt_id, b.content->>'kg' AS kg
           FROM book_entries b
           JOIN book_anchors a ON a.warehouse_id = b.warehouse_id AND a.day = b.day
                               AND a.contract_id = $3
          WHERE b.deposit_id = $1 AND b.kind = 2 AND b.day > $2
          ORDER BY b.day LIMIT 1`,
        [lotRow.deposit_id, m.anchor_day, contractId],
      );
      const first = firstAfter.rows[0];
      if (first !== undefined) {
        const expected = BigInt(m.weight_kg) - BigInt(exits.rows[0]?.exited ?? 0);
        if (first.receipt_id !== m.receipt_id) {
          add(
            'forward_balance',
            `day ${first.day}'s balance leaf names receipt ${first.receipt_id}, not ${m.receipt_id}`,
          );
        }
        if (BigInt(first.kg) !== expected) {
          add(
            'forward_balance',
            `day ${first.day}'s balance is ${first.kg} kg; the receipt less exits is ${expected} kg`,
          );
        }
      }
      const latest = await this.pool.query<{ day: number; kg: string }>(
        `SELECT b.day, b.content->>'kg' AS kg FROM book_entries b
           JOIN book_anchors a ON a.warehouse_id = b.warehouse_id AND a.day = b.day
                               AND a.contract_id = $2
          WHERE b.deposit_id = $1 AND b.kind = 2 ORDER BY b.day DESC LIMIT 1`,
        [lotRow.deposit_id, contractId],
      );
      const live = BigInt(exits.rows[0]?.live ?? 0);
      if (
        latest.rows[0] !== undefined &&
        latest.rows[0].day > m.anchor_day &&
        BigInt(latest.rows[0].kg) !== live
      ) {
        add(
          'balance_drift',
          `anchored balance ${latest.rows[0].kg} kg on day ${latest.rows[0].day}, on-chain receipts ${live} kg: grain moved outside the contract`,
        );
      }
    }

    for (const finding of findings) {
      await this.alerts.raise({
        key: `mint_reconcile:${finding.check}:${finding.receiptId}`,
        severity: 'page',
        category: 'reconciliation',
        message: `Receipt ${finding.receiptId} (lot ${finding.depositNo} at ${finding.warehouse}) fails ${finding.check}: ${finding.detail}`,
        details: {
          ...finding,
          // To be reported to the lender holding the receipt (no lender
          // notification channel exists yet: see docs/decisions.md D36).
          notify_lender: finding.lender,
        },
      });
    }
    return findings;
  }
}
