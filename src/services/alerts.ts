import type { Queryable } from '../db/pool.js';
import type { Logger } from '../logger.js';

export type AlertSeverity = 'warning' | 'page' | 'urgent';

export interface Alert {
  /** Stable per problem, e.g. `anchor_missed:<warehouse>:<day>`: a repeat bumps the open alert. */
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly category: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Pages and warnings from jobs and checks. Each is written to `alerts` (one
 * open row per key) and logged at error level for `page`/`urgent`, which is
 * what an on-call integration (PagerDuty, Opsgenie) picks up. A real pager
 * adapter is a later swap behind this class (docs/decisions.md D39).
 */
export class AlertService {
  constructor(
    private readonly db: Queryable,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async raise(alert: Alert): Promise<void> {
    const now = this.clock();
    await this.db.query(
      `INSERT INTO alerts (alert_key, severity, category, message, details, first_raised_at,
                           last_raised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (alert_key) WHERE resolved_at IS NULL DO UPDATE
         SET last_raised_at = EXCLUDED.last_raised_at,
             raise_count = alerts.raise_count + 1,
             message = EXCLUDED.message,
             details = EXCLUDED.details,
             -- An alert only ever escalates while open.
             severity = CASE
               WHEN alerts.severity = 'urgent' OR EXCLUDED.severity = 'urgent' THEN 'urgent'
               WHEN alerts.severity = 'page' OR EXCLUDED.severity = 'page' THEN 'page'
               ELSE 'warning' END`,
      [
        alert.key,
        alert.severity,
        alert.category,
        alert.message,
        JSON.stringify(alert.details ?? {}),
        now,
      ],
    );
    const log = { alert: alert.key, category: alert.category, ...alert.details };
    if (alert.severity === 'warning') this.logger.warn(log, alert.message);
    else this.logger.error({ ...log, page: true, severity: alert.severity }, alert.message);
  }

  async resolve(key: string): Promise<void> {
    await this.db.query(
      'UPDATE alerts SET resolved_at = $2 WHERE alert_key = $1 AND resolved_at IS NULL',
      [key, this.clock()],
    );
  }

  async open(category?: string): Promise<{ key: string; severity: AlertSeverity }[]> {
    const { rows } = await this.db.query<{ alert_key: string; severity: AlertSeverity }>(
      `SELECT alert_key, severity FROM alerts
        WHERE resolved_at IS NULL AND ($1::text IS NULL OR category = $1)
        ORDER BY first_raised_at`,
      [category ?? null],
    );
    return rows.map((row) => ({ key: row.alert_key, severity: row.severity }));
  }
}
