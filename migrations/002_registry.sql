-- Up Migration

-- Phone numbers are stored in E.164 form (e.g. +2348012345678).

CREATE TABLE warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,32}$'),
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  lga TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('warehouses');

-- Custodians are registered to one warehouse (design doc §3.2).
CREATE TABLE custodians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Filled in once custodian keys exist; unused for now.
  chain_address TEXT UNIQUE,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lets deposits require that their custodian belongs to their warehouse.
  UNIQUE (id, warehouse_id)
);
CALL attach_standard_triggers('custodians');
CREATE INDEX custodians_warehouse_id_idx ON custodians (warehouse_id);

-- Farmledge verification agents who co-sign mints (design doc §3.2).
CREATE TABLE verifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  chain_address TEXT UNIQUE,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('verifiers');

-- Down Migration

DROP TABLE verifiers;
DROP TABLE custodians;
DROP TABLE warehouses;
