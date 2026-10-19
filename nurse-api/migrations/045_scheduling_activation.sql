ALTER TABLE scheduling_facilities ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduling_runs ADD CONSTRAINT scheduling_run_scope UNIQUE(facility_id,id);
ALTER TABLE scheduling_runs ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE scheduling_runs ADD COLUMN generation_source TEXT NOT NULL DEFAULT 'manual' CHECK(generation_source IN ('manual','automatic'));
ALTER TABLE scheduling_runs ADD CONSTRAINT scheduling_run_actor CHECK(created_by IS NOT NULL OR generation_source='automatic');
CREATE TABLE scheduling_policy_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES scheduling_facilities(id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  state TEXT NOT NULL CHECK(state IN ('active','paused')),
  source_run_id UUID,
  effective_from DATE NOT NULL,
  period_anchor DATE NOT NULL,
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(facility_id,sequence),
  FOREIGN KEY(facility_id,source_run_id) REFERENCES scheduling_runs(facility_id,id),
  CHECK((state='active' AND source_run_id IS NOT NULL) OR (state='paused' AND source_run_id IS NULL))
);
CREATE TRIGGER scheduling_policy_event_guard BEFORE UPDATE OR DELETE ON scheduling_policy_events
FOR EACH ROW EXECUTE FUNCTION protect_scheduling_run();
CREATE INDEX scheduling_policy_resolve_idx ON scheduling_policy_events(facility_id,sequence DESC);
