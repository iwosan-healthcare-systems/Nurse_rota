-- One-time codes for the self-service "forgot password" flow. Hashed
-- (bcrypt) rather than stored plaintext — a 6-digit code is low-entropy on
-- its own, but hashing still means a DB leak alone can't be replayed
-- directly, same principle as profiles.password_hash.
CREATE TABLE password_reset_otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  otp_hash    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_password_reset_otps_user_id ON password_reset_otps(user_id);
