-- Up Migration

-- Warehouse inventory (stock ledger, dispatch), storage fees, and the tables
-- behind the provisions for open decisions (docs/decisions.md). Every table
-- carries the environment marker and the standard triggers.

-- Rejects UPDATE, DELETE and TRUNCATE: ledger, fee and price history is
-- corrected by adding rows, never by changing old ones.
CREATE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE PROCEDURE make_append_only(target regclass)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION forbid_change()', target);
  EXECUTE format(
    'CREATE TRIGGER append_only_no_truncate BEFORE TRUNCATE ON %s
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', target);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grades become codes from a named grading scheme (provision h). Grades 1-3
-- are now the codes '1', '2', '3' of the scheme 'provisional'; a named
-- standard later is a config change, not a migration.
-- ---------------------------------------------------------------------------
ALTER TABLE deposits DROP CONSTRAINT deposits_grade_check;
ALTER TABLE deposits ALTER COLUMN grade TYPE TEXT USING grade::text;
ALTER TABLE deposits ADD CONSTRAINT deposits_grade_check
  CHECK (grade ~ '^[A-Za-z0-9._-]{1,32}$');
ALTER TABLE deposits ADD COLUMN grading_scheme TEXT NOT NULL DEFAULT 'provisional'
  CHECK (grading_scheme ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
ALTER TABLE deposits ALTER COLUMN grading_scheme DROP DEFAULT;

ALTER TABLE audit_lines DROP CONSTRAINT audit_lines_grade_check;
ALTER TABLE audit_lines DROP CONSTRAINT audit_lines_audit_id_commodity_grade_key;
ALTER TABLE audit_lines ALTER COLUMN grade TYPE TEXT USING grade::text;
ALTER TABLE audit_lines ADD CONSTRAINT audit_lines_grade_check
  CHECK (grade ~ '^[A-Za-z0-9._-]{1,32}$');
ALTER TABLE audit_lines ADD COLUMN grading_scheme TEXT NOT NULL DEFAULT 'provisional'
  CHECK (grading_scheme ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
ALTER TABLE audit_lines ALTER COLUMN grading_scheme DROP DEFAULT;
ALTER TABLE audit_lines ADD CONSTRAINT audit_lines_audit_id_commodity_grade_key
  UNIQUE (audit_id, commodity, grading_scheme, grade);
-- Recorded stock now comes from the ledger, which holds kg to 2 decimals.
ALTER TABLE audit_lines DROP COLUMN variance_kg;
ALTER TABLE audit_lines ALTER COLUMN recorded_kg TYPE NUMERIC(12, 2);
ALTER TABLE audit_lines ADD COLUMN variance_kg NUMERIC(12, 2)
  GENERATED ALWAYS AS (counted_kg - recorded_kg) STORED;

-- ---------------------------------------------------------------------------
-- Provision (e): a farmer's approval of an action on their stock. Only
-- tablet confirmation (approved at once) is used now; `pending` and
-- `external_ref` exist for two-way SMS/USSD confirmation later.
-- ---------------------------------------------------------------------------
CREATE TABLE farmer_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  action TEXT NOT NULL CHECK (action IN ('dispatch', 'lock', 'exit')),
  subject_id UUID NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('tablet', 'sms_two_way')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  -- SMS or USSD session reference once two-way confirmation exists.
  external_ref TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (action, subject_id),
  CONSTRAINT farmer_confirmations_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
CALL attach_standard_triggers('farmer_confirmations');

-- Per-warehouse document counters (delivery note numbers).
CREATE TABLE document_sequences (
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  document_type TEXT NOT NULL CHECK (document_type IN ('delivery_note')),
  last_value INTEGER NOT NULL CHECK (last_value > 0),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, document_type)
);
CALL attach_standard_triggers('document_sequences');

-- ---------------------------------------------------------------------------
-- Dispatch: stock leaving the warehouse. `id` is generated on the tablet and
-- is the idempotency key, as deposit_id is for deposits.
-- ---------------------------------------------------------------------------
CREATE TABLE dispatches (
  id UUID PRIMARY KEY,
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  custodian_id UUID NOT NULL,
  commodity TEXT NOT NULL CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW')),
  grading_scheme TEXT NOT NULL,
  grade TEXT NOT NULL,
  bag_count INTEGER NOT NULL CHECK (bag_count > 0),
  -- The farmer's recorded kg leaving with these bags (their share of the
  -- balance; a full exit takes the balance to exactly 0).
  book_kg NUMERIC(12, 2) NOT NULL CHECK (book_kg >= 0),
  -- Weighed at the gate; null when not weighed.
  exit_weight_kg NUMERIC(12, 2) CHECK (exit_weight_kg > 0),
  -- Positive: less left than the books said.
  shrinkage_kg NUMERIC(12, 2) GENERATED ALWAYS AS (book_kg - exit_weight_kg) STORED,
  buyer_name TEXT CHECK (char_length(buyer_name) <= 200),
  notes TEXT CHECK (char_length(notes) <= 500),
  delivery_note_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'completed', 'rejected')),
  confirmation_id UUID NOT NULL REFERENCES farmer_confirmations (id),
  -- Provision (b): stays null until a chain adapter exists.
  chain_tx_hash TEXT CHECK (chain_tx_hash ~ '^[0-9a-f]{64}$'),
  dispatched_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (custodian_id, warehouse_id) REFERENCES custodians (id, warehouse_id),
  FOREIGN KEY (farmer_id, warehouse_id) REFERENCES farmer_warehouses (farmer_id, warehouse_id)
);
CALL attach_standard_triggers('dispatches');
CREATE INDEX dispatches_warehouse_dispatched_idx ON dispatches (warehouse_id, dispatched_at);
CREATE INDEX dispatches_farmer_id_idx ON dispatches (farmer_id);

