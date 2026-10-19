-- Provenance only: existing shift codes and approval transitions stay intact.
ALTER TABLE shift_assignments ADD COLUMN scheduling_run_id UUID REFERENCES scheduling_runs(id);
CREATE INDEX shift_assignments_scheduling_run_idx ON shift_assignments(scheduling_run_id) WHERE scheduling_run_id IS NOT NULL;
CREATE FUNCTION clear_changed_scheduling_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scheduling_run_id IS NOT DISTINCT FROM OLD.scheduling_run_id AND
     (NEW.nurse_id,NEW.shift_date,NEW.shift,NEW.ward,NEW.pre_leave_shift,NEW.leave_type)
     IS DISTINCT FROM (OLD.nurse_id,OLD.shift_date,OLD.shift,OLD.ward,OLD.pre_leave_shift,OLD.leave_type) THEN
    NEW.scheduling_run_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shift_assignment_source_guard BEFORE UPDATE ON shift_assignments
  FOR EACH ROW EXECUTE FUNCTION clear_changed_scheduling_source();
