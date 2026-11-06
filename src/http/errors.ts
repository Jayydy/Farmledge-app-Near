interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class for errors that map to an HTTP response. The message and
 * details are shown to the client, so never put secrets or internals in them.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
  }
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = 'validation_failed';
}

/** 401: no valid staff session. `code` says why, e.g. `invalid_credentials`. */
export class UnauthorizedError extends AppError {
  readonly status = 401;
  readonly code: string;

  constructor(message: string, options: AppErrorOptions & { code: string }) {
    super(message, options);
    this.code = options.code;
  }
}

/** 429: too many attempts; `retryAfterSeconds` goes out as a Retry-After header. */
export class TooManyRequestsError extends AppError {
  readonly status = 429;
  readonly code = 'too_many_attempts';
  readonly retryAfterSeconds: number;

  constructor(message: string, options: AppErrorOptions & { retryAfterSeconds: number }) {
    super(message, options);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** 403: the named person may not do this, e.g. `owner_required`. */
export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code: string;

  constructor(message: string, options: AppErrorOptions & { code: string }) {
    super(message, options);
    this.code = options.code;
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = 'not_found';
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly code: string;

  /** `code` names the specific conflict (e.g. `deposit_id_conflict`); defaults to `conflict`. */
  constructor(message: string, options: AppErrorOptions & { code?: string } = {}) {
    super(message, options);
    this.code = options.code ?? 'conflict';
  }
}

export class PayloadTooLargeError extends AppError {
  readonly status = 413;
  readonly code = 'payload_too_large';
}

export class UnsupportedMediaTypeError extends AppError {
  readonly status = 415;
  readonly code = 'unsupported_media_type';
}

export class ServiceUnavailableError extends AppError {
  readonly status = 503;
  readonly code = 'service_unavailable';
}

/**
 * 501. `feature_disabled`: switched off by a flag (e.g. LENDING_ENABLED).
 * `not_implemented`: switched on, but only a stub exists in this build.
 */
export class NotImplementedError extends AppError {
  readonly status = 501;
  readonly code: 'feature_disabled' | 'not_implemented';

  constructor(
    message: string,
    options: AppErrorOptions & { code: 'feature_disabled' | 'not_implemented' },
  ) {
    super(message, options);
    this.code = options.code;
  }
}
