import { randomBytes } from 'node:crypto';

import type pg from 'pg';

import type { ChainClient } from '../chain/chainClient.js';
import type { Config } from '../config/index.js';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { cutoffOf, utcDay } from '../domain/book.js';
import { entryHash, foldProof, nextHead, type LeafJson } from '../domain/merkle.js';
import { balanceStatementSms, proofReadySms } from '../domain/smsTemplates.js';
import type { Logger } from '../logger.js';
import type { SmsGateway } from '../sms/smsGateway.js';
import type { AlertService } from './alerts.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** backend-requirements §4: every bundle reaches its farmer within 24 h of the cutoff. */
export const DELIVERY_DEADLINE_MS = 24 * HOUR_MS;
/** A statement every 28 days keeps every farmer's newest balance proof under 30 days old. */
export const STATEMENT_INTERVAL_DAYS = 28;
export const MAX_PROOF_AGE_DAYS = 30;
const MAX_SEND_ATTEMPTS = 8;

/** The proof bundle (docs/events.md, "Bundle format"). */
export interface ProofBundle {
  chain?: 'stellar' | 'near';
  encoding?: 'soroban_xdr' | 'near_borsh';
  rpc: string;
  contract_id: string;
  leaf: LeafJson;
  proof: string[];
  day_leaves: number;
  prev_head: string;
  later_days: { day: number; leaves: number; root: string }[];
}

export function explorerUrlForBundle(bundle: ProofBundle): string {
  const isNear = bundle.chain === 'near' || bundle.encoding === 'near_borsh';
  if (isNear) {
    const isTestnet =
      bundle.contract_id.endsWith('.testnet') || bundle.rpc.toLowerCase().includes('testnet');
    return isTestnet
      ? `https://testnet.nearblocks.io/address/${bundle.contract_id}`
      : `https://nearblocks.io/address/${bundle.contract_id}`;
  }
  const isTestnet = bundle.rpc.toLowerCase().includes('testnet');
  return isTestnet
    ? `https://stellar.expert/explorer/testnet/contract/${bundle.contract_id}`
    : `https://stellar.expert/explorer/public/contract/${bundle.contract_id}`;
}

export function computeBundleProof(bundle: ProofBundle): {
  encoder: 'near' | 'stellar';
  leafHash: Buffer;
  root: Buffer;
  head: Buffer;
} {
  const encoder =
    bundle.encoding === 'near_borsh' || bundle.chain === 'near' ? 'near' : 'stellar';
  const leafHash = entryHash(bundle.leaf, encoder);
  const root = foldProof(
    leafHash,
    bundle.leaf.index,
    bundle.proof.map((p) => Buffer.from(p, 'hex')),
  );
  let head = nextHead(
    Buffer.from(bundle.prev_head, 'hex'),
    bundle.leaf.day,
    bundle.day_leaves,
    root,
  );
  for (const d of bundle.later_days) {
    head = nextHead(head, d.day, d.leaves, Buffer.from(d.root, 'hex'));
  }
  return { encoder, leafHash, root, head };
}

export function verifyProofBundle(bundle: ProofBundle, chainHead: Buffer): boolean {
  return computeBundleProof(bundle).head.equals(chainHead);
}

/**
 * Farmer proof delivery (backend-requirements §4; INV-7). Automatic, never
 * on request:
 *
 * - once a day is anchored, every deposit and dispatch leaf of it gets a
 *   bundle and an SMS link to it; failed sends are retried and every send
 *   keeps a delivery receipt (provider message id);
 * - every 28 days a farmer with stock at a warehouse gets a statement: a
 *   fresh balance bundle for each active lot, so they always hold a proof
 *   under 30 days old;
 * - alerts: a leaf not delivered within 24 h of its cutoff, and a farmer
 *   with stock whose newest delivered balance proof is 30 days old.
 *
 * A bundle is checked against the chain, never against Farmledge: the link
 * serves the bundle file (the proof); verification is the standalone
 * farmledge-protocol's scripts/verify_proof.py or any equivalent, against any public RPC.
 */
