/**
 * TEMPORARY: hand-copied API wire types.
 *
 * These mirror the API's request bodies and responses as JSON (timestamps
 * are strings). They move to `packages/shared` in the monorepo PR, where
 * the API will import the same definitions, so an API change breaks this
 * app's build instead of failing at runtime in a warehouse. Until then,
 * keep them in step by hand. Sources:
 *
 *   src/http/routes/deposits.ts, src/services/deposits.ts   deposits, batch, slip
 *   src/http/routes/farmers.ts,  src/services/farmers.ts    farmers, directory
 *   src/http/routes/scaleSamples.ts, src/services/scaleSamples.ts
 *   src/http/routes/photos.ts,   src/services/photos.ts
 *   src/http/routes/auth.ts,     src/services/auth.ts       sign-in, roster
 *   src/http/routes/provisions.ts                           GET /features
 *   src/http/routes/dispatches.ts, src/services/dispatches.ts  dispatch, plan, delivery note, blocked
 *   src/http/routes/ledger.ts,   src/services/ledger.ts     balance, lots (D54)
 *   src/http/routes/storageFees.ts, src/services/storageFees.ts  statement
 *   src/http/errorHandler.ts, src/domain/errors.ts          error body, codes
 */

// ---- Errors ---------------------------------------------------------------

/** `src/domain/errors.ts` DomainErrorCode, the codes intake can meet. */
export type DomainErrorCode =
  | 'required'
  | 'invalid_type'
  | 'invalid_id'
  | 'invalid_batch_size'
  | 'invalid_query'
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
  | 'invalid_name'
  | 'invalid_phone'
  | 'consent_required'
  | 'invalid_pin'
  | 'invalid_sample_id'
  | 'invalid_bags_weighed'
  | 'invalid_kg'
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
  | 'actor_mismatch'
  | 'unknown_lot'
  | 'not_weighed_reason_required'
  | 'not_weighed_reason_with_weight'
  | 'farmer_confirmation_required'
  | 'invalid_counted_bags'
  | 'invalid_counted_by'
  | 'invalid_witnessed_by'
  | 'audit_actor_required'
  | 'witness_is_custodian';

export interface DomainErrorDetail {
  code: DomainErrorCode | (string & {});
  field: string;
  message: string;
}

/** Top-level error codes intake can meet (AppError subclasses' `code`). */
export type ApiErrorCode =
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'deposit_id_conflict'
  | 'sample_id_conflict'
  | 'farmer_already_registered'
  | 'photo_limit_reached'
  | 'scale_samples_exceed_bags'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'service_unavailable'
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'authentication_required'
  | 'session_invalid'
  | 'actor_mismatch'
  | 'insufficient_balance'
  | 'lot_governed_on_chain'
  | 'dispatch_id_conflict'
  | 'id_conflict'
  | 'audit_completed'
  | 'audit_line_exists'
  | 'internal_error';

export interface ApiErrorBody {
  error: { code: ApiErrorCode | (string & {}); message: string; details?: unknown };
  requestId?: string;
}

// ---- Features (GET /features) ---------------------------------------------

export type Commodity = 'MAIZE_WHITE' | 'MAIZE_YELLOW';

export interface Features {
  lending_enabled: boolean;
  chain_enabled: boolean;
  confirmation_mode: string;
  weight_mode: 'bag_estimate' | 'scale_required';
  /**
   * D56: whose record decides a release Farmledge can't confirm. Missing
   * from an older API's answer: treated as `paper`.
   */
  release_authority?: 'paper' | 'farmledge';
  grading: { scheme: string; grades: string[] };
  business_timezone: string;
  auth_required: boolean;
  intake: {
    commodities: {
      code: Commodity;
      bag_size_kg: number;
      moisture_pct: { min: number; max: number };
    }[];
    bag_count_max: number;
    bag_count_confirm_above: number;
    offline_review_after_hours: number;
    offline_reject_after_hours: number;
    notes_max_length: number;
    photos: { max_per_deposit: number; max_bytes: number; types: string[] };
  };
}

// ---- Staff sign-in (POST /auth/sessions) -----------------------------------

export interface SignInRequest {
  phone: string;
  pin: string;
}

