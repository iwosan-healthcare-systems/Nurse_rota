-- Capture the nurse's role at the moment a shift_assignments row is first
-- created, so the Schedule Archive shows history as it actually was — a later
-- role change (e.g. Coverage Nurse -> Nurse) must not rewrite what already
-- happened. Never overwritten on conflict (see shift-assignments.js) — the
-- first snapshot for a given (nurse_id, shift_date) row sticks, same pattern
-- as created_by.
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS nurse_role TEXT;

-- Backfill existing rows with the nurse's CURRENT role as a best-effort default.
-- We have no historical record of what role a nurse held before this column
-- existed, so old archive windows may still show today's role until this
-- backfill's approximation is superseded by newly-generated rows going forward.
UPDATE shift_assignments sa
SET nurse_role = n.role
FROM nurses n
WHERE sa.nurse_id = n.id AND sa.nurse_role IS NULL;
