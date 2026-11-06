import type { GradingConfig } from '../config/index.js';
import { domainError, type DomainError } from './errors.js';

/**
 * Grades are codes of a named grading scheme (docs/decisions.md D11). The
 * scheme and its codes come from config, and every stored grade carries the
 * scheme it belongs to, so adopting a named standard later is a config
 * change: no migration, and old grades are never silently reinterpreted.
 */

/**
 * The API accepts a grade as a code (`"G1"`) or, for the provisional numeric
 * grades, a whole number (`1`), and always returns the code (`"1"`).
 * Returns null for anything else.
 */
export function gradeCode(value: number | string): string | null {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null;
  const code = value.trim();
  return code === '' ? null : code;
}

/** The grade's code if it belongs to the configured scheme; otherwise records an error. */
export function checkGrade(
  value: number | string,
  grading: GradingConfig,
  errors: DomainError[],
  field = 'grade',
): string | null {
  const code = gradeCode(value);
  if (code === null || !grading.grades.includes(code)) {
    errors.push(
      domainError('invalid_grade', field, `Grade must be one of ${grading.grades.join(', ')}`),
    );
    return null;
  }
  return code;
}