-- Manual corrections to stock, and the automatic scale reweigh of a
-- scale-weighed deposit. `id` is generated by the client (idempotency key).
CREATE TABLE stock_adjustments (
  id UUID PRIMARY KEY,
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  commodity TEXT NOT NULL CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW')),
  grading_scheme TEXT NOT NULL,
  grade TEXT NOT NULL,
  bags_delta INTEGER NOT NULL,
  kg_delta NUMERIC(12, 2) NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN
    ('audit_correction', 'data_entry_error', 'spoilage', 'scale_reweigh', 'other')),
  notes TEXT NOT NULL CHECK (char_length(notes) BETWEEN 1 AND 500),
  recorded_by UUID NOT NULL,
  -- A Farmledge verifier authorises every adjustment.
  authorised_by UUID NOT NULL REFERENCES verifiers (id),
  -- Set for scale reweighs: the deposit whose weight was measured.
  deposit_id TEXT REFERENCES deposits (deposit_id),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_adjustments_not_empty CHECK (bags_delta <> 0 OR kg_delta <> 0),
  CONSTRAINT stock_adjustments_reweigh_has_deposit
    CHECK ((reason_code = 'scale_reweigh') = (deposit_id IS NOT NULL)),
  FOREIGN KEY (recorded_by, warehouse_id) REFERENCES custodians (id, warehouse_id),
  FOREIGN KEY (farmer_id, warehouse_id) REFERENCES farmer_warehouses (farmer_id, warehouse_id)
);
CALL attach_standard_triggers('stock_adjustments');
CALL make_append_only('stock_adjustments');
CREATE UNIQUE INDEX stock_adjustments_one_reweigh_idx ON stock_adjustments (deposit_id)
  WHERE reason_code = 'scale_reweigh';

-- ---------------------------------------------------------------------------
-- The stock ledger. Append-only; balances are sums over it (the
-- `stock_balances` view), never a stored total. Each row comes from exactly
-- one source record.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('deposit_in', 'deposit_void', 'dispatch_out', 'adjustment')),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  commodity TEXT NOT NULL CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW')),
  grading_scheme TEXT NOT NULL,
  grade TEXT NOT NULL,
  bags_delta INTEGER NOT NULL,
  kg_delta NUMERIC(12, 2) NOT NULL,
  -- When the movement physically happened. A deposit captured offline has
  -- an occurred_at earlier than created_at.
  occurred_at TIMESTAMPTZ NOT NULL,
  deposit_id TEXT REFERENCES deposits (deposit_id),
  dispatch_id UUID REFERENCES dispatches (id),
  adjustment_id UUID REFERENCES stock_adjustments (id),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_one_source CHECK (num_nonnulls(deposit_id, dispatch_id, adjustment_id) = 1),
  CONSTRAINT stock_movements_source_matches_kind CHECK (
    CASE kind
      WHEN 'deposit_in' THEN deposit_id IS NOT NULL AND bags_delta > 0 AND kg_delta >= 0
      WHEN 'deposit_void' THEN deposit_id IS NOT NULL AND bags_delta < 0 AND kg_delta <= 0
      WHEN 'dispatch_out' THEN dispatch_id IS NOT NULL AND bags_delta < 0 AND kg_delta <= 0
      WHEN 'adjustment' THEN adjustment_id IS NOT NULL
    END),
  FOREIGN KEY (farmer_id, warehouse_id) REFERENCES farmer_warehouses (farmer_id, warehouse_id)
);
CALL attach_standard_triggers('stock_movements');
CALL make_append_only('stock_movements');
CREATE INDEX stock_movements_balance_idx
  ON stock_movements (warehouse_id, farmer_id, commodity, grading_scheme, grade);
