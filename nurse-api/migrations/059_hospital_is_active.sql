-- A deactivated hospital keeps its data, but its staff cannot sign in to it and
-- scheduled jobs skip it. Platform administrators can still open and reactivate it.
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
