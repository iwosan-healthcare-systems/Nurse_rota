-- Track when each user last set their password (independent of profile updated_at).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
-- Backfill: treat all existing accounts as having just changed their password
-- so nobody is immediately expired on first deploy.
UPDATE profiles SET password_changed_at = NOW() WHERE password_changed_at IS NULL;
ALTER TABLE profiles ALTER COLUMN password_changed_at SET DEFAULT NOW();
ALTER TABLE profiles ALTER COLUMN password_changed_at SET NOT NULL;

-- Default password expiry: 30 days. Admin can change this via the Menu Access settings page.
INSERT INTO portal_settings (key, value)
VALUES ('password_expiry_days', '30')
ON CONFLICT (key) DO NOTHING;