CREATE INDEX stock_movements_warehouse_occurred_idx
  ON stock_movements (warehouse_id, occurred_at, id);
CREATE INDEX stock_movements_farmer_id_idx ON stock_movements (farmer_id);
CREATE UNIQUE INDEX stock_movements_deposit_in_idx ON stock_movements (deposit_id)
  WHERE kind = 'deposit_in';
CREATE UNIQUE INDEX stock_movements_deposit_void_idx ON stock_movements (deposit_id)
  WHERE kind = 'deposit_void';
CREATE UNIQUE INDEX stock_movements_dispatch_idx ON stock_movements (dispatch_id)
  WHERE dispatch_id IS NOT NULL;
CREATE UNIQUE INDEX stock_movements_adjustment_idx ON stock_movements (adjustment_id)
  WHERE adjustment_id IS NOT NULL;

-- Serialises every change to one balance. The app takes the same lock
-- before checking a dispatch against the balance.
CREATE FUNCTION lock_stock_balance(
  p_warehouse UUID, p_farmer UUID, p_commodity TEXT, p_scheme TEXT, p_grade TEXT
) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended(concat_ws('|', 'stock', p_warehouse, p_farmer, p_commodity, p_scheme, p_grade), 0))
$$;

-- A balance can never go below zero, whatever wrote the row. The app checks
-- first so the client gets a clean 409; this catches everything else.
CREATE FUNCTION check_stock_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bags BIGINT;
  kg NUMERIC;
BEGIN
  PERFORM lock_stock_balance(NEW.warehouse_id, NEW.farmer_id, NEW.commodity,
                             NEW.grading_scheme, NEW.grade);
  SELECT COALESCE(sum(bags_delta), 0) + NEW.bags_delta, COALESCE(sum(kg_delta), 0) + NEW.kg_delta
    INTO bags, kg
    FROM stock_movements
   WHERE warehouse_id = NEW.warehouse_id AND farmer_id = NEW.farmer_id
     AND commodity = NEW.commodity AND grading_scheme = NEW.grading_scheme
     AND grade = NEW.grade;
  IF bags < 0 OR kg < 0 THEN
    RAISE EXCEPTION 'stock balance would go negative (% bags, % kg)', bags, kg
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_balance_not_negative';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_stock_balance BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_stock_balance();

CREATE VIEW stock_balances AS
SELECT warehouse_id, farmer_id, commodity, grading_scheme, grade,
       sum(bags_delta)::BIGINT AS bags,
       sum(kg_delta)::NUMERIC(14, 2) AS kg
FROM stock_movements
GROUP BY warehouse_id, farmer_id, commodity, grading_scheme, grade;

-- Deposits post to the ledger themselves, so every path that records a
-- deposit (API, batch, hand-written SQL) keeps the ledger complete. A
-- deposit that is rejected or cancelled is reversed by a `deposit_void`.
CREATE FUNCTION post_deposit_to_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('rejected', 'cancelled') THEN
      INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme,
                                   grade, bags_delta, kg_delta, occurred_at, deposit_id)
      VALUES ('deposit_in', NEW.warehouse_id, NEW.farmer_id, NEW.commodity, NEW.grading_scheme,
              NEW.grade, NEW.bag_count, NEW.estimated_weight_kg, NEW.intake_at, NEW.deposit_id);
    END IF;
  ELSIF NEW.status IN ('rejected', 'cancelled') AND OLD.status NOT IN ('rejected', 'cancelled') THEN
    INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme,
                                 grade, bags_delta, kg_delta, occurred_at, deposit_id)
    SELECT 'deposit_void', NEW.warehouse_id, NEW.farmer_id, NEW.commodity, NEW.grading_scheme,
           NEW.grade, -NEW.bag_count,
           -(NEW.estimated_weight_kg + COALESCE(sum(a.kg_delta), 0)), now(), NEW.deposit_id
      FROM stock_adjustments a WHERE a.deposit_id = NEW.deposit_id;
  ELSIF OLD.status IN ('rejected', 'cancelled') AND NEW.status NOT IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'deposit % is % and cannot be reinstated; record a new deposit',
      NEW.deposit_id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER post_deposit_to_ledger AFTER INSERT OR UPDATE OF status ON deposits
  FOR EACH ROW EXECUTE FUNCTION post_deposit_to_ledger();

