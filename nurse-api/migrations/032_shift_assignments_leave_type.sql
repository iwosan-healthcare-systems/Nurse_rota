-- shift_assignments.shift = 'LEAVE' has never recorded WHICH leave type
-- produced it — the rota grid can only ever show a generic "LEAVE" pill,
-- with no way to distinguish Sick from Annual from Study Leave etc. without
-- a runtime join against leave_requests. Store it directly on the cell,
-- populated wherever a cell gets set to LEAVE (rota generation, and the
-- runtime flip when a leave request is approved after the rota already
-- exists) — same reasoning as pre_leave_shift already being stored inline
-- rather than requiring a join to reconstruct.
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS leave_type TEXT;

-- Backfill existing LEAVE cells written before this column existed, so
-- history shows the specific type too, not just anything generated from
-- here on. Matches the same nurse/date-range-overlap-against-an-Approved-
-- request logic already used at every runtime flip site (leave-requests.js,
-- shift-assignments.js). A cell with no currently-Approved request covering
-- it (e.g. the leave was later reverted) is left NULL — the rota grid
-- already falls back to the generic "LEAVE" label for that case, which is
-- the correct degrade when the specific type genuinely can't be determined.
UPDATE shift_assignments sa
   SET leave_type = (
     SELECT lr.type FROM leave_requests lr
     WHERE lr.nurse_id = sa.nurse_id AND lr.status = 'Approved' AND lr.type != 'Swap'
       AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
     LIMIT 1
   )
 WHERE sa.shift = 'LEAVE' AND sa.leave_type IS NULL;
