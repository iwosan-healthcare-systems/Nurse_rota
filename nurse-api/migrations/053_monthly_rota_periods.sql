-- Rota periods become calendar months (1st to last day).
--
-- A hospital that already runs 28-day periods keeps them up to a cutover: every
-- 28-day period that already has assignments (published, approved, submitted or
-- draft) finishes unchanged. The rest of the month after the cutover is one
-- short transition period, then periods are calendar months. Hospitals with no
-- rota history (and every new hospital) are monthly from the start.
ALTER TABLE hospitals ADD COLUMN legacy_period_anchor DATE;
ALTER TABLE hospitals ADD COLUMN legacy_period_until DATE;
ALTER TABLE hospitals ADD CONSTRAINT hospitals_legacy_periods CHECK (
  (legacy_period_anchor IS NULL) = (legacy_period_until IS NULL)
  AND (legacy_period_until IS NULL OR legacy_period_until >= legacy_period_anchor)
);

-- The 28-day cycle was anchored on the first published shift; it ends with the
-- 28-day period holding the latest assignment of any status.
UPDATE hospitals h SET
  legacy_period_anchor = c.anchor,
  legacy_period_until = c.anchor + (((c.latest - c.anchor) / 28) + 1) * 28 - 1
FROM (
  SELECT n.hospital_id,
         MIN(a.shift_date) FILTER (WHERE a.status = 'published') AS anchor,
         MAX(a.shift_date) AS latest
  FROM shift_assignments a JOIN nurses n ON n.id = a.nurse_id
  GROUP BY n.hospital_id
) c
WHERE c.hospital_id = h.id AND c.anchor IS NOT NULL AND c.latest >= c.anchor;

-- First and last day of the rota period containing d, for hospital h (the
-- current hospital by default; NULL in platform scope without a hospital).
CREATE FUNCTION rota_period_start(d DATE, h UUID DEFAULT app_current_hospital())
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN x.legacy_period_until IS NOT NULL AND d <= x.legacy_period_until
      THEN x.legacy_period_anchor + (floor((d - x.legacy_period_anchor) / 28.0)::int * 28)
    WHEN x.legacy_period_until IS NOT NULL
      THEN GREATEST(date_trunc('month', d)::date, x.legacy_period_until + 1)
    ELSE date_trunc('month', d)::date
  END
  FROM hospitals x WHERE x.id = h
$$;
CREATE FUNCTION rota_period_end(d DATE, h UUID DEFAULT app_current_hospital())
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN x.legacy_period_until IS NOT NULL AND d <= x.legacy_period_until
      THEN rota_period_start(d, h) + 27
    ELSE (date_trunc('month', d) + INTERVAL '1 month - 1 day')::date
  END
  FROM hospitals x WHERE x.id = h
$$;

-- Saved scheduling runs cover one rota period: a month, or a short transition period.
ALTER TABLE scheduling_runs DROP CONSTRAINT scheduling_runs_check;
ALTER TABLE scheduling_runs ADD CONSTRAINT scheduling_runs_period
  CHECK (end_date >= start_date AND end_date <= start_date + 30);
