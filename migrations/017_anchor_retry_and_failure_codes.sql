-- Up Migration

-- When a recurring job last started, so a frequent job can run another at a
-- slower cadence (the 5-minute index job retries anchoring at most hourly).
-- Claimed atomically: a run starts only if it can move last_started_at.
CREATE TABLE job_runs (
  job TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('job_runs');

-- A machine-readable reason a pledge failed, e.g. books_not_anchored, beside
-- the human-readable `failure` text.
ALTER TABLE pledges ADD COLUMN failure_code TEXT;

-- Down Migration

ALTER TABLE pledges DROP COLUMN failure_code;
DROP TABLE job_runs;
