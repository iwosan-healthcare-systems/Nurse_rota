ALTER TABLE nurses ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS nurses_profile_id_unique ON nurses(profile_id) WHERE profile_id IS NOT NULL;
