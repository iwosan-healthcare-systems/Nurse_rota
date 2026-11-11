-- Where a duty is worked when it is not the nurse's own location (set by a
-- shift switch between locations). NULL means the nurse's own facility.
ALTER TABLE shift_assignments ADD COLUMN work_facility TEXT
  CHECK (work_facility IS NULL OR btrim(work_facility) <> '');
