import { z } from 'zod';

import { domainError, fail, ok, type DomainError, type Result } from '../domain/errors.js';
import { isIsoDate } from '../domain/dates.js';
import { isUuid } from '../domain/ids.js';
import { ValidationError } from './errors.js';

/**
 * Request shape checking: fields present with the right JSON types. It
 * deliberately knows nothing about business rules (grades, limits, phone
 * formats); those live in `src/domain/` so they can be unit-tested alone.
 * Failures use the same `{ code, field, message }` form as domain errors.
 */

export const uuid = () => z.string().refine(isUuid, { message: 'must be a UUID' });

/** A grade: its code (`"G1"`), or a whole number for numeric codes (`1`). */
export const grade = () =>
  z.union([z.number(), z.string()], { error: 'must be a grade code (string) or a number' });

/** Checks `input` against `schema`, reporting every problem as a DomainError. */
export function checkShape<S extends z.ZodType>(schema: S, input: unknown): Result<z.output<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return fail(parsed.error.issues.map((issue) => toDomainError(issue, input)));
}

function toDomainError(issue: z.core.$ZodIssue, input: unknown): DomainError {
  const field = issue.path.map(String).join('.') || '(body)';
  if (issue.code === 'invalid_type' && valueAt(input, issue.path) === undefined) {
    return domainError('required', field, `${field} is required`);
  }
  if (issue.code === 'custom') {
    return domainError('invalid_id', field, `${field} ${issue.message}`);
  }
  if (issue.code === 'invalid_union') {
    return domainError('invalid_type', field, `${field} ${issue.message}`);
  }
  if (issue.code === 'invalid_type') {
    return domainError('invalid_type', field, `${field} must be ${article(issue.expected)}`);
  }
  return domainError('invalid_type', field, `${field}: ${issue.message}`);
}

function article(expected: string): string {
  return /^[aeiou]/.test(expected) ? `an ${expected}` : `a ${expected}`;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** Returns the value, or throws a 400 listing every error. */
export function orThrow<T>(result: Result<T>, message = 'Request is invalid'): T {
  if (!result.ok) throw new ValidationError(message, { details: result.errors });
  return result.value;
}

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  return orThrow(checkShape(schema, body));
}

/** Query parameters are strings (or arrays when repeated); anything else is rejected. */
export function queryString(query: unknown, name: string): string | undefined {
  const value = (query as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError('Request is invalid', {
      details: [domainError('invalid_type', name, `${name} must be given once`)],
    });
  }
  return value;
}

export function queryUuid(query: unknown, name: string): string | undefined {
  const value = queryString(query, name);
  if (value !== undefined && !isUuid(value)) {
    throw new ValidationError('Request is invalid', {
      details: [domainError('invalid_id', name, `${name} must be a UUID`)],
    });
  }
  return value?.toLowerCase();
}

/** Optional ISO timestamp query parameter. */
export function queryTimestamp(query: unknown, name: string): Date | undefined {
  const value = queryString(query, name);
  if (value === undefined) return undefined;
  const parsed = /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) {
    throw new ValidationError('Request is invalid', {
      details: [domainError('invalid_type', name, `${name} must be an ISO 8601 date or timestamp`)],
    });
  }
  return parsed;
}

/** Optional `YYYY-MM-DD` query parameter. */
export function queryDate(query: unknown, name: string): string | undefined {
  const value = queryString(query, name);
  if (value !== undefined && !isIsoDate(value)) {
    throw new ValidationError('Request is invalid', {
      details: [domainError('invalid_date', name, `${name} must be a date written YYYY-MM-DD`)],
    });
  }
  return value;
}

/** Optional whole-number `limit` query parameter. */
export function queryLimit(query: unknown, fallback: number, max: number): number {
  const text = queryString(query, 'limit');
  const limit = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ValidationError('Request is invalid', {
      details: [
        domainError('invalid_query', 'limit', `limit must be a whole number from 1 to ${max}`),
      ],
    });
  }
  return limit;
}

/** Throws a 400 for one query parameter. */
export function invalidQuery(field: string, message: string): ValidationError {
  return new ValidationError('Request is invalid', {
    details: [domainError('invalid_query', field, message)],
  });
}
