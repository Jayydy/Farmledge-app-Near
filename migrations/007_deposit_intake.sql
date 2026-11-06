-- Up Migration

-- Consent to hold the farmer's personal data (NDPA 2023), required to
-- register. Separate from `lookup_consent`, which lets lenders find them.
-- NOT VALID: enforced for every new or updated row without failing on
-- rows written before this migration.
ALTER TABLE farmers ADD COLUMN data_consent_at TIMESTAMPTZ;
ALTER TABLE farmers
  ADD CONSTRAINT farmers_data_consent_required CHECK (data_consent_at IS NOT NULL) NOT VALID;

-- A farmer (one person, one phone) can be registered at several warehouses.
CREATE TABLE farmer_warehouses (
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  registered_by UUID NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (farmer_id, warehouse_id),
  -- The registering custodian must work at that warehouse.
  FOREIGN KEY (registered_by, warehouse_id) REFERENCES custodians (id, warehouse_id)
);
CALL attach_standard_triggers('farmer_warehouses');
CREATE INDEX farmer_warehouses_warehouse_id_idx ON farmer_warehouses (warehouse_id);

-- Deposits may only be taken from farmers registered at that warehouse.
ALTER TABLE deposits
  ADD CONSTRAINT deposits_farmer_registered_fk FOREIGN KEY (farmer_id, warehouse_id)
    REFERENCES farmer_warehouses (farmer_id, warehouse_id) NOT VALID;

ALTER TABLE deposits ADD COLUMN notes TEXT CHECK (char_length(notes) <= 500);

-- True when the custodian explicitly confirmed a bag count above the
-- confirmation threshold (see docs/decisions.md).
ALTER TABLE deposits ADD COLUMN bag_count_confirmed BOOLEAN NOT NULL DEFAULT false;

-- Why a deposit needs a supervisor's review; empty when it does not.
-- 'late_capture': captured offline long before it reached the server.
ALTER TABLE deposits ADD COLUMN review_reasons TEXT[] NOT NULL DEFAULT '{}'
  CONSTRAINT deposits_review_reasons_known CHECK (review_reasons <@ ARRAY['late_capture']);
CREATE INDEX deposits_needs_review_idx ON deposits (warehouse_id) WHERE review_reasons <> '{}';

-- Keyset pagination of a warehouse's deposits, newest first.
CREATE INDEX deposits_warehouse_created_idx ON deposits (warehouse_id, created_at, id);

-- Scale samples are now also spot checks on bag-estimate deposits, used to
-- measure real bag weights. They never change a bag-estimate deposit's
-- weight (see `deposit_weights`). Samples still cannot cover more bags than
-- the deposit has.
CREATE OR REPLACE FUNCTION check_scale_sample() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  deposit deposits%ROWTYPE;
  weighed BIGINT;
BEGIN
  -- Lock the deposit so concurrent samples cannot both pass the bag check.
  SELECT * INTO deposit FROM deposits WHERE deposit_id = NEW.deposit_id FOR UPDATE;
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

CREATE INDEX scale_samples_recorded_at_idx ON scale_samples (recorded_at);

-- Intake photos. The image bytes live behind the app's PhotoStore; this
-- table holds the reference. Content-addressed, so a retried upload of the
-- same image is recognised rather than stored twice.
CREATE TABLE deposit_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id TEXT NOT NULL REFERENCES deposits (deposit_id),
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by UUID NOT NULL REFERENCES custodians (id),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deposit_id, sha256)
);
CALL attach_standard_triggers('deposit_photos');

CREATE FUNCTION check_deposit_photo_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  existing INTEGER;
BEGIN
  -- Lock the deposit so concurrent uploads cannot both pass the limit.
  PERFORM 1 FROM deposits WHERE deposit_id = NEW.deposit_id FOR UPDATE;
  SELECT count(*) INTO existing FROM deposit_photos WHERE deposit_id = NEW.deposit_id;
  IF existing >= 3 THEN
    RAISE EXCEPTION 'deposit % already has 3 photos', NEW.deposit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_deposit_photo_limit BEFORE INSERT ON deposit_photos
  FOR EACH ROW EXECUTE FUNCTION check_deposit_photo_limit();

-- Down Migration

DROP TABLE deposit_photos;
DROP FUNCTION check_deposit_photo_limit();
DROP INDEX scale_samples_recorded_at_idx;

CREATE OR REPLACE FUNCTION check_scale_sample() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  deposit deposits%ROWTYPE;
  weighed BIGINT;
BEGIN
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

DROP INDEX deposits_warehouse_created_idx;
DROP INDEX deposits_needs_review_idx;
ALTER TABLE deposits DROP COLUMN review_reasons;
ALTER TABLE deposits DROP COLUMN bag_count_confirmed;
ALTER TABLE deposits DROP COLUMN notes;
ALTER TABLE deposits DROP CONSTRAINT deposits_farmer_registered_fk;
DROP TABLE farmer_warehouses;
ALTER TABLE farmers DROP CONSTRAINT farmers_data_consent_required;
ALTER TABLE farmers DROP COLUMN data_consent_at;
