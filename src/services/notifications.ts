import type pg from 'pg';

import type { Queryable } from '../db/pool.js';
import type { SmsTemplate } from '../domain/smsTemplates.js';
import type { Logger } from '../logger.js';
import type { SmsGateway } from '../sms/smsGateway.js';

export interface QueuedNotification {
  readonly farmerId: string;
  readonly template: SmsTemplate;
  readonly body: string;
}

/**
 * Outbound SMS in two steps: `queue` writes a `notifications` row inside
 * the business transaction (so a message exists exactly when the deposit or
 * dispatch does), and `deliver` sends after commit. A failed send marks the
 * row failed and is logged; it never fails the request that caused it.
 */
export class NotificationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly gateway: SmsGateway,
    private readonly logger: Logger,
  ) {}

  /** Returns the notification id, or null when the farmer is unknown. */
  async queue(db: Queryable, notification: QueuedNotification): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO notifications (farmer_id, to_phone, template, body)
       SELECT id, phone, $2, $3 FROM farmers WHERE id = $1
       RETURNING id`,
      [notification.farmerId, notification.template, notification.body],
    );
    return rows[0]?.id ?? null;
  }

  /** Sends queued notifications; call after the transaction that queued them commits. */
  async deliver(ids: readonly (string | null)[]): Promise<void> {
    for (const id of ids) {
      if (id !== null) await this.deliverOne(id);
    }
  }

  private async deliverOne(id: string): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ to_phone: string; body: string }>(
        `SELECT to_phone, body FROM notifications WHERE id = $1 AND status = 'queued'`,
        [id],
      );
      const row = rows[0];
      if (row === undefined) return;
      try {
        const { messageId } = await this.gateway.send({ to: row.to_phone, body: row.body });
        await this.pool.query(
          `UPDATE notifications SET status = 'sent', provider = $2, provider_message_id = $3,
                  sent_at = now() WHERE id = $1`,
          [id, this.gateway.provider, messageId],
        );
      } catch (err) {
        this.logger.warn({ err, notificationId: id }, 'SMS send failed');
        await this.pool.query(
          `UPDATE notifications SET status = 'failed', provider = $2, error = $3 WHERE id = $1`,
          [id, this.gateway.provider, err instanceof Error ? err.message : String(err)],
        );
      }
    } catch (err) {
      this.logger.error({ err, notificationId: id }, 'could not deliver notification');
    }
  }
}
