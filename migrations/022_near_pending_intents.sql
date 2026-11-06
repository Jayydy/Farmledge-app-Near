-- Up Migration

-- Two-step mint (`propose_mint` -> `approve_mint`) and lock (`offer_lock` -> `accept_lock`) on NEAR.
ALTER TABLE chain_transactions DROP CONSTRAINT chain_transactions_purpose_check;
ALTER TABLE chain_transactions ADD CONSTRAINT chain_transactions_purpose_check CHECK (
  purpose IN (
    'anchor',
    'mint',
    'mint_propose',
    'mint_approve',
    'lock',
    'lock_accept',
    'extend_ttl_batch',
    'other'
  )
) NOT VALID;
ALTER TABLE chain_transactions VALIDATE CONSTRAINT chain_transactions_purpose_check;

-- NEAR: the lender's `offer_lock` tx hash, submitted by the lender and verified before `accept_lock`.
ALTER TABLE pledges ADD COLUMN lender_offer_tx_hash TEXT
  CONSTRAINT pledges_lender_offer_tx_hash_check
  CHECK (lender_offer_tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$');

-- NEAR replaces `awaiting_lender_signature` with `awaiting_lender_offer`.
ALTER TABLE pledges DROP CONSTRAINT pledges_status_check;
ALTER TABLE pledges ADD CONSTRAINT pledges_status_check CHECK (
  status IN (
    'minting',
    'awaiting_lender_signature',
    'awaiting_lender_offer',
    'locking',
    'locked',
    'failed'
  )
) NOT VALID;
ALTER TABLE pledges VALIDATE CONSTRAINT pledges_status_check;

-- Down Migration

ALTER TABLE pledges DROP CONSTRAINT pledges_status_check;
ALTER TABLE pledges ADD CONSTRAINT pledges_status_check CHECK (
  status IN ('minting', 'awaiting_lender_signature', 'locking', 'locked', 'failed')
);

-- Fail loudly if any row holds a NEAR lender offer tx hash before dropping the column.
ALTER TABLE pledges ADD CONSTRAINT pledges_lender_offer_tx_hash_empty_check
  CHECK (lender_offer_tx_hash IS NULL);
ALTER TABLE pledges DROP COLUMN lender_offer_tx_hash;

ALTER TABLE chain_transactions DROP CONSTRAINT chain_transactions_purpose_check;
ALTER TABLE chain_transactions ADD CONSTRAINT chain_transactions_purpose_check CHECK (
  purpose IN ('anchor', 'mint', 'lock', 'extend_ttl_batch', 'other')
);
