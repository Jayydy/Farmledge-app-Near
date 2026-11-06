import { isUuid } from '../../domain/ids.js';
import { NotFoundError } from '../errors.js';

/**
 * A UUID path parameter, lower-cased. Anything that is not a UUID cannot
 * name a record, so it is a 404 rather than a database type error.
 */
export function uuidParam(value: string, what: string): string {
  if (!isUuid(value)) throw new NotFoundError(`${what} not found`);
  return value.toLowerCase();
}
