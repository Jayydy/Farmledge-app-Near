-- Up Migration

-- Warehouse owners, deposit cancellation with fee contra entries, payment
-- reversals, per-commodity fee schedules and per-warehouse shrinkage
-- tolerance (docs/decisions.md D22-D26).

-- ---------------------------------------------------------------------------
-- A warehouse owner is a role distinct from custodian: owners change fees,
-- authorise late cancellations and reverse payments; custodians run intake.
-- ---------------------------------------------------------------------------
CREATE TABLE warehouse_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, warehouse_id)
);
CALL attach_standard_triggers('warehouse_owners');
CREATE INDEX warehouse_owners_warehouse_id_idx ON warehouse_owners (warehouse_id);

-- ---------------------------------------------------------------------------
-- Storage fee schedules: set by the owner, with a reason, optionally for one
-- commodity. A schedule with no commodity is the warehouse default, used
-- when no commodity-specific schedule is in force.
-- ---------------------------------------------------------------------------
ALTER TABLE storage_fee_schedules
  ADD COLUMN commodity TEXT CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW'));
ALTER TABLE storage_fee_schedules ADD COLUMN reason TEXT;
-- NOT VALID: required for new schedules without failing on earlier ones.
ALTER TABLE storage_fee_schedules
  ADD CONSTRAINT storage_fee_schedules_reason_required
    CHECK (char_length(reason) BETWEEN 1 AND 500) NOT VALID;
ALTER TABLE storage_fee_schedules
  DROP CONSTRAINT storage_fee_schedules_warehouse_id_effective_from_key;
ALTER TABLE storage_fee_schedules
  ADD CONSTRAINT storage_fee_schedules_one_per_day
    UNIQUE NULLS NOT DISTINCT (warehouse_id, commodity, effective_from);
ALTER TABLE storage_fee_schedules DROP CONSTRAINT storage_fee_schedules_set_by_warehouse_id_fkey;
ALTER TABLE storage_fee_schedules
  ADD CONSTRAINT storage_fee_schedules_set_by_owner_fkey
    FOREIGN KEY (set_by, warehouse_id) REFERENCES warehouse_owners (id, warehouse_id) NOT VALID;

-- ---------------------------------------------------------------------------
-- Deposit cancellation: for mistakes only. Who cancelled, why, and whether
-- it was inside the custodian window. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE deposit_cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id TEXT NOT NULL UNIQUE REFERENCES deposits (deposit_id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  cancelled_by UUID NOT NULL,
  cancelled_by_role TEXT NOT NULL CHECK (cancelled_by_role IN ('custodian', 'warehouse_owner')),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  within_window BOOLEAN NOT NULL,
  -- Storage fees reversed by contra entries (negative or zero).
  fees_reversed_ngn NUMERIC(16, 4) NOT NULL CHECK (fees_reversed_ngn <= 0),
  cancelled_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Outside the window only an owner may cancel.
  CONSTRAINT deposit_cancellations_owner_outside_window
    CHECK (within_window OR cancelled_by_role = 'warehouse_owner')
);
CALL attach_standard_triggers('deposit_cancellations');
CALL make_append_only('deposit_cancellations');

-- A cancelled or rejected deposit never happened: its reversal is dated at
-- its intake, so the ledger shows no stock from it on any day.
CREATE OR REPLACE FUNCTION post_deposit_to_ledger() RETURNS trigger
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
           -(NEW.estimated_weight_kg + COALESCE(sum(a.kg_delta), 0)), NEW.intake_at,
           NEW.deposit_id
      FROM stock_adjustments a WHERE a.deposit_id = NEW.deposit_id;
  ELSIF OLD.status IN ('rejected', 'cancelled') AND NEW.status NOT IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'deposit % is % and cannot be reinstated; record a new deposit',
      NEW.deposit_id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- Fee accruals come from an accrual run, or are contra entries reversing a
-- cancelled deposit's charges (reason and authoriser on the cancellation).
ALTER TABLE storage_fee_accruals ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE storage_fee_accruals
  ADD COLUMN cancellation_id UUID REFERENCES deposit_cancellations (id);
