-- Up Migration

-- ---------------------------------------------------------------------------
-- Protocol #7: every day of every warehouse is anchored. A day with no
-- entries gets one sentinel leaf (kind 3), which belongs to no lot: it has
-- no deposit, farmer or lot movement, and deposit_no 0.
-- ---------------------------------------------------------------------------
ALTER TABLE book_entries DROP CONSTRAINT book_entries_kind_check;
ALTER TABLE book_entries ADD CONSTRAINT book_entries_kind_check CHECK (kind IN (0, 1, 2, 3));
ALTER TABLE book_entries ALTER COLUMN deposit_id DROP NOT NULL;
ALTER TABLE book_entries ALTER COLUMN farmer_id DROP NOT NULL;
ALTER TABLE book_entries DROP CONSTRAINT book_entries_movement;
ALTER TABLE book_entries ADD CONSTRAINT book_entries_movement
  CHECK ((kind IN (2, 3)) = (lot_movement_id IS NULL));
ALTER TABLE book_entries ADD CONSTRAINT book_entries_sentinel CHECK (
  CASE WHEN kind = 3 THEN deposit_id IS NULL AND farmer_id IS NULL AND deposit_no = 0
       ELSE deposit_id IS NOT NULL AND farmer_id IS NOT NULL END);
CREATE UNIQUE INDEX book_entries_one_sentinel_idx ON book_entries (warehouse_id, day)
  WHERE kind = 3;

-- Days are no longer closed as 'empty' (unanchored). Rows written before
-- this migration keep their status: they are history.
CREATE FUNCTION forbid_empty_book_day() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'empty' THEN
    RAISE EXCEPTION 'day % of warehouse % has no entries: anchor it with a sentinel leaf, never skip it (INV-5)',
      NEW.day, NEW.warehouse_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER forbid_empty_book_day BEFORE INSERT ON book_days
  FOR EACH ROW EXECUTE FUNCTION forbid_empty_book_day();

-- ---------------------------------------------------------------------------
-- Protocol #10: the pre-claim gate is always verified, even when there is
-- nothing to claim. 'not_required' opened a gate with no check; those gates
-- are closed again until verified.
-- ---------------------------------------------------------------------------
DROP TRIGGER check_preclaim_gate ON preclaim_gates;
DROP FUNCTION check_preclaim_gate();
UPDATE preclaim_gates SET status = 'pending' WHERE status = 'not_required';
ALTER TABLE preclaim_gates DROP CONSTRAINT preclaim_gates_status_check;
ALTER TABLE preclaim_gates ADD CONSTRAINT preclaim_gates_status_check
  CHECK (status IN ('pending', 'verified'));

-- Down Migration

ALTER TABLE preclaim_gates DROP CONSTRAINT preclaim_gates_status_check;
ALTER TABLE preclaim_gates ADD CONSTRAINT preclaim_gates_status_check
  CHECK (status IN ('not_required', 'pending', 'verified'));
CREATE FUNCTION check_preclaim_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'not_required' AND EXISTS (
       SELECT 1 FROM chain_deployments
        WHERE contract_id = NEW.contract_id AND predecessor_contract_id IS NOT NULL) THEN
    RAISE EXCEPTION 'contract % has a predecessor: its pre-claim must be verified (INV-2)',
      NEW.contract_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_preclaim_gate BEFORE INSERT OR UPDATE ON preclaim_gates
  FOR EACH ROW EXECUTE FUNCTION check_preclaim_gate();

DROP TRIGGER forbid_empty_book_day ON book_days;
DROP FUNCTION forbid_empty_book_day();
DROP INDEX book_entries_one_sentinel_idx;
ALTER TABLE book_entries DROP CONSTRAINT book_entries_sentinel;
ALTER TABLE book_entries DROP CONSTRAINT book_entries_movement;
ALTER TABLE book_entries ADD CONSTRAINT book_entries_movement
  CHECK ((kind = 2) = (lot_movement_id IS NULL));
ALTER TABLE book_entries ALTER COLUMN farmer_id SET NOT NULL;
ALTER TABLE book_entries ALTER COLUMN deposit_id SET NOT NULL;
ALTER TABLE book_entries DROP CONSTRAINT book_entries_kind_check;
ALTER TABLE book_entries ADD CONSTRAINT book_entries_kind_check CHECK (kind IN (0, 1, 2));
