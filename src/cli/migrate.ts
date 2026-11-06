import { loadConfig } from '../config/index.js';
import { runMigrations } from '../db/migrate.js';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('Usage: migrate <up|down>');
  process.exit(2);
}

try {
  const config = loadConfig(process.env);
  const applied = await runMigrations({
    databaseUrl: config.database.url,
    environment: config.environment,
    direction,
    log: (message) => {
      console.log(message);
    },
  });
  console.log(
    applied.length === 0
      ? `Nothing to migrate (${config.environment} database is up to date).`
      : `${direction === 'up' ? 'Applied' : 'Rolled back'} on ${config.environment} database: ${applied.join(', ')}`,
  );
} catch (err) {
  // ConfigError and the environment guard errors carry a readable message; no stack needed.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
