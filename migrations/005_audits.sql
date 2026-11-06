-- Up Migration

-- Physical stock audits against recorded stock (design doc §4.3, §11.2).
CREATE TABLE audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  conducted_by UUID NOT NULL REFERENCES verifiers (id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audits_completed_has_date CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT audits_completed_after_start CHECK (completed_at IS NULL OR completed_at >= started_at)
);
CALL attach_standard_triggers('audits');
CREATE INDEX audits_warehouse_id_status_idx ON audits (warehouse_id, status);

-- One line per commodity and grade counted. Recorded figures come from the
-- system; counted figures from the physical count.
CREATE TABLE audit_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  commodity TEXT NOT NULL CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW')),
  grade SMALLINT NOT NULL CHECK (grade > 0),
  recorded_bags INTEGER NOT NULL CHECK (recorded_bags >= 0),
  recorded_kg BIGINT NOT NULL CHECK (recorded_kg >= 0),
  counted_bags INTEGER NOT NULL CHECK (counted_bags >= 0),
  counted_kg NUMERIC(12, 2) NOT NULL CHECK (counted_kg >= 0),
  variance_bags INTEGER GENERATED ALWAYS AS (counted_bags - recorded_bags) STORED,
  variance_kg NUMERIC(12, 2) GENERATED ALWAYS AS (counted_kg - recorded_kg) STORED,
  notes TEXT,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, commodity, grade)
);
CALL attach_standard_triggers('audit_lines');

-- Down Migration

DROP TABLE audit_lines;
DROP TABLE audits;