ALTER TABLE storage_fee_accruals
  ADD CONSTRAINT storage_fee_accruals_one_source CHECK (num_nonnulls(run_id, cancellation_id) = 1);
CREATE INDEX storage_fee_accruals_cancellation_idx ON storage_fee_accruals (cancellation_id)
  WHERE cancellation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Payment reversal: owner only, with reason and time. The payment row stays.
-- ---------------------------------------------------------------------------
CREATE TABLE fee_payment_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE REFERENCES fee_payments (id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  reversed_by UUID NOT NULL,
  reversed_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (reversed_by, warehouse_id) REFERENCES warehouse_owners (id, warehouse_id)
);
CALL attach_standard_triggers('fee_payment_reversals');
CALL make_append_only('fee_payment_reversals');

-- ---------------------------------------------------------------------------
-- Shrinkage is a reporting threshold, never a rule. A warehouse may set its
-- own; otherwise the configured default applies. History is kept.
-- ---------------------------------------------------------------------------
CREATE TABLE warehouse_shrinkage_tolerances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  tolerance_bps INTEGER NOT NULL CHECK (tolerance_bps BETWEEN 0 AND 10000),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  set_by UUID NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (set_by, warehouse_id) REFERENCES warehouse_owners (id, warehouse_id)
);
CALL attach_standard_triggers('warehouse_shrinkage_tolerances');
CALL make_append_only('warehouse_shrinkage_tolerances');
CREATE INDEX warehouse_shrinkage_tolerances_idx
  ON warehouse_shrinkage_tolerances (warehouse_id, created_at);

-- Every exit keeps the tolerance it was judged against, and is flagged for
-- review above it.
ALTER TABLE dispatches ADD COLUMN shrinkage_tolerance_bps INTEGER
  CHECK (shrinkage_tolerance_bps BETWEEN 0 AND 10000);
ALTER TABLE dispatches ADD COLUMN review_reasons TEXT[] NOT NULL DEFAULT '{}'
  CONSTRAINT dispatches_review_reasons_known
    CHECK (review_reasons <@ ARRAY['shrinkage_above_threshold']);
CREATE INDEX dispatches_needs_review_idx ON dispatches (warehouse_id) WHERE review_reasons <> '{}';

-- Down Migration

DROP INDEX dispatches_needs_review_idx;
ALTER TABLE dispatches DROP COLUMN review_reasons;
ALTER TABLE dispatches DROP COLUMN shrinkage_tolerance_bps;
DROP TABLE warehouse_shrinkage_tolerances;
DROP TABLE fee_payment_reversals;

DROP INDEX storage_fee_accruals_cancellation_idx;
ALTER TABLE storage_fee_accruals DROP CONSTRAINT storage_fee_accruals_one_source;
ALTER TABLE storage_fee_accruals DROP COLUMN cancellation_id;
ALTER TABLE storage_fee_accruals ALTER COLUMN run_id SET NOT NULL;

CREATE OR REPLACE FUNCTION post_deposit_to_ledger() RETURNS trigger
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

DROP TABLE deposit_cancellations;

ALTER TABLE storage_fee_schedules DROP CONSTRAINT storage_fee_schedules_set_by_owner_fkey;
ALTER TABLE storage_fee_schedules
  ADD CONSTRAINT storage_fee_schedules_set_by_warehouse_id_fkey
    FOREIGN KEY (set_by, warehouse_id) REFERENCES custodians (id, warehouse_id) NOT VALID;
ALTER TABLE storage_fee_schedules DROP CONSTRAINT storage_fee_schedules_one_per_day;
ALTER TABLE storage_fee_schedules
  ADD CONSTRAINT storage_fee_schedules_warehouse_id_effective_from_key
    UNIQUE (warehouse_id, effective_from);
ALTER TABLE storage_fee_schedules DROP CONSTRAINT storage_fee_schedules_reason_required;
ALTER TABLE storage_fee_schedules DROP COLUMN reason;
ALTER TABLE storage_fee_schedules DROP COLUMN commodity;

DROP TABLE warehouse_owners;
