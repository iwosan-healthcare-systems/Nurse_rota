-- Per-user ADDITIVE capability overrides. A user's effective capability set
-- = union of everything their role(s) grant (portal_settings.capabilities)
-- PLUS whatever's listed here for their user_id. Never subtractive — no
-- "deny" list, no way to use this table to take away something a role
-- already grants. Menu/page access is NOT covered here — that stays purely
-- role-based, no per-user exceptions (confirmed with the user).
--
-- Admin users never need a row here — they bypass every capability check
-- unconditionally already (see checkCapability in middleware/capability.js).
-- That's enforced at the application layer (the admin picker excludes them),
-- not a DB constraint, since admin-ness lives in user_roles, not this table.
CREATE TABLE user_capability_overrides (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  capability_key   TEXT NOT NULL,
  created_by       UUID REFERENCES profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per user/capability — also the index checkCapability's per-request
-- lookup relies on (leading column user_id, so a WHERE user_id=$1 AND
-- capability_key=$2 lookup is a single indexed hit).
CREATE UNIQUE INDEX uq_user_capability_overrides_user_key
  ON user_capability_overrides (user_id, capability_key);