-- Once posted, the fields the ledger copied cannot change.
CREATE FUNCTION freeze_deposit_ledger_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.farmer_id, NEW.warehouse_id, NEW.commodity, NEW.grading_scheme, NEW.grade,
      NEW.bag_count, NEW.bag_size_kg, NEW.intake_at)
     IS DISTINCT FROM
     (OLD.farmer_id, OLD.warehouse_id, OLD.commodity, OLD.grading_scheme, OLD.grade,
      OLD.bag_count, OLD.bag_size_kg, OLD.intake_at) THEN
    RAISE EXCEPTION 'deposit % is in the stock ledger; correct it with an adjustment',
      NEW.deposit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER freeze_deposit_ledger_fields BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION freeze_deposit_ledger_fields();

-- Existing deposits enter the ledger at their intake time.
INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme, grade,
                             bags_delta, kg_delta, occurred_at, deposit_id)
SELECT 'deposit_in', warehouse_id, farmer_id, commodity, grading_scheme, grade,
       bag_count, estimated_weight_kg, intake_at, deposit_id
FROM deposits
WHERE status NOT IN ('rejected', 'cancelled');

-- ---------------------------------------------------------------------------
-- Storage fees, charged by the warehouse to farmers.
-- ---------------------------------------------------------------------------
-- A schedule applies from `effective_from` until the next one. Insert-only,
-- and the app refuses one starting on or before a day already accrued, so
-- past charges are never repriced.
CREATE TABLE storage_fee_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  basis TEXT NOT NULL CHECK (basis IN ('per_bag', 'per_tonne')),
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month')),
  rate_ngn NUMERIC(14, 2) NOT NULL CHECK (rate_ngn >= 0),
  minimum_days INTEGER CHECK (minimum_days > 0),
  effective_from DATE NOT NULL,
  set_by UUID NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, effective_from),
  FOREIGN KEY (set_by, warehouse_id) REFERENCES custodians (id, warehouse_id)
);
CALL attach_standard_triggers('storage_fee_schedules');
CALL make_append_only('storage_fee_schedules');

CREATE TABLE fee_accrual_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_date DATE NOT NULL,
  through_date DATE NOT NULL,
  rows_written INTEGER NOT NULL CHECK (rows_written >= 0),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_date <= through_date)
);
CALL attach_standard_triggers('fee_accrual_runs');
CREATE INDEX fee_accrual_runs_through_date_idx ON fee_accrual_runs (through_date);

-- Charges per balance per day. `daily` is the first charge for a day;
-- `correction` adjusts it when stock captured offline arrives later;
-- `minimum_topup` charges the days missing when bags leave before the
-- schedule's minimum period.
CREATE TABLE storage_fee_accruals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  commodity TEXT NOT NULL,
  grading_scheme TEXT NOT NULL,
  grade TEXT NOT NULL,
  accrual_date DATE NOT NULL,
  schedule_id UUID NOT NULL REFERENCES storage_fee_schedules (id),
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'correction', 'minimum_topup')),
  bags INTEGER NOT NULL,
  kg NUMERIC(14, 2) NOT NULL,
  amount_ngn NUMERIC(16, 4) NOT NULL,
  run_id UUID NOT NULL REFERENCES fee_accrual_runs (id),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('storage_fee_accruals');
CALL make_append_only('storage_fee_accruals');
CREATE INDEX storage_fee_accruals_farmer_idx
  ON storage_fee_accruals (warehouse_id, farmer_id, accrual_date);

-- Fee payments, recorded only: no money moves through Farmledge.
CREATE TABLE fee_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  amount_ngn NUMERIC(14, 2) NOT NULL CHECK (amount_ngn > 0),
  reference TEXT NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 100),
  paid_on DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'pos', 'other')),
  notes TEXT CHECK (char_length(notes) <= 500),
  recorded_by UUID NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, reference),
  FOREIGN KEY (recorded_by, warehouse_id) REFERENCES custodians (id, warehouse_id),
  FOREIGN KEY (farmer_id, warehouse_id) REFERENCES farmer_warehouses (farmer_id, warehouse_id)
);
CALL attach_standard_triggers('fee_payments');
CALL make_append_only('fee_payments');
CREATE INDEX fee_payments_farmer_idx ON fee_payments (warehouse_id, farmer_id, paid_on);

