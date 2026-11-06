import type { ErrorRequestHandler, RequestHandler } from 'express';

import {
  AppError,
  NotFoundError,
  PayloadTooLargeError,
  TooManyRequestsError,
  ValidationError,
} from './errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
};

/**
 * Turns any thrown error into a consistent JSON body:
 * `{ error: { code, message, details? }, requestId }`.
 * Unknown errors become a generic 500 so internals never leak to clients.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);
  if (appError === null) {
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({
      error: { code: 'internal_error', message: 'Internal server error' },
      requestId: req.id,
    });
    return;
  }

  if (appError.status >= 500) {
    req.log.error({ err: appError }, appError.message);
  }
  if (appError instanceof TooManyRequestsError) {
    res.set('Retry-After', String(appError.retryAfterSeconds));
  }
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
    requestId: req.id,
  });
};

/** Maps our own errors and Express's body-parser errors; null means "unexpected". */
function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) {
    return err;
  }
  if (typeof err === 'object' && err !== null && 'type' in err) {
    if (err.type === 'entity.parse.failed') {
      return new ValidationError('Request body is not valid JSON', { cause: err });
    }
    if (err.type === 'entity.too.large') {
      return new PayloadTooLargeError('Request body is too large', { cause: err });
    }
  }
  return null;
}
