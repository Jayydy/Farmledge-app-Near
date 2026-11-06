-- Up Migration

-- One row per intake (design doc §5.1). `deposit_id` is generated on the
-- tablet so offline intake and retries can never create a second deposit.
CREATE TABLE deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id TEXT NOT NULL UNIQUE CHECK (deposit_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  custodian_id UUID NOT NULL,
  verifier_id UUID NOT NULL REFERENCES verifiers (id),
  commodity TEXT NOT NULL CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW')),
  -- Allowed grades and moisture limits are tunable config, checked by the
  -- app; the database only enforces sane bounds.
  grade SMALLINT NOT NULL CHECK (grade > 0),
  -- Basis points of a percent (1250 = 12.50%), the unit the receipt contract
  -- stores as `moisture_pct`.
  moisture_bps INTEGER NOT NULL CHECK (moisture_bps BETWEEN 0 AND 10000),
  bag_count INTEGER NOT NULL CHECK (bag_count > 0),
  -- Bag size in force at intake, so the estimate stays auditable if the
  -- configured size ever changes.
  bag_size_kg INTEGER NOT NULL CHECK (bag_size_kg > 0),
  -- Always the bag estimate. The weight to mint comes from `deposit_weights`.
  estimated_weight_kg BIGINT GENERATED ALWAYS AS (bag_count::BIGINT * bag_size_kg) STORED,
  weight_source TEXT NOT NULL CHECK (weight_source IN ('bag_estimate', 'scale')),
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'submitted', 'minted', 'rejected', 'cancelled')),
  -- Time of intake on the tablet; earlier than created_at for offline intake.
  intake_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (custodian_id, warehouse_id) REFERENCES custodians (id, warehouse_id)
);
CALL attach_standard_triggers('deposits');
CREATE INDEX deposits_farmer_id_idx ON deposits (farmer_id);
CREATE INDEX deposits_warehouse_id_idx ON deposits (warehouse_id);
CREATE INDEX deposits_custodian_id_idx ON deposits (custodian_id);
CREATE INDEX deposits_status_idx ON deposits (status);

-- Scale readings taken at intake, kept apart from the bag estimate so both
-- figures stay visible. Only scale-weighed deposits take samples.
CREATE TABLE scale_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id TEXT NOT NULL REFERENCES deposits (deposit_id),
  bags_weighed INTEGER NOT NULL CHECK (bags_weighed > 0),
  total_kg NUMERIC(10, 2) NOT NULL CHECK (total_kg > 0),
  recorded_by UUID NOT NULL REFERENCES custodians (id),
  recorded_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('scale_samples');
CREATE INDEX scale_samples_deposit_id_idx ON scale_samples (deposit_id);

CREATE FUNCTION check_scale_sample() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  deposit deposits%ROWTYPE;
  weighed BIGINT;
BEGIN
  -- Lock the deposit so concurrent samples cannot both pass the bag check.
  SELECT * INTO deposit FROM deposits WHERE deposit_id = NEW.deposit_id FOR UPDATE;
  IF deposit.weight_source <> 'scale' THEN
    RAISE EXCEPTION 'deposit % is not scale-weighed', NEW.deposit_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(bags_weighed), 0) + NEW.bags_weighed INTO weighed
    FROM scale_samples WHERE deposit_id = NEW.deposit_id AND id <> NEW.id;
  IF weighed > deposit.bag_count THEN
    RAISE EXCEPTION 'scale samples for deposit % cover % bags but it has %',
      NEW.deposit_id, weighed, deposit.bag_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_scale_sample BEFORE INSERT OR UPDATE ON scale_samples
  FOR EACH ROW EXECUTE FUNCTION check_scale_sample();

-- The weight a deposit's receipt is minted with. Bag-estimate deposits use
-- the estimate. Scale deposits use the measured total, rounded down so
-- collateral is never overstated, and stay NULL (not mintable) until every
-- bag has been weighed.
CREATE VIEW deposit_weights AS
SELECT
  d.deposit_id,
  d.weight_source,
  d.bag_count,
  d.estimated_weight_kg,
  COALESCE(s.bags_weighed, 0) AS bags_weighed,
  s.total_kg AS scale_total_kg,
  CASE
    WHEN d.weight_source = 'bag_estimate' THEN d.estimated_weight_kg
    WHEN s.bags_weighed = d.bag_count THEN floor(s.total_kg)::BIGINT
  END AS weight_kg
FROM deposits d
LEFT JOIN (
  SELECT deposit_id, SUM(bags_weighed) AS bags_weighed, SUM(total_kg) AS total_kg
  FROM scale_samples GROUP BY deposit_id
) s USING (deposit_id);

-- Off-chain mirror of receipts. Chain fields stay null until the contract
-- integration exists; the contract remains the source of truth (§7.1).
CREATE TABLE receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id TEXT NOT NULL REFERENCES deposits (deposit_id),
  -- Set when a receipt comes from a split (lock, partial unlock, exit).
  parent_receipt_id UUID REFERENCES receipts (id),
  contract_id TEXT,
  chain_receipt_id NUMERIC(20, 0) CHECK (chain_receipt_id >= 0),
  mint_tx_hash TEXT CHECK (mint_tx_hash ~ '^[0-9a-f]{64}$'),
  mint_ledger BIGINT,
  chain_status TEXT CHECK (chain_status IN ('ACTIVE', 'LOCKED', 'RECOVERY', 'EXITED', 'REVOKED')),
  last_synced_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, chain_receipt_id)
);
CALL attach_standard_triggers('receipts');
CREATE INDEX receipts_deposit_id_idx ON receipts (deposit_id);
-- A deposit mints exactly one original receipt; split children share its deposit_id.
CREATE UNIQUE INDEX receipts_one_root_per_deposit_idx
  ON receipts (deposit_id) WHERE parent_receipt_id IS NULL;
CREATE INDEX receipts_parent_receipt_id_idx ON receipts (parent_receipt_id);

-- Down Migration

DROP TABLE receipts;
DROP VIEW deposit_weights;
DROP TABLE scale_samples;
DROP FUNCTION check_scale_sample();
DROP TABLE deposits;
