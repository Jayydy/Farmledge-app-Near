-- Up Migration

-- INV-1: a mint's deadline is fixed when the lot is frozen, not when its
-- transaction is built. No mint transaction is built after it and none
-- carries a later max_time, so once a ledger closes after it the mint can
-- no longer land, and only then may an unrecorded mint be unfrozen.
-- Null for requests made before this migration.
ALTER TABLE mint_requests ADD COLUMN max_time TIMESTAMPTZ;

-- Down Migration

ALTER TABLE mint_requests DROP COLUMN max_time;
