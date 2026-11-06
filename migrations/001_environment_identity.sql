-- Up Migration

-- Every database belongs to exactly one environment, fixed when it is first
-- migrated. The migrator sets `farmledge.environment` from FARMLEDGE_ENV on
-- its session; current_setting() raises if it is unset, so a database can
-- never be created without an identity.
CREATE TYPE farmledge_environment AS ENUM ('test', 'live');

CREATE TABLE db_environment (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  environment farmledge_environment NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO db_environment (environment)
VALUES (current_setting('farmledge.environment')::farmledge_environment);

CREATE FUNCTION forbid_db_environment_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'db_environment is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER db_environment_immutable
  BEFORE UPDATE OR DELETE ON db_environment
  FOR EACH ROW EXECUTE FUNCTION forbid_db_environment_change();

CREATE TRIGGER db_environment_no_truncate
  BEFORE TRUNCATE ON db_environment
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_db_environment_change();

CREATE FUNCTION current_db_environment() RETURNS farmledge_environment
LANGUAGE sql STABLE AS $$
  SELECT environment FROM db_environment
$$;

-- Every table carries `environment DEFAULT current_db_environment()`. This
-- trigger rejects any row that names a different environment, so test and
-- live rows can never be mixed, even by hand-written SQL.
CREATE FUNCTION enforce_row_environment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  db_env farmledge_environment := current_db_environment();
BEGIN
  IF NEW.environment IS DISTINCT FROM db_env THEN
    RAISE EXCEPTION 'row environment % does not match database environment %',
      NEW.environment, db_env
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Attaches the environment and updated_at triggers. Call once per table.
CREATE PROCEDURE attach_standard_triggers(target regclass)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER enforce_environment BEFORE INSERT OR UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION enforce_row_environment()', target);
  EXECUTE format(
    'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', target);
END;
$$;

-- Down Migration

DROP PROCEDURE attach_standard_triggers(regclass);
DROP FUNCTION set_updated_at();
DROP FUNCTION enforce_row_environment();
DROP FUNCTION current_db_environment();
DROP TABLE db_environment;
DROP FUNCTION forbid_db_environment_change();
DROP TYPE farmledge_environment;
