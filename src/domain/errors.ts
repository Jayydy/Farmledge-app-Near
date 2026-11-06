/**
 * Business-rule failures. Every rule reports a stable machine-readable
 * `code`, the API `field` it concerns and a message fit to show a custodian.
 * Rules collect every failure rather than stopping at the first, so a
 * tablet can fix a form in one pass.
 */
export type DomainErrorCode =
  // Request shape (produced by the HTTP layer with the same structure)
  | 'required'
  | 'invalid_type'
  | 'invalid_id'
  | 'invalid_batch_size'
  | 'invalid_query'
  // Deposits
  | 'invalid_deposit_id'
  | 'unsupported_commodity'
  | 'invalid_grade'
  | 'invalid_moisture'
  | 'moisture_out_of_range'
  | 'invalid_bag_count'
  | 'bag_count_too_large'
  | 'bag_count_needs_confirmation'
  | 'invalid_captured_at'
  | 'captured_at_in_future'
  | 'captured_at_too_old'
  | 'notes_too_long'
  // Farmers
  | 'invalid_name'
  | 'invalid_phone'
  | 'consent_required'
  // Staff sign-in
  | 'invalid_pin'
  // Scale samples and audits
  | 'invalid_sample_id'
  | 'invalid_bags_weighed'
  | 'invalid_kg'
  | 'invalid_counted_bags'
  | 'invalid_counted_by'
  | 'invalid_witnessed_by'
  | 'audit_actor_required'
  | 'witness_is_custodian'
  // References to other records
  | 'warehouse_not_found'
  | 'warehouse_inactive'
  | 'custodian_not_found'
  | 'custodian_suspended'
  | 'custodian_wrong_warehouse'
  | 'verifier_not_found'
  | 'verifier_suspended'
  | 'verifier_wrong_warehouse'
  | 'farmer_not_found'
  | 'farmer_not_at_warehouse'
  // Stock ledger, dispatch and adjustments
  | 'invalid_dispatch_id'
  | 'invalid_adjustment_id'
  | 'unknown_lot'
  | 'mixed_adjustment_needs_lot'
  // Pledges
  | 'invalid_lender'
  | 'invalid_loan_ref'
  | 'invalid_due_date'
  | 'invalid_pledge_kg'
  | 'invalid_bags_delta'
  | 'invalid_kg_delta'
  | 'empty_adjustment'
  | 'invalid_reason'
  | 'notes_required'
  | 'buyer_name_too_long'
  | 'not_weighed_reason_required'
  | 'not_weighed_reason_with_weight'
  | 'farmer_confirmation_required'
  // Fees, payments, prices
  | 'invalid_date'
  | 'date_in_future'
  | 'invalid_amount'
  | 'invalid_reference'
  | 'invalid_method'
  | 'invalid_basis'
  | 'invalid_period'
  | 'invalid_rate'
  | 'invalid_minimum_days'
  | 'invalid_model'
  | 'invalid_price'
  | 'invalid_grading_scheme'
  // Owners, cancellations, reversals
  | 'owner_not_found'
  | 'owner_suspended'
  | 'owner_wrong_warehouse'
  | 'reason_required'
  | 'invalid_tolerance'
  // Admins and role assignments
  | 'admin_not_found'
  | 'admin_suspended'
  | 'invalid_owner_subject';

export interface DomainError {
  readonly code: DomainErrorCode;
  /** The API field name the error concerns, e.g. `bag_count`. */
  readonly field: string;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly DomainError[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(errors: readonly DomainError[]): Result<T> {
  return { ok: false, errors };
}

export function domainError(code: DomainErrorCode, field: string, message: string): DomainError {
  return { code, field, message };
}
