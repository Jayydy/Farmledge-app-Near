-- Up Migration

-- The latest ledger seen just before a transaction was signed. It can only
-- land in a later ledger, so this bounds the ledgers to search for it. The
-- INV-1 archive fallback uses it to require the event archive to cover that
-- whole range, without a hole, before calling a mint absent.
-- Null for transactions recorded before this migration.
ALTER TABLE chain_transactions ADD COLUMN signed_after_ledger BIGINT;

-- Down Migration

ALTER TABLE chain_transactions DROP COLUMN signed_after_ledger;
