-- When a staff member is removed from the rota, their login can stay usable
-- until their last shift ends. After this time the account counts as inactive
-- (sign-in and every request refuse it) and a job switches the profile off.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS login_ends_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS profiles_login_ends_at_idx ON profiles (login_ends_at)
  WHERE login_ends_at IS NOT NULL;
