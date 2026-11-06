-- Up Migration

-- A scale sample may carry an ID generated on the tablet, the idempotency
-- key for retries, as deposit_id is for deposits (docs/decisions.md D42).
-- Samples recorded before this have none.
ALTER TABLE scale_samples ADD COLUMN sample_id UUID UNIQUE;

-- Down Migration

ALTER TABLE scale_samples DROP COLUMN sample_id;
