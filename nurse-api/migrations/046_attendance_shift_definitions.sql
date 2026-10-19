-- Definition identity survives leave/status edits independently of generation provenance.
ALTER TABLE shift_assignments ADD COLUMN shift_definition_run_id UUID REFERENCES scheduling_runs(id);
UPDATE shift_assignments SET shift_definition_run_id=scheduling_run_id WHERE scheduling_run_id IS NOT NULL;
ALTER TABLE shift_logs ADD COLUMN scheduling_definition JSONB;
ALTER TABLE shift_logs ADD CONSTRAINT scheduling_definition_object CHECK(scheduling_definition IS NULL OR jsonb_typeof(scheduling_definition)='object');

CREATE OR REPLACE FUNCTION clear_changed_scheduling_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shift_definition_run_id IS NOT DISTINCT FROM OLD.shift_definition_run_id AND
     (NEW.nurse_id,NEW.shift_date) IS DISTINCT FROM (OLD.nurse_id,OLD.shift_date) THEN
    NEW.shift_definition_run_id := NULL;
  END IF;
  IF NEW.scheduling_run_id IS NOT DISTINCT FROM OLD.scheduling_run_id AND
     (NEW.nurse_id,NEW.shift_date,NEW.shift,NEW.ward,NEW.pre_leave_shift,NEW.leave_type)
     IS DISTINCT FROM (OLD.nurse_id,OLD.shift_date,OLD.shift,OLD.ward,OLD.pre_leave_shift,OLD.leave_type) THEN
    NEW.scheduling_run_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Deduct the configured break once and cap attendance credit at the saved allowance.
-- Legacy logs retain elapsed-hour calculation in their callers.
CREATE FUNCTION configured_attendance_hours(definition JSONB, started TIMESTAMPTZ, ended TIMESTAMPTZ)
RETURNS NUMERIC LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT ROUND(LEAST((definition->>'creditedMinutes')::numeric,
    GREATEST(0, EXTRACT(EPOCH FROM (
      LEAST(ended,(definition->>'endsAt')::timestamptz) -
      GREATEST(started,(definition->>'startsAt')::timestamptz)
    ))/60 - (definition->>'breakMinutes')::numeric))/60,2)
$$;