export interface SessionView {
  session: { id: string; expires_at: string };
  custodian: { id: string; full_name: string; phone: string };
  warehouse: { id: string; code: string; name: string };
  /** Active verifiers assigned to this warehouse (D44). */
  roster: { verifiers: { id: string; full_name: string }[] };
}

export interface SignInResponse extends SessionView {
  token: string;
}

// ---- Farmers ---------------------------------------------------------------

export interface RegisterFarmerRequest {
  full_name: string;
  phone: string;
  warehouse_id: string;
  registered_by: string;
  consent: boolean;
  lookup_consent?: boolean | null;
}

export interface FarmerView {
  id: string;
  full_name: string;
  phone: string;
  lookup_consent: boolean;
  data_consent_at: string | null;
  created_at: string;
  warehouses: { warehouse_id: string; registered_by: string; registered_at: string }[];
}

export interface RegisterFarmerResponse {
  farmer: FarmerView;
  farmer_created: boolean;
}

/** `details` of a 409 `farmer_already_registered`. */
export interface FarmerAlreadyRegisteredDetails {
  farmer_id: string;
}

export interface FindFarmerResponse {
  items: FarmerView[];
}

export interface FarmerDirectoryEntry {
  id: string;
  phone: string;
  full_name: string;
}

export interface FarmerDirectoryPage {
  items: FarmerDirectoryEntry[];
  next_cursor: string | null;
}

// ---- Deposits ----------------------------------------------------------------

export interface DepositRequest {
  /** UUID generated on the tablet: the idempotency key. */
  deposit_id: string;
  farmer_id: string;
  warehouse_id: string;
  custodian_id: string;
  verifier_id: string;
  commodity: Commodity;
  grade: string;
  /** Percentage, at most one decimal. */
  moisture_pct: number;
  bag_count: number;
  confirm_bag_count?: boolean | null;
  notes?: string | null;
  /** ISO 8601 with offset; required in a batch. */
  captured_at: string;
}

export interface DepositView {
  deposit_id: string;
  deposit_no: number;
  farmer_id: string;
  warehouse_id: string;
  custodian_id: string;
  verifier_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  moisture_pct: number;
  bag_count: number;
  bag_count_confirmed: boolean;
  bag_size_kg: number;
  weight_kg: number | null;
  weight_source: string;
  status: string;
  notes: string | null;
  captured_at: string;
  created_at: string;
  needs_review: boolean;
  review_reasons: string[];
  photo_count: number;
  scale_samples: { count: number; bags_weighed: number; total_kg: number | null };
}

export const MAX_BATCH_ITEMS = 100;

export interface BatchRequest {
  items: DepositRequest[];
}

export type BatchItemResult =
  | {
      index: number;
      deposit_id: string | null;
      status: 'created' | 'duplicate';
      deposit: DepositView;
    }
  | {
      index: number;
      deposit_id: string | null;
      status: 'rejected';
      error: { code: string; message: string; details?: unknown };
    };

export interface BatchResponse {
  summary: { created: number; duplicate: number; rejected: number };
  results: BatchItemResult[];
}

/** One leaf on the counter slip (`src/services/book.ts` SlipEntry). */
export interface SlipEntry {
  leaf: Record<string, unknown> & { index: number | null };
  /** The leaf and its salt as compact JSON: what the slip's QR code carries. */
  qr_payload: string;
  anchored: boolean;
}

export interface DepositSlip {
  deposit: DepositView;
  proofs: SlipEntry[];
  /** The names a slip prints, so any tablet at the warehouse can reprint it (API D46). */
  printable: {
    warehouse: { code: string; name: string };
    farmer: { full_name: string; phone: string };
    custodian: { full_name: string };
    verifier: { full_name: string };
  };
}

export interface DepositPage {
  items: DepositView[];
  next_cursor: string | null;
}

// ---- Scale samples -------------------------------------------------------------

export interface ScaleSampleRequest {
  /** UUID generated on the tablet: the idempotency key. */
  sample_id: string;
  bags_weighed: number;
  total_kg: number;
  recorded_by: string;
  recorded_at?: string | null;
}

export interface ScaleSampleView {
  id: string;
  sample_id: string | null;
  deposit_id: string;
  bags_weighed: number;
  total_kg: number;
  kg_per_bag: number;
  recorded_by: string;
  recorded_at: string;
}

