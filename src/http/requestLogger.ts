import { randomUUID } from 'node:crypto';

import { pinoHttp } from 'pino-http';

import type { Logger } from '../logger.js';

const REQUEST_ID_HEADER = 'x-request-id';
const INCOMING_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Logs one line per request and gives each request an ID, reusing a
 * well-formed incoming `X-Request-Id` so IDs can be traced across services.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id =
        typeof incoming === 'string' && INCOMING_ID_PATTERN.test(incoming)
          ? incoming
          : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
}
