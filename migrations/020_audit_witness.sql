-- Up Migration

-- ---------------------------------------------------------------------------
-- D57: an audit names who physically counted and who witnessed the count.
-- The custodian may enter the figures on the tablet (entered_by), so an audit
-- no longer needs a verifier; it needs one of the two. The names are typed
-- for now (#48 replaces the witness with a signed-in verifier). NOT VALID:
-- audits recorded before this name neither and stay as they are; every new
-- row is checked.
-- ---------------------------------------------------------------------------
ALTER TABLE audits ALTER COLUMN conducted_by DROP NOT NULL;
ALTER TABLE audits ADD COLUMN entered_by UUID;
ALTER TABLE audits ADD CONSTRAINT audits_custodian_at_warehouse
  FOREIGN KEY (entered_by, warehouse_id) REFERENCES custodians (id, warehouse_id);
ALTER TABLE audits ADD CONSTRAINT audits_has_actor
  CHECK (conducted_by IS NOT NULL OR entered_by IS NOT NULL);
ALTER TABLE audits ADD COLUMN counted_by TEXT CHECK (length(counted_by) BETWEEN 1 AND 120);
ALTER TABLE audits ADD COLUMN witnessed_by TEXT CHECK (length(witnessed_by) BETWEEN 1 AND 120);
ALTER TABLE audits ADD CONSTRAINT audits_counted_and_witnessed
  CHECK (counted_by IS NOT NULL AND witnessed_by IS NOT NULL) NOT VALID;

-- Down Migration

ALTER TABLE audits DROP CONSTRAINT audits_counted_and_witnessed;
ALTER TABLE audits DROP COLUMN witnessed_by;
ALTER TABLE audits DROP COLUMN counted_by;
ALTER TABLE audits DROP CONSTRAINT audits_has_actor;
ALTER TABLE audits DROP CONSTRAINT audits_custodian_at_warehouse;
ALTER TABLE audits DROP COLUMN entered_by;
ALTER TABLE audits ALTER COLUMN conducted_by SET NOT NULL;
