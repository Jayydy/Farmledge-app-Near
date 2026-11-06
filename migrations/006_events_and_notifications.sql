-- Up Migration

-- Raw contract events, archived because Soroban RPC keeps them only briefly
-- (design doc §7.2). Nothing writes here yet.
CREATE TABLE events_archive (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  ledger_closed_at TIMESTAMPTZ NOT NULL,
  tx_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  topics JSONB NOT NULL,
  value JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('events_archive');
CREATE INDEX events_archive_contract_id_ledger_idx ON events_archive (contract_id, ledger);

-- Outbound SMS log.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID REFERENCES farmers (id),
  to_phone TEXT NOT NULL CHECK (to_phone ~ '^\+[1-9][0-9]{7,14}$'),
  channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms')),
  template TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  provider TEXT,
  provider_message_id TEXT,
  error TEXT,
  sent_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('notifications');
CREATE INDEX notifications_to_phone_idx ON notifications (to_phone);
CREATE INDEX notifications_farmer_id_idx ON notifications (farmer_id);
CREATE INDEX notifications_status_idx ON notifications (status);

-- Down Migration

DROP TABLE notifications;
DROP TABLE events_archive;
