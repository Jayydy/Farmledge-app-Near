import { loadConfig } from '../config/index.js';
import { assertDatabaseEnvironment } from '../db/environmentGuard.js';
import { createPool } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { AdminService } from '../services/admin.js';
import { AppError } from '../http/errors.js';

/**
 * `npm run create-admin -- --name="..." --phone=... --reason="..." --operator="..."`.
 * Creates a Farmledge admin, who can then set up warehouse owners. The only
 * way to create an admin: there is no endpoint for it. The assignment is
 * logged with the operator and reason.
 */
const USAGE =
  'Usage: create-admin --name="Full Name" --phone=+234... --reason="why" --operator="your name"';

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const name = option('name');
const phone = option('phone');
const reason = option('reason');
const operator = option('operator');
if (name === undefined || phone === undefined || reason === undefined || operator === undefined) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.database.url, logger);
  try {
    await assertDatabaseEnvironment(pool, config.environment);
    const { admin, assignment } = await new AdminService(pool).createAdmin({
      fullName: name,
      phone,
      reason,
      operator,
    });
    console.log(
      `Created admin ${admin.full_name} (${admin.id}) on ${config.environment}; ` +
        `assignment ${assignment.id} logged for ${assignment.operator ?? operator}`,
    );
  } finally {
    await pool.end();
  }
} catch (err) {
  if (err instanceof AppError && err.details !== undefined) {
    console.error(err.message, JSON.stringify(err.details));
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
}
