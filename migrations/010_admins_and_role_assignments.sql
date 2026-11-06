-- Up Migration

-- Farmledge admins, the role-assignment log, and per-commodity shrinkage
-- tolerance (docs/decisions.md D27-D28).

-- ---------------------------------------------------------------------------
-- Farmledge staff who set up warehouse owners. The first admin is created
-- by `npm run create-admin`; no endpoint creates admins.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('platform_admins');

-- ---------------------------------------------------------------------------
-- Every role assignment: who got which role, who gave it, when and why.
-- Owners are assigned by an admin through the API; admins by an operator
-- through the CLI. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('platform_admin', 'warehouse_owner')),
  admin_id UUID REFERENCES platform_admins (id),
  owner_id UUID,
  warehouse_id UUID REFERENCES warehouses (id),
  -- Set when an existing custodian was promoted to owner.
  from_custodian_id UUID,
  assigned_by UUID REFERENCES platform_admins (id),
  assigned_via TEXT NOT NULL CHECK (assigned_via IN ('admin_api', 'cli')),
  -- The person who ran the CLI.
  operator TEXT CHECK (char_length(operator) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  assigned_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, warehouse_id) REFERENCES warehouse_owners (id, warehouse_id),
  FOREIGN KEY (from_custodian_id, warehouse_id) REFERENCES custodians (id, warehouse_id),
  CONSTRAINT role_assignments_subject CHECK (
    (role = 'warehouse_owner' AND owner_id IS NOT NULL AND warehouse_id IS NOT NULL
       AND admin_id IS NULL)
    OR (role = 'platform_admin' AND admin_id IS NOT NULL AND owner_id IS NULL
       AND warehouse_id IS NULL AND from_custodian_id IS NULL)
  ),
  -- Owners only by an admin through the API; admins only through the CLI.
  CONSTRAINT role_assignments_source CHECK (
    (assigned_via = 'admin_api' AND assigned_by IS NOT NULL AND operator IS NULL
       AND role = 'warehouse_owner')
    OR (assigned_via = 'cli' AND assigned_by IS NULL AND operator IS NOT NULL
       AND role = 'platform_admin')
  )
);
CALL attach_standard_triggers('role_assignments');
CALL make_append_only('role_assignments');
CREATE INDEX role_assignments_owner_idx ON role_assignments (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX role_assignments_admin_idx ON role_assignments (admin_id) WHERE admin_id IS NOT NULL;
CREATE INDEX role_assignments_warehouse_idx ON role_assignments (warehouse_id, assigned_at);

-- An admin or owner created from now on must have its assignment logged in
-- the same transaction. Checked at commit, so the two rows may be written in
-- either order. Owners loaded before this migration are left as they are.
CREATE FUNCTION require_role_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM role_assignments
     WHERE (TG_TABLE_NAME = 'platform_admins' AND admin_id = NEW.id)
        OR (TG_TABLE_NAME = 'warehouse_owners' AND owner_id = NEW.id)
  ) THEN
    RAISE EXCEPTION '% % was created without a role assignment', TG_TABLE_NAME, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_role_assignment AFTER INSERT ON platform_admins
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_role_assignment();
CREATE CONSTRAINT TRIGGER require_role_assignment AFTER INSERT ON warehouse_owners
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_role_assignment();

-- ---------------------------------------------------------------------------
-- Shrinkage tolerance per commodity, with a warehouse default (no commodity)
-- used when a commodity has none: the same pattern as fee schedules (D26).
-- ---------------------------------------------------------------------------
ALTER TABLE warehouse_shrinkage_tolerances
  ADD COLUMN commodity TEXT CHECK (commodity IN ('MAIZE_WHITE', 'MAIZE_YELLOW'));
DROP INDEX warehouse_shrinkage_tolerances_idx;
CREATE INDEX warehouse_shrinkage_tolerances_idx
  ON warehouse_shrinkage_tolerances (warehouse_id, commodity, created_at);

-- Down Migration

DROP INDEX warehouse_shrinkage_tolerances_idx;
ALTER TABLE warehouse_shrinkage_tolerances DROP COLUMN commodity;
CREATE INDEX warehouse_shrinkage_tolerances_idx
  ON warehouse_shrinkage_tolerances (warehouse_id, created_at);

DROP TRIGGER require_role_assignment ON warehouse_owners;
DROP TRIGGER require_role_assignment ON platform_admins;
DROP FUNCTION require_role_assignment();
DROP TABLE role_assignments;
DROP TABLE platform_admins;
