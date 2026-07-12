-- Performance indexes for 250+ concurrent user launch.
-- All use CREATE INDEX IF NOT EXISTS — safe to run on a live database with no downtime.

-- Rota workflow queries filter heavily by status
CREATE INDEX IF NOT EXISTS idx_shift_assignments_status
  ON shift_assignments(status);

-- Reports date-range queries on shift_logs
CREATE INDEX IF NOT EXISTS idx_shift_logs_shift_date
  ON shift_logs(shift_date);

-- Nurse name lookup used in 5+ routes (profile → nurse resolution)
CREATE INDEX IF NOT EXISTS idx_nurses_name_lower
  ON nurses(LOWER(name));

-- Leave overlap detection query
CREATE INDEX IF NOT EXISTS idx_leave_requests_dates
  ON leave_requests(from_date, to_date);

-- Composite used by auto-end-shifts missed-shift subquery
CREATE INDEX IF NOT EXISTS idx_shift_assignments_nurse_status
  ON shift_assignments(nurse_id, status);

-- Notification state per user
CREATE INDEX IF NOT EXISTS idx_notification_state_user
  ON notification_state(user_id);
