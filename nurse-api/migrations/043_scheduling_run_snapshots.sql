-- Immutable review runs, separate from live shift_assignments. No activation.
ALTER TABLE scheduling_config_versions
  ADD CONSTRAINT scheduling_config_scope_identity UNIQUE (organization_id, facility_id, id);

CREATE TABLE scheduling_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  configuration_id UUID NOT NULL,
  configuration_version INTEGER NOT NULL CHECK (configuration_version > 0),
  configuration_revision INTEGER NOT NULL CHECK (configuration_revision > 0),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL CHECK (end_date = start_date + 27),
  engine_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  configuration_snapshot JSONB NOT NULL CHECK (jsonb_typeof(configuration_snapshot) = 'object'),
  input_snapshot JSONB NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
  result_snapshot JSONB NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, facility_id, configuration_id)
    REFERENCES scheduling_config_versions(organization_id, facility_id, id)
);
CREATE INDEX scheduling_runs_facility_created_idx ON scheduling_runs(facility_id, created_at DESC, id DESC);
CREATE FUNCTION protect_scheduling_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Saved scheduling runs are immutable; generate a new run';
END;
$$;
CREATE TRIGGER scheduling_run_guard BEFORE UPDATE OR DELETE ON scheduling_runs
  FOR EACH ROW EXECUTE FUNCTION protect_scheduling_run();
