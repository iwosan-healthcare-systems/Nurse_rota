ALTER TABLE wards
  DROP COLUMN IF EXISTS patients,
  DROP COLUMN IF EXISTS staffed,
  DROP COLUMN IF EXISTS ratio,
  DROP COLUMN IF EXISTS min_morning_supervisor,
  DROP COLUMN IF EXISTS min_night_supervisor;
