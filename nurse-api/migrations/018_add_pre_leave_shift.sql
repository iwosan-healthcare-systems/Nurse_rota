-- Store the original shift code before a cell is flipped to LEAVE,
-- so the cron job can credit the correct hours (M=9h, N=15h) on the leave date.
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS pre_leave_shift shift_code;
