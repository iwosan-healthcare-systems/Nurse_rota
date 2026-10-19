-- Locum requests record the requested shift's display name and absolute start,
-- resolved at creation from the facility's activated configuration, so expiry
-- and display no longer assume Morning 08:00 / Night 17:00.
ALTER TABLE locum_requests ADD COLUMN IF NOT EXISTS shift_name TEXT;
ALTER TABLE locum_requests ADD COLUMN IF NOT EXISTS shift_starts_at TIMESTAMPTZ;
