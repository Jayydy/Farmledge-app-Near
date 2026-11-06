import { loadConfig } from '../config/index.js';
import { assertDatabaseEnvironment } from '../db/environmentGuard.js';
import { createPool } from '../db/pool.js';
import { isIsoDate } from '../domain/dates.js';
import { createLogger } from '../logger.js';
import { MockSmsGateway } from '../sms/mockSmsGateway.js';
import { NotificationService } from '../services/notifications.js';
import { StorageFeeService } from '../services/storageFees.js';

/**
 * `npm run accrue-fees [-- --through=YYYY-MM-DD]`. Accrues storage fees
 * through the given business date (default: yesterday). Run daily from cron;
 * safe to re-run, as a repeat adds nothing.
 */
const arg = process.argv.slice(2).find((value) => value.startsWith('--through='));
const through = arg?.slice('--through='.length);
if (through !== undefined && !isIsoDate(through)) {
  console.error('Usage: accrue-fees [--through=YYYY-MM-DD]');
  process.exit(2);
}

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.database.url, logger);
  try {
    await assertDatabaseEnvironment(pool, config.environment);
    // The job sends no SMS; the gateway is only there to satisfy the service.
    const notifications = new NotificationService(pool, new MockSmsGateway(logger), logger);
    const run = await new StorageFeeService(pool, config, notifications).runAccrual(through);
    console.log(
      `Accrued ${run.from_date}..${run.through_date} on ${config.environment}: ` +
        `${run.rows_written} rows, ${run.amount_ngn.toFixed(2)} NGN`,
    );
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
