import { createInterface } from 'node:readline/promises';

import { loadConfig } from '../config/index.js';
import { assertDatabaseEnvironment } from '../db/environmentGuard.js';
import { createPool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { createLogger } from '../logger.js';
import { AuthService } from '../services/auth.js';

/**
 * `npm run set-pin -- --phone=+234...`, then type the PIN (or pipe it in).
 * Sets a custodian's sign-in PIN and clears any lockout (docs/decisions.md
 * D41). The PIN is read from standard input, never from the command line,
 * so it stays out of shell history. There is no endpoint for this.
 */
const USAGE = 'Usage: set-pin --phone=+234... (the PIN is read from standard input)';

const phone = process.argv
  .slice(2)
  .find((value) => value.startsWith('--phone='))
  ?.slice('--phone='.length);
if (phone === undefined) {
  console.error(USAGE);
  process.exit(2);
}

const prompt = createInterface({ input: process.stdin, output: process.stderr });
const pin = (await prompt.question('PIN: ')).trim();
prompt.close();

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.database.url, logger);
  try {
    await assertDatabaseEnvironment(pool, config.environment);
    const sessionTtlHours = config.auth.sessionTtlHours;
    const custodian = await new AuthService(pool, sessionTtlHours).setPin(phone, pin);
    console.log(`PIN set for ${custodian.full_name} (${custodian.id}) on ${config.environment}`);
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
