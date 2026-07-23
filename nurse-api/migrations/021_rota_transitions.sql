-- Track every rota status event (advances and reverts) as a full audit trail.
-- No UNIQUE constraint — if a rota is reverted and goes through phases again,
-- every occurrence is kept so the full history is visible.
CREATE TABLE IF NOT EXISTS rota_transitions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  facility        TEXT        NOT NULL,
  ward            TEXT,                    -- NULL for facility-wide groups
  role_group      TEXT,                    -- 'matron'|'head'|'porter'|'intern' for facility-wide, NULL for ward nurses
  period_start    DATE        NOT NULL,
  period_end      DATE        NOT NULL,    -- last day of the rota period
  status          TEXT        NOT NULL,    -- submitted | approved_chief | approved_cno | published | draft
  event_type      TEXT        NOT NULL DEFAULT 'advance',  -- 'advance' | 'revert'
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id        UUID,
  actor_name      TEXT
);

CREATE INDEX IF NOT EXISTS rota_transitions_facility_period
  ON rota_transitions (facility, period_start, transitioned_at);
