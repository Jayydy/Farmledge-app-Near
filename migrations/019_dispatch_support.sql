-- Up Migration

-- ---------------------------------------------------------------------------
-- D54: an unweighed dispatch says why. A dispatch with no exit weight must
-- carry a reason, and one with a weight must not. NOT VALID: dispatches
-- recorded before this have no reason and stay as they are; every new row
-- is checked.
-- ---------------------------------------------------------------------------
ALTER TABLE dispatches ADD COLUMN not_weighed_reason TEXT
  CHECK (length(not_weighed_reason) BETWEEN 1 AND 500);
ALTER TABLE dispatches ADD CONSTRAINT dispatches_weight_or_reason
  CHECK ((exit_weight_kg IS NULL) = (not_weighed_reason IS NOT NULL)) NOT VALID;

-- ---------------------------------------------------------------------------
-- D54: a dispatch the tablet refused to start because it was offline. Only
-- when, who, and how long the tablet had been offline: no farmer, lot or
-- quantity. Idempotent on the tablet's id, since the outbox retries.
-- ---------------------------------------------------------------------------
CREATE TABLE dispatch_blocked_events (
  id UUID PRIMARY KEY,
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  custodian_id UUID NOT NULL REFERENCES custodians (id),
  blocked_at TIMESTAMPTZ NOT NULL,
  -- When the tablet last had a connection; null if it never had one.
  offline_since TIMESTAMPTZ CHECK (offline_since <= blocked_at),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('dispatch_blocked_events');
CREATE INDEX dispatch_blocked_events_warehouse_idx
  ON dispatch_blocked_events (warehouse_id, blocked_at);

-- Down Migration

DROP TABLE dispatch_blocked_events;
ALTER TABLE dispatches DROP CONSTRAINT dispatches_weight_or_reason;
ALTER TABLE dispatches DROP COLUMN not_weighed_reason;