export interface ScaleSampleResponse {
  scale_sample: ScaleSampleView;
  duplicate: boolean;
}

// ---- Photos -------------------------------------------------------------------------

export type PhotoType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PhotoView {
  id: string;
  deposit_id: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  created_at: string;
}

export interface PhotoUploadResponse {
  photo: PhotoView;
  duplicate: boolean;
}

// ---- Balance and lots (D54) -----------------------------------------------------------

/** GET /farmers/:id/balance: one line per commodity and grade, split free / held on-chain. */
export interface BalanceLine {
  warehouse_id: string;
  farmer_id: string;
  commodity: Commodity;
  grading_scheme: string;
  grade: string;
  bags: number;
  kg: number;
  free_bags: number;
  free_kg: number;
  held_on_chain_bags: number;
  held_on_chain_kg: number;
  held_on_chain_lots: number[];
}

export interface BalanceResponse {
  farmer_id: string;
  items: BalanceLine[];
}

export type LotState = 'free' | 'pledged' | 'minted';

/** GET /farmers/:id/lots?warehouse=: oldest first. */
export interface LotView {
  deposit_id: string;
  deposit_no: number;
  commodity: Commodity;
  grading_scheme: string;
  grade: string;
  intake_at: string;
  bags: number;
  kg: number;
  state: LotState;
  receipt_id: string | null;
  /** The API's reason in English; the app shows its own words, from `state`. */
  excluded_reason: string | null;
}

export interface LotsResponse {
  farmer_id: string;
  warehouse_id: string;
  items: LotView[];
}

// ---- Dispatch -----------------------------------------------------------------------

export interface LotDrawn {
  deposit_id: string;
  deposit_no: number;
  bags: number;
  kg: number;
}

export interface BalanceSplit {
  free_bags: number;
  free_kg: number;
  held_on_chain_bags: number;
  held_on_chain_kg: number;
  held_on_chain_lots: number[];
}

/** POST /dispatches/plan: records nothing. */
export interface DispatchPlanRequest {
  warehouse_id: string;
  farmer_id: string;
  custodian_id: string;
  commodity: Commodity;
  grade: string;
  bag_count: number;
  deposit_id?: string | null;
}

export interface DispatchPlan {
  lots_drawn: LotDrawn[];
  book_kg: number;
  balance_after: BalanceSplit;
}

export interface DispatchRequest {
  /** UUID generated on the tablet when the dispatch starts: the idempotency key. */
  dispatch_id: string;
  warehouse_id: string;
  farmer_id: string;
  custodian_id: string;
  commodity: Commodity;
  grade: string;
  bag_count: number;
  exit_weight_kg?: number | null;
  /** Required without exit_weight_kg, refused with it (D54). */
  not_weighed_reason?: string | null;
  farmer_confirmed: true;
  deposit_id?: string | null;
}

export interface DispatchView {
  dispatch_id: string;
  warehouse_id: string;
  farmer_id: string;
  commodity: Commodity;
  grade: string;
  bag_count: number;
  book_kg: number;
  exit_weight_kg: number | null;
  not_weighed_reason: string | null;
  delivery_note_no: string;
  status: string;
  dispatched_at: string;
  lots_drawn: LotDrawn[];
}

/** GET /dispatches/:id */
export interface DispatchReadResponse {
  dispatch: DispatchView;
}

export interface DispatchResponse {
  dispatch: DispatchView;
  duplicate: boolean;
}

/** 409 insufficient_balance / lot_governed_on_chain details. */
export interface InsufficientBalanceDetails {
  available_bags: number;
  available_kg: number;
}

/** GET /dispatches/:id/delivery-note */
export interface DeliveryNote {
  delivery_note_no: string;
  environment: string;
  issued_at: string;
  warehouse: { code: string; name: string; state: string; lga: string; address: string | null };
  farmer: { id: string; full_name: string; phone: string };
  custodian: { id: string; full_name: string };
  buyer_name: string | null;
  goods: {
    commodity: Commodity;
    grading_scheme: string;
    grade: string;
    bags: number;
    book_kg: number;
    exit_weight_kg: number | null;
    not_weighed_reason: string | null;
  };
  farmer_confirmation: { mode: string; status: string; decided_at: string | null };
  dispatch_id: string;
  lots_drawn: LotDrawn[];
  balance_after: BalanceSplit;
  proofs: SlipEntry[];
}

