-- Clear stale ward values from nurses in facility-wide roles.
-- Coverage/Head Nurses, Nurse Interns, and Porters are not ward-bound;
-- their ward column should always be NULL.
UPDATE nurses
SET ward = NULL, updated_at = NOW()
WHERE ward IS NOT NULL
  AND role ~* '^(head|coverage)\s*nurse$|^intern\s*nurse$|^nurse\s*intern$|^porter(\s*-\s*day)?$';
