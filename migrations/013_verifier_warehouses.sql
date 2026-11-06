-- Up Migration

-- Verifiers are scoped to warehouses, as custodians are (docs/decisions.md
-- D44): a verifier may co-sign intake, audits, adjustments and mints only at
-- a warehouse they are assigned to. An assignment is never deleted, only
-- marked removed, because past attestations keep referring to it.

CREATE TABLE verifier_warehouses (
  verifier_id UUID NOT NULL REFERENCES verifiers (id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (verifier_id, warehouse_id),
  CONSTRAINT verifier_warehouses_removed_has_date CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
CALL attach_standard_triggers('verifier_warehouses');
CREATE INDEX verifier_warehouses_warehouse_id_idx ON verifier_warehouses (warehouse_id);

-- Existing attestations become assignments, so every past row satisfies the
-- keys below. Review these after migrating: they record where verifiers
-- have acted, not where they should.
INSERT INTO verifier_warehouses (verifier_id, warehouse_id)
SELECT verifier_id, warehouse_id FROM deposits
UNION SELECT conducted_by, warehouse_id FROM audits
UNION SELECT authorised_by, warehouse_id FROM stock_adjustments
UNION SELECT verifier_id, warehouse_id FROM pledges;

ALTER TABLE deposits ADD CONSTRAINT deposits_verifier_at_warehouse
  FOREIGN KEY (verifier_id, warehouse_id) REFERENCES verifier_warehouses (verifier_id, warehouse_id);
ALTER TABLE audits ADD CONSTRAINT audits_verifier_at_warehouse
  FOREIGN KEY (conducted_by, warehouse_id) REFERENCES verifier_warehouses (verifier_id, warehouse_id);
ALTER TABLE stock_adjustments ADD CONSTRAINT stock_adjustments_verifier_at_warehouse
  FOREIGN KEY (authorised_by, warehouse_id) REFERENCES verifier_warehouses (verifier_id, warehouse_id);
ALTER TABLE pledges ADD CONSTRAINT pledges_verifier_at_warehouse
  FOREIGN KEY (verifier_id, warehouse_id) REFERENCES verifier_warehouses (verifier_id, warehouse_id);

-- Down Migration

ALTER TABLE pledges DROP CONSTRAINT pledges_verifier_at_warehouse;
ALTER TABLE stock_adjustments DROP CONSTRAINT stock_adjustments_verifier_at_warehouse;
ALTER TABLE audits DROP CONSTRAINT audits_verifier_at_warehouse;
ALTER TABLE deposits DROP CONSTRAINT deposits_verifier_at_warehouse;
DROP TABLE verifier_warehouses;
