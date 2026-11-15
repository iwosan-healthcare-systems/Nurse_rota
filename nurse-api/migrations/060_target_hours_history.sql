-- Target hours become dated. Changing a target takes effect from the start of
-- the next rota period: the period in progress, closed periods and their
-- exports keep the target that applied to them.
--
-- nurse_target_hours holds each person's target from a date onward;
-- nurses.target_hours stays the target for today (kept current by the
-- period-close job), so everything that shows the current period is unchanged.
CREATE TABLE nurse_target_hours (
  nurse_id       UUID NOT NULL REFERENCES nurses(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  hours          NUMERIC NOT NULL CHECK (hours >= 0),
  hospital_id    UUID NOT NULL DEFAULT app_current_hospital() REFERENCES hospitals(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (nurse_id, effective_from)
);
CREATE INDEX nurse_target_hours_hospital_idx ON nurse_target_hours (hospital_id);
ALTER TABLE nurse_target_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE nurse_target_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY hospital_isolation ON nurse_target_hours
  USING (app_hospital_visible(hospital_id)) WITH CHECK (app_hospital_visible(hospital_id));

-- A person's target on a date: the latest dated target on or before it, or
-- their current target when they have no dated history.
CREATE FUNCTION nurse_target_hours_on(n UUID, d DATE) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT t.hours FROM nurse_target_hours t
      WHERE t.nurse_id = n AND t.effective_from <= d
      ORDER BY t.effective_from DESC LIMIT 1),
    (SELECT x.target_hours FROM nurses x WHERE x.id = n)
  )
$$;

-- Archived periods record the target that applied to them. Periods already
-- closed keep today's target, which is what applied while they ran.
ALTER TABLE nurse_period_hours ADD COLUMN target_hours NUMERIC;
UPDATE nurse_period_hours p SET target_hours = n.target_hours
FROM nurses n WHERE n.id = p.nurse_id AND p.target_hours IS NULL;
