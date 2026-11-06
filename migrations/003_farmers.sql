-- Up Migration

-- Personal data stays off-chain (design doc §8.2, NDPA 2023). Lenders may
-- look a farmer up only with recorded consent.
CREATE TABLE farmers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  lookup_consent BOOLEAN NOT NULL DEFAULT false,
  consent_given_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT farmers_consent_has_date CHECK (NOT lookup_consent OR consent_given_at IS NOT NULL)
);
CALL attach_standard_triggers('farmers');

-- Down Migration

DROP TABLE farmers;
