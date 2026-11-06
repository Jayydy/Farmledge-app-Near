-- Up Migration

-- Staff sign-in for the warehouse tablet (docs/decisions.md D41).

-- ---------------------------------------------------------------------------
-- A custodian signs in with their phone and a PIN. Only a scrypt hash is
-- stored; it is set by `npm run set-pin`, never through the API. Repeated
-- wrong PINs lock the custodian out for a while.
-- ---------------------------------------------------------------------------
ALTER TABLE custodians
  ADD COLUMN pin_hash TEXT CHECK (pin_hash ~ '^scrypt\$'),
  ADD COLUMN pin_failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (pin_failed_attempts >= 0),
  ADD COLUMN pin_locked_until TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- One row per sign-in. The bearer token itself is never stored, only its
-- SHA-256. A session is bound to one custodian at their warehouse; signing
-- out sets revoked_at.
-- ---------------------------------------------------------------------------
CREATE TABLE staff_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 BYTEA NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  custodian_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (custodian_id, warehouse_id) REFERENCES custodians (id, warehouse_id),
  CHECK (expires_at > created_at)
);
CALL attach_standard_triggers('staff_sessions');
CREATE INDEX staff_sessions_custodian_id_idx ON staff_sessions (custodian_id);

-- Down Migration

DROP TABLE staff_sessions;
ALTER TABLE custodians
  DROP COLUMN pin_locked_until,
  DROP COLUMN pin_failed_attempts,
  DROP COLUMN pin_hash;
