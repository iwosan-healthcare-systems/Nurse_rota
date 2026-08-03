-- Prevent duplicate "live" shift-start rows for the same nurse/date/shift, caused by
-- double-clicking "Start Shift" or a network retry re-submitting the same request.
--
-- Deliberately scoped to is_leave = false AND is_missed = false ("real clock-in" rows
-- only) — a leave-approval top-up row (is_leave = true) and a cron-recorded missed-shift
-- row (is_missed = true) are allowed to coexist alongside a real row for the same
-- nurse/date/shift_type by design (see leave-requests.js and auto-end-shifts.js), so
-- they must stay outside this constraint.

-- De-duplicate existing bad rows first, so the unique index can actually be created.
-- Per duplicate group, keeps the row with the most hours logged (most likely to be the
-- one the nurse actually ended/is still using), tie-broken by earliest start then lowest id.
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY nurse_id, shift_date, shift_type
      ORDER BY COALESCE(hours_logged, 0) DESC, started_at ASC, id ASC
    ) AS rn
  FROM shift_logs
  WHERE is_leave = false AND is_missed = false
)
DELETE FROM shift_logs
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shift_logs_live_start
  ON shift_logs (nurse_id, shift_date, shift_type)
  WHERE is_leave = false AND is_missed = false;
