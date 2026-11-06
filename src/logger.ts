import { pino, type Logger } from 'pino';

import type { Config } from './config/index.js';

export type { Logger };

export function createLogger(level: Config['logLevel']): Logger {
  return pino({
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  });
}