-- ---------------------------------------------------------------------------
-- Provision (g): what Farmledge charges a warehouse. Separate from storage
-- fees. A warehouse with no terms is on the 'none' model.
-- ---------------------------------------------------------------------------
CREATE TABLE warehouse_platform_fee_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  model TEXT NOT NULL CHECK (model IN ('none', 'per_bag', 'revenue_share', 'subscription')),
  per_bag_rate_ngn NUMERIC(14, 2) CHECK (per_bag_rate_ngn >= 0),
  effective_from DATE NOT NULL,
  set_by UUID NOT NULL REFERENCES verifiers (id),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, effective_from),
  CONSTRAINT platform_fee_terms_rate CHECK ((model = 'per_bag') = (per_bag_rate_ngn IS NOT NULL))
);
CALL attach_standard_triggers('warehouse_platform_fee_terms');
CALL make_append_only('warehouse_platform_fee_terms');

-- Provision (i): prices entered by hand, used in reports only. A null grade
-- is the price for any grade of that commodity without its own price.
CREATE TABLE manual_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity TEXT NOT NULL CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW')),
  grading_scheme TEXT NOT NULL,
  grade TEXT,
  price_per_tonne_ngn NUMERIC(14, 2) NOT NULL CHECK (price_per_tonne_ngn > 0),
  effective_from DATE NOT NULL,
  entered_by UUID NOT NULL REFERENCES verifiers (id),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (commodity, grading_scheme, grade, effective_from)
);
CALL attach_standard_triggers('manual_prices');
CALL make_append_only('manual_prices');

-- Provision (b): what would have gone on chain. `chain_ref` stays null
-- while CHAIN_ENABLED is false.
CREATE TABLE chain_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('mint', 'exit')),
  subject_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  chain_ref TEXT,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, subject_id)
);
CALL attach_standard_triggers('chain_intents');

-- Provision (c): every signature the KeyService makes (design doc §6).
CREATE TABLE key_signature_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_subject TEXT NOT NULL,
  public_key TEXT NOT NULL,
  purpose TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  device_id TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('key_signature_log');
CALL make_append_only('key_signature_log');

-- Down Migration

DROP TABLE key_signature_log;
DROP TABLE chain_intents;
DROP TABLE manual_prices;
DROP TABLE warehouse_platform_fee_terms;
DROP TABLE fee_payments;
DROP TABLE storage_fee_accruals;
DROP TABLE fee_accrual_runs;
DROP TABLE storage_fee_schedules;
DROP TRIGGER freeze_deposit_ledger_fields ON deposits;
DROP FUNCTION freeze_deposit_ledger_fields();
DROP TRIGGER post_deposit_to_ledger ON deposits;
DROP FUNCTION post_deposit_to_ledger();
DROP VIEW stock_balances;
DROP TABLE stock_movements;
DROP FUNCTION check_stock_balance();
DROP FUNCTION lock_stock_balance(UUID, UUID, TEXT, TEXT, TEXT);
DROP TABLE stock_adjustments;
DROP TABLE dispatches;
DROP TABLE document_sequences;
DROP TABLE farmer_confirmations;

ALTER TABLE audit_lines DROP COLUMN variance_kg;
ALTER TABLE audit_lines ALTER COLUMN recorded_kg TYPE BIGINT USING round(recorded_kg)::BIGINT;
ALTER TABLE audit_lines ADD COLUMN variance_kg NUMERIC(12, 2)
  GENERATED ALWAYS AS (counted_kg - recorded_kg) STORED;
ALTER TABLE audit_lines DROP CONSTRAINT audit_lines_audit_id_commodity_grade_key;
ALTER TABLE audit_lines DROP COLUMN grading_scheme;
ALTER TABLE audit_lines DROP CONSTRAINT audit_lines_grade_check;
ALTER TABLE audit_lines ALTER COLUMN grade TYPE SMALLINT USING grade::SMALLINT;
ALTER TABLE audit_lines ADD CONSTRAINT audit_lines_grade_check CHECK (grade > 0);
ALTER TABLE audit_lines ADD CONSTRAINT audit_lines_audit_id_commodity_grade_key
  UNIQUE (audit_id, commodity, grade);

ALTER TABLE deposits DROP COLUMN grading_scheme;
ALTER TABLE deposits DROP CONSTRAINT deposits_grade_check;
ALTER TABLE deposits ALTER COLUMN grade TYPE SMALLINT USING grade::SMALLINT;
ALTER TABLE deposits ADD CONSTRAINT deposits_grade_check CHECK (grade > 0);

DROP PROCEDURE make_append_only(regclass);
DROP FUNCTION forbid_change();
