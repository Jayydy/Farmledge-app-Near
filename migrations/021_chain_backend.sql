-- Up Migration

-- Which chain a deployment / transaction belongs to. Existing rows are Stellar.
ALTER TABLE chain_deployments ADD COLUMN chain TEXT NOT NULL DEFAULT 'stellar'
  CHECK (chain IN ('stellar', 'near'));
ALTER TABLE chain_transactions ADD COLUMN chain TEXT NOT NULL DEFAULT 'stellar'
  CHECK (chain IN ('stellar', 'near'));
ALTER TABLE chain_transactions ADD COLUMN envelope_encoding TEXT NOT NULL DEFAULT 'xdr'
  CHECK (envelope_encoding IN ('xdr', 'borsh_b64'));
-- NEAR access-key nonce.
ALTER TABLE chain_transactions ADD COLUMN signer_nonce NUMERIC(20, 0);

-- Replace Stellar-only format checks with chain-aware ones.
--   NEAR account id: 2–64 chars, [a-z0-9._-], starting/ending with [a-z0-9] (implicit accounts = 64 hex)
--   NEAR tx hash   : base58, 43–44 chars
ALTER TABLE chain_deployments DROP CONSTRAINT chain_deployments_contract_id_check;
ALTER TABLE chain_deployments ADD CONSTRAINT chain_deployments_contract_id_check CHECK (
  (chain = 'stellar' AND contract_id ~ '^C[A-Z2-7]{55}$')
  OR (chain = 'near' AND contract_id ~ '^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$')
) NOT VALID;
ALTER TABLE chain_deployments VALIDATE CONSTRAINT chain_deployments_contract_id_check;

ALTER TABLE chain_deployments DROP CONSTRAINT chain_deployments_predecessor_contract_id_check;
ALTER TABLE chain_deployments ADD CONSTRAINT chain_deployments_predecessor_contract_id_check CHECK (
  predecessor_contract_id IS NULL
  OR (chain = 'stellar' AND predecessor_contract_id ~ '^C[A-Z2-7]{55}$')
  OR (chain = 'near' AND predecessor_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$')
) NOT VALID;
ALTER TABLE chain_deployments VALIDATE CONSTRAINT chain_deployments_predecessor_contract_id_check;

ALTER TABLE chain_transactions DROP CONSTRAINT chain_transactions_tx_hash_check;
ALTER TABLE chain_transactions ADD CONSTRAINT chain_transactions_tx_hash_check CHECK (
  (chain = 'stellar' AND tx_hash ~ '^[0-9a-f]{64}$')
  OR (chain = 'near' AND tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$')
) NOT VALID;
ALTER TABLE chain_transactions VALIDATE CONSTRAINT chain_transactions_tx_hash_check;

-- pledges has no `chain` column, so accept either Stellar G… or NEAR account id
-- and validate strictly for the active backend in the app.
ALTER TABLE pledges DROP CONSTRAINT pledges_lender_address_check;
ALTER TABLE pledges ADD CONSTRAINT pledges_lender_address_check CHECK (
  lender_address ~ '^G[A-Z2-7]{55}$'
  OR lender_address ~ '^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$'
) NOT VALID;
ALTER TABLE pledges VALIDATE CONSTRAINT pledges_lender_address_check;

-- Off-chain receipt mirror (004) and dispatch tx reference (008): accept 64-hex or base58.
ALTER TABLE receipts DROP CONSTRAINT receipts_mint_tx_hash_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_mint_tx_hash_check CHECK (
  mint_tx_hash ~ '^[0-9a-f]{64}$'
  OR mint_tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$'
) NOT VALID;
ALTER TABLE receipts VALIDATE CONSTRAINT receipts_mint_tx_hash_check;

ALTER TABLE dispatches DROP CONSTRAINT dispatches_chain_tx_hash_check;
ALTER TABLE dispatches ADD CONSTRAINT dispatches_chain_tx_hash_check CHECK (
  chain_tx_hash ~ '^[0-9a-f]{64}$'
  OR chain_tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$'
) NOT VALID;
ALTER TABLE dispatches VALIDATE CONSTRAINT dispatches_chain_tx_hash_check;

-- Down Migration

-- Restoring original Stellar-only constraints first ensures down migration
-- fails loudly if any NEAR rows exist.
ALTER TABLE dispatches DROP CONSTRAINT dispatches_chain_tx_hash_check;
ALTER TABLE dispatches ADD CONSTRAINT dispatches_chain_tx_hash_check
  CHECK (chain_tx_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE receipts DROP CONSTRAINT receipts_mint_tx_hash_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_mint_tx_hash_check
  CHECK (mint_tx_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE pledges DROP CONSTRAINT pledges_lender_address_check;
ALTER TABLE pledges ADD CONSTRAINT pledges_lender_address_check
  CHECK (lender_address ~ '^G[A-Z2-7]{55}$');

ALTER TABLE chain_transactions DROP CONSTRAINT chain_transactions_tx_hash_check;
ALTER TABLE chain_transactions ADD CONSTRAINT chain_transactions_tx_hash_check
  CHECK (tx_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE chain_deployments DROP CONSTRAINT chain_deployments_predecessor_contract_id_check;
ALTER TABLE chain_deployments ADD CONSTRAINT chain_deployments_predecessor_contract_id_check
  CHECK (predecessor_contract_id ~ '^C[A-Z2-7]{55}$');

ALTER TABLE chain_deployments DROP CONSTRAINT chain_deployments_contract_id_check;
ALTER TABLE chain_deployments ADD CONSTRAINT chain_deployments_contract_id_check
  CHECK (contract_id ~ '^C[A-Z2-7]{55}$');

ALTER TABLE chain_transactions DROP COLUMN signer_nonce;
ALTER TABLE chain_transactions DROP COLUMN envelope_encoding;
ALTER TABLE chain_transactions DROP COLUMN chain;
ALTER TABLE chain_deployments DROP COLUMN chain;