export interface DeliveryNoteResponse {
  delivery_note: DeliveryNote;
}

/** POST /warehouses/:id/dispatch-blocked: when, who, how long offline. Nothing else (D54). */
export interface DispatchBlockedRequest {
  id: string;
  custodian_id: string;
  blocked_at: string;
  offline_since?: string | null;
}

// ---- Statement (GET /farmers/:id/statement) ---------------------------------------------

export interface StatementMovement {
  date: string;
  occurred_at: string;
  kind: string;
  commodity: Commodity;
  grading_scheme: string;
  grade: string;
  bags_delta: number;
  kg_delta: number;
  deposit_id: string | null;
  dispatch_id: string | null;
  delivery_note_no: string | null;
  adjustment_id: string | null;
}

export interface FarmerStatement {
  farmer: { id: string; full_name: string; phone: string };
  warehouse: { id: string; code: string; name: string };
  period: { from: string; to: string };
  /** Last day fees are accrued for; later days are not charged yet. */
  accrued_through: string | null;
  stock: { movements: StatementMovement[] };
  fees: { closing_outstanding_ngn: number };
}

// ---- Daily summary (D57) -------------------------------------------------------------

/** GET /warehouses/:id/dispatch-blocked?from=&to=: refused offline, from every tablet there. */
export interface DispatchBlockedCount {
  warehouse_id: string;
  from: string | null;
  to: string | null;
  blocked: number;
}

/** GET /dispatches?warehouse=&from=&to= */
export interface DispatchList {
  items: DispatchView[];
}

export interface StockLine {
  commodity: Commodity;
  grading_scheme: string;
  grade: string;
  bags: number;
  kg: number;
  farmer_count: number;
  price_per_tonne_ngn: number | null;
  value_ngn: number | null;
}

/** GET /warehouses/:id/stock */
export interface StockSummary {
  warehouse_id: string;
  as_of: string;
  lines: StockLine[];
  totals: { bags: number; kg: number; value_ngn: number | null; unpriced_lines: number };
}

// ---- Stock audit (D9, D57) -------------------------------------------------------------

/** POST /audits. With a session, entered_by is the signed-in custodian. */
export interface AuditStartRequest {
  warehouse_id: string;
  entered_by: string;
  /** Who physically counted, as typed. */
  counted_by: string;
  /** Who watched; never a custodian of this warehouse. */
  witnessed_by: string;
  started_at?: string;
  notes?: string;
}

export interface AuditView {
  id: string;
  warehouse_id: string;
  conducted_by: string | null;
  entered_by: string | null;
  counted_by: string | null;
  witnessed_by: string | null;
  status: 'open' | 'completed';
  started_at: string;
  completed_at: string | null;
  notes: string | null;
}

/** POST /audits/:id/lines */
export interface AuditLineRequest {
  commodity: Commodity;
  grade: string;
  counted_bags: number;
  /** Left out: counted bags × bag size, reported as estimated. */
  counted_kg?: number;
}

export interface AuditLineView {
  id: string;
  audit_id: string;
  commodity: Commodity;
  grading_scheme: string;
  grade: string;
  recorded_bags: number;
  recorded_kg: number;
  counted_bags: number;
  counted_kg: number;
  counted_kg_estimated: boolean;
  variance_bags: number;
  variance_kg: number;
  notes: string | null;
}

export interface AuditDifference {
  recorded_bags: number;
  counted_bags: number;
  difference_bags: number;
  difference_bags_pct: number | null;
  recorded_kg: number;
  counted_kg: number;
  difference_kg: number;
  difference_kg_pct: number | null;
}

/** GET /audits/:id/report */
export interface AuditReport {
  audit: AuditView;
  lines: (AuditDifference & { commodity: Commodity; grade: string })[];
  totals: AuditDifference;
  /** Stock the system records that nobody counted. */
  uncounted: {
    commodity: Commodity;
    grading_scheme: string;
    grade: string;
    recorded_bags: number;
    recorded_kg: number;
  }[];
}
