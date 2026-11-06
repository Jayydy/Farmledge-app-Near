import { ConfigError, loadConfig } from './config/index.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  // The logger isn't configured yet, so report straight to stderr.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const logger = createLogger(config.logLevel);

let running;
try {
  running = await startServer(config, logger);
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
}

const server = running;
let signalled = false;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (signalled) {
      logger.warn({ signal }, 'second signal received; exiting immediately');
      process.exit(1);
    }
    signalled = true;
    logger.info({ signal }, 'signal received');
    server.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.fatal({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