export class ProofService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: ChainClient,
    private readonly sms: SmsGateway,
    private readonly config: Config,
    private readonly alerts: AlertService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The bundle for one leaf, against the current contract's anchors. */
  async bundle(db: Queryable, bookEntryId: string): Promise<ProofBundle> {
    const contractId = this.chain.contractId;
    const { rows } = await db.query<{
      warehouse_id: string;
      content: Omit<LeafJson, 'day' | 'index' | 'salt'>;
      salt: Buffer;
      day: number;
      idx: number;
      proof: string[];
      leaves: number;
      prev_head: Buffer;
    }>(
      `SELECT b.warehouse_id, b.content, b.salt, b.day, b.idx, b.proof, d.leaves, a.prev_head
         FROM book_entries b
         JOIN book_days d ON d.warehouse_id = b.warehouse_id AND d.day = b.day
         JOIN book_anchors a ON a.warehouse_id = b.warehouse_id AND a.day = b.day
                            AND a.contract_id = $2
        WHERE b.id = $1 AND b.entry_type = 'leaf'`,
      [bookEntryId, contractId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`book entry ${bookEntryId} is not an anchored leaf`);
    const later = await db.query<{ day: number; leaves: number; root: Buffer }>(
      `SELECT a.day, d.leaves, d.root FROM book_anchors a
         JOIN book_days d ON d.warehouse_id = a.warehouse_id AND d.day = a.day
        WHERE a.contract_id = $1 AND a.warehouse_id = $2 AND a.day > $3
        ORDER BY a.day`,
      [contractId, row.warehouse_id, row.day],
    );
    return {
      chain: this.chain.backend,
      encoding: this.chain.backend === 'near' ? 'near_borsh' : 'soroban_xdr',
      rpc: this.config.chain.rpcUrl,
      contract_id: contractId,
      leaf: { ...row.content, day: row.day, index: row.idx, salt: row.salt.toString('hex') },
      proof: row.proof,
      day_leaves: row.leaves,
      prev_head: row.prev_head.toString('hex'),
      later_days: later.rows.map((r) => ({
        day: r.day,
        leaves: r.leaves,
        root: r.root.toString('hex'),
      })),
    };
  }

  /** Queues and sends a bundle for every deposit and dispatch leaf of anchored days. */
  async deliverAnchored(): Promise<number> {
    const contractId = this.chain.contractId;
    const { rows } = await this.pool.query<{
      id: string;
      farmer_id: string;
      kind: number;
      warehouse_name: string;
      deposit_no: string;
    }>(
      `SELECT b.id, b.farmer_id, b.kind, w.name AS warehouse_name, b.deposit_no
         FROM book_entries b
         JOIN book_anchors a ON a.warehouse_id = b.warehouse_id AND a.day = b.day AND a.contract_id = $1
         JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.kind IN (0, 1)
          AND NOT EXISTS (SELECT 1 FROM proof_deliveries p
                           WHERE p.book_entry_id = b.id AND p.reason = 'anchored'
                             AND p.contract_id = $1)
        ORDER BY b.day, b.idx`,
      [contractId],
    );
    for (const row of rows) {
      const bundle = await this.bundle(this.pool, row.id);
      const token = newToken();
      const what = `${row.kind === 0 ? 'deposit' : 'dispatch'} of lot #${row.deposit_no}`;
      await withTransaction(this.pool, async (client) => {
        const notification = await client.query<{ id: string }>(
          `INSERT INTO notifications (farmer_id, to_phone, template, body)
           SELECT id, phone, 'proof_ready', $2 FROM farmers WHERE id = $1 RETURNING id`,
          [
            row.farmer_id,
            proofReadySms({ warehouseName: row.warehouse_name, what, link: this.link(token) }),
          ],
        );
        await client.query(
          `INSERT INTO proof_deliveries (book_entry_id, farmer_id, reason, token, bundle,
                                         notification_id, status, contract_id)
           VALUES ($1, $2, 'anchored', $3, $4, $5, 'queued', $6)
           ON CONFLICT DO NOTHING`,
          [
            row.id,
            row.farmer_id,
            token,
            JSON.stringify(bundle),
            notification.rows[0]?.id ?? null,
            contractId,
          ],
        );
      });
    }
    await this.sendQueued();
    return rows.length;
  }

  /** Sends queued deliveries and retries failed ones, recording a receipt for each. */
  async sendQueued(): Promise<void> {
    const { rows } = await this.pool.query<{
      id: string;
      notification_id: string;
      to_phone: string;
      body: string;
      attempts: number;
    }>(
      `SELECT p.id, p.notification_id, n.to_phone, n.body, p.attempts
         FROM proof_deliveries p JOIN notifications n ON n.id = p.notification_id
        WHERE p.status IN ('queued', 'failed') AND p.attempts < $1
        ORDER BY p.created_at`,
      [MAX_SEND_ATTEMPTS],
    );
    // A statement's lots share one SMS: send each notification once.
    const sent = new Map<string, { ok: boolean; messageId?: string; error?: string }>();
    for (const row of rows) {
      let result = sent.get(row.notification_id);
      if (result === undefined) {
        try {
          const { messageId } = await this.sms.send({ to: row.to_phone, body: row.body });
          result = { ok: true, messageId };
          await this.pool.query(
            `UPDATE notifications SET status = 'sent', provider = $2, provider_message_id = $3,
                    sent_at = $4 WHERE id = $1`,
            [row.notification_id, this.sms.provider, messageId, this.clock()],
          );
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          await this.pool.query(
            `UPDATE notifications SET status = 'failed', provider = $2, error = $3 WHERE id = $1`,
            [row.notification_id, this.sms.provider, result.error],
          );
          this.logger.warn({ deliveryId: row.id, err }, 'proof SMS failed; will retry');
        }
        sent.set(row.notification_id, result);
      }
      await this.pool.query(
        `UPDATE proof_deliveries
            SET status = $2, attempts = attempts + 1, provider_message_id = $3,
                delivered_at = CASE WHEN $2 = 'sent' THEN $5::timestamptz END, last_error = $4
          WHERE id = $1`,
        [
          row.id,
          result.ok ? 'sent' : 'failed',
          result.messageId ?? null,
          result.error ?? null,
          this.clock(),
        ],
      );
    }
  }

  /**
   * Monthly statements: each farmer with stock at a warehouse whose last
   * statement there is 28 days old or more (or who has none) gets one, with a
   * balance bundle per active lot from the latest anchored day.
   */
  async issueStatements(): Promise<number> {
    const contractId = this.chain.contractId;
    const now = this.clock();
    const { rows } = await this.pool.query<{
      farmer_id: string;
      warehouse_id: string;
      warehouse_name: string;
      day: number;
    }>(
      `WITH latest AS (
         SELECT warehouse_id, max(day) AS day FROM book_anchors WHERE contract_id = $1
          GROUP BY warehouse_id
       )
       SELECT DISTINCT b.farmer_id, b.warehouse_id, w.name AS warehouse_name, l.day
         FROM latest l
         JOIN book_entries b ON b.warehouse_id = l.warehouse_id AND b.day = l.day AND b.kind = 2
         JOIN warehouses w ON w.id = b.warehouse_id
        WHERE NOT EXISTS (
          SELECT 1 FROM farmer_statements s
           WHERE s.farmer_id = b.farmer_id AND s.warehouse_id = b.warehouse_id
             AND s.contract_id = $1 AND s.issued_at > $2)`,
      [contractId, new Date(now.getTime() - STATEMENT_INTERVAL_DAYS * DAY_MS)],
    );
    for (const row of rows) {
      const lots = await this.pool.query<{ id: string }>(
        `SELECT id FROM book_entries WHERE farmer_id = $1 AND warehouse_id = $2 AND day = $3 AND kind = 2
          ORDER BY deposit_no`,
        [row.farmer_id, row.warehouse_id, row.day],
      );
      const token = newToken();
      await withTransaction(this.pool, async (client) => {
        const notification = await client.query<{ id: string }>(
          `INSERT INTO notifications (farmer_id, to_phone, template, body)
           SELECT id, phone, 'balance_statement', $2 FROM farmers WHERE id = $1 RETURNING id`,
          [
            row.farmer_id,
            balanceStatementSms({
              warehouseName: row.warehouse_name,
              lots: lots.rows.length,
              link: this.link(`s/${token}`),
            }),
          ],
        );
        const notificationId = notification.rows[0]?.id ?? null;
        const statement = await client.query<{ id: string }>(
          `INSERT INTO farmer_statements (farmer_id, warehouse_id, day, issued_at, token, contract_id,
                                          notification_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [row.farmer_id, row.warehouse_id, row.day, now, token, contractId, notificationId],
        );
        for (const lot of lots.rows) {
          await client.query(
            `INSERT INTO proof_deliveries (book_entry_id, farmer_id, reason, token, bundle,
                                           notification_id, status, statement_id, contract_id)
             VALUES ($1, $2, 'statement', $3, $4, $5, 'queued', $6, $7)`,
            [
              lot.id,
              row.farmer_id,
              newToken(),
              JSON.stringify(await this.bundle(client, lot.id)),
              notificationId,
              statement.rows[0]?.id,
              contractId,
            ],
          );
        }
      });
    }
    await this.sendQueued();
    return rows.length;
  }

  /** INV-7 alerts: undelivered within 24 h of the cutoff; newest balance proof 30 days old. */
  async checkDeliveries(): Promise<void> {
    const contractId = this.chain.contractId;
    const now = this.clock();
    const { rows } = await this.pool.query<{
      id: string;
      day: number;
      farmer_id: string;
      status: string | null;
    }>(
      `SELECT b.id, b.day, b.farmer_id, p.status
         FROM book_entries b
         JOIN book_anchors a ON a.warehouse_id = b.warehouse_id AND a.day = b.day AND a.contract_id = $1
         LEFT JOIN proof_deliveries p ON p.book_entry_id = b.id AND p.reason = 'anchored'
                                      AND p.contract_id = $1
        WHERE b.kind IN (0, 1) AND (p.status IS NULL OR p.status <> 'sent')`,
      [contractId],
    );
    for (const row of rows) {
      if (now.getTime() - cutoffOf(row.day).getTime() < DELIVERY_DEADLINE_MS) continue;
      await this.alerts.raise({
        key: `proof_undelivered:${row.id}`,
        severity: 'page',
        category: 'proofs',
        message: `A farmer's proof bundle for day ${row.day} was not delivered within 24 h of the cutoff`,
        details: { book_entry_id: row.id, farmer_id: row.farmer_id, status: row.status },
      });
    }
    const stale = await this.pool.query<{
      farmer_id: string;
      warehouse_id: string;
      newest: Date | null;
    }>(
      `WITH latest AS (
         SELECT warehouse_id, max(day) AS day FROM book_anchors WHERE contract_id = $1 GROUP BY warehouse_id
       ), holders AS (
         SELECT DISTINCT b.farmer_id, b.warehouse_id FROM latest l
           JOIN book_entries b ON b.warehouse_id = l.warehouse_id AND b.day = l.day AND b.kind = 2
       )
       SELECT h.farmer_id, h.warehouse_id,
              (SELECT max(be.day) FROM proof_deliveries p JOIN book_entries be ON be.id = p.book_entry_id
                WHERE p.farmer_id = h.farmer_id AND be.warehouse_id = h.warehouse_id
                  AND be.kind = 2 AND p.status = 'sent' AND p.contract_id = $1) AS newest
         FROM holders h`,
      [contractId],
    );
    const today = utcDay(now);
    for (const row of stale.rows) {
      const newest = row.newest === null ? null : Number(row.newest);
      const key = `proof_stale:${row.farmer_id}:${row.warehouse_id}`;
      if (newest === null || today - newest >= MAX_PROOF_AGE_DAYS) {
        // Only page once the farmer has had a full statement interval.
        const first = await this.pool.query<{ first: Date | null }>(
          `SELECT min(recorded_at) AS first FROM book_entries WHERE farmer_id = $1 AND warehouse_id = $2`,
          [row.farmer_id, row.warehouse_id],
        );
        const since = first.rows[0]?.first;
        if (since && now.getTime() - since.getTime() < MAX_PROOF_AGE_DAYS * DAY_MS) continue;
        await this.alerts.raise({
          key,
          severity: 'page',
          category: 'proofs',
          message: `A farmer holding stock has no balance proof under ${MAX_PROOF_AGE_DAYS} days old`,
          details: { farmer_id: row.farmer_id, warehouse_id: row.warehouse_id, newest_day: newest },
        });
      } else {
        await this.alerts.resolve(key);
      }
    }
  }

  /** The public bundle behind a link token; no login, and nothing to verify against here. */
  async byToken(token: string): Promise<ProofBundle | null> {
    const { rows } = await this.pool.query<{ bundle: ProofBundle }>(
      'SELECT bundle FROM proof_deliveries WHERE token = $1',
      [token],
    );
    return rows[0]?.bundle ?? null;
  }

  async statementByToken(token: string): Promise<{ day: number; bundles: ProofBundle[] } | null> {
    const { rows } = await this.pool.query<{ day: number; bundle: ProofBundle }>(
      `SELECT s.day, p.bundle FROM farmer_statements s
         JOIN proof_deliveries p ON p.statement_id = s.id
        WHERE s.token = $1 ORDER BY p.created_at`,
      [token],
    );
    if (rows.length === 0) return null;
    return { day: rows[0]?.day ?? 0, bundles: rows.map((r) => r.bundle) };
  }

  /**
   * `later_days` for any warehouse, served publicly from the archive so an
   * old bundle can still be checked. They need not be trusted: the chain's
   * head checks them.
   */
  async laterDays(
    warehouseSymbol: string,
    afterDay: number,
  ): Promise<{ day: number; leaves: number; root: string }[]> {
    const { rows } = await this.pool.query<{ day: number; leaves: number; root: string }>(
      `SELECT day, leaves, root FROM chain_anchors
        WHERE contract_id = $1 AND warehouse_symbol = $2 AND day > $3 ORDER BY day`,
      [this.chain.contractId, warehouseSymbol, afterDay],
    );
    return rows;
  }

  private link(path: string): string {
    return `${this.config.proofs.linkBaseUrl}/${path}`;
  }
}

function newToken(): string {
  return randomBytes(18).toString('base64url');
}
