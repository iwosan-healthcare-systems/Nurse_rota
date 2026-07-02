-- ============================================================
-- Nurse Rota PostgreSQL Schema
-- Generated from src/integrations/supabase/types.ts
-- ============================================================

-- Enums
CREATE TYPE app_role AS ENUM ('cno', 'chief_matron', 'head_nurse', 'ward_manager', 'hr_admin', 'nurse', 'admin');
CREATE TYPE assignment_status AS ENUM ('draft', 'submitted', 'approved_chief', 'approved_cno', 'published');
CREATE TYPE leave_status AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE TYPE leave_type AS ENUM ('Sick', 'Annual', 'Emergency', 'Public Holiday', 'Swap');
CREATE TYPE shift_code AS ENUM ('M', 'N', 'OFF', 'LEAVE', 'MWC', 'NC');

-- profiles (central auth/user table — replaces Supabase auth.users)
CREATE TABLE profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT,
  full_name     TEXT,
  password_hash TEXT NOT NULL DEFAULT '',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- user_roles
CREATE TABLE user_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role       app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- audit_logs
CREATE TABLE audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action     TEXT NOT NULL,
  actor_id   UUID,
  actor_name TEXT,
  actor_role TEXT,
  target     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- nurses
CREATE TABLE nurses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  email            TEXT,
  role             TEXT NOT NULL DEFAULT 'nurse',
  ward             TEXT,
  facility         TEXT,
  certifications   TEXT[] NOT NULL DEFAULT '{}',
  hours_this_month NUMERIC NOT NULL DEFAULT 0,
  target_hours     NUMERIC NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- wards
CREATE TABLE wards (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  facility              TEXT,
  patients              INTEGER NOT NULL DEFAULT 0,
  staffed               INTEGER NOT NULL DEFAULT 0,
  ratio                 TEXT,
  min_morning_nurses    INTEGER NOT NULL DEFAULT 0,
  min_morning_supervisor INTEGER NOT NULL DEFAULT 0,
  min_morning_na        INTEGER NOT NULL DEFAULT 0,
  min_night_nurses      INTEGER NOT NULL DEFAULT 0,
  min_night_supervisor  INTEGER NOT NULL DEFAULT 0,
  min_night_na          INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- portal_settings
CREATE TABLE portal_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'
);

-- leave_requests
CREATE TABLE leave_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nurse_id     UUID REFERENCES nurses(id) ON DELETE SET NULL,
  nurse_name   TEXT NOT NULL,
  type         leave_type NOT NULL,
  status       leave_status NOT NULL DEFAULT 'Pending',
  from_date    DATE NOT NULL,
  to_date      DATE NOT NULL,
  reason       TEXT,
  requested_by UUID,
  reviewed_by  UUID,
  review_note  TEXT,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- shift_assignments
CREATE TABLE shift_assignments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nurse_id   UUID NOT NULL REFERENCES nurses(id) ON DELETE CASCADE,
  shift      shift_code NOT NULL,
  shift_date DATE NOT NULL,
  ward       TEXT,
  status     assignment_status NOT NULL DEFAULT 'draft',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (nurse_id, shift_date)
);

-- shift_logs
CREATE TABLE shift_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nurse_id          UUID NOT NULL REFERENCES nurses(id) ON DELETE CASCADE,
  shift_date        DATE NOT NULL,
  shift_type        shift_code NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  expected_end_at   TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  hours_logged      NUMERIC,
  period_start      DATE NOT NULL,
  is_late           BOOLEAN NOT NULL DEFAULT FALSE,
  late_minutes      INTEGER,
  late_reason       TEXT,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  ip_address        TEXT,
  is_locum          BOOLEAN NOT NULL DEFAULT FALSE,
  locum_request_id  UUID,
  is_leave          BOOLEAN NOT NULL DEFAULT FALSE,
  leave_request_id  UUID,
  is_swap           BOOLEAN NOT NULL DEFAULT FALSE,
  swap_note         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- nurse_period_hours
CREATE TABLE nurse_period_hours (
  nurse_id     UUID NOT NULL REFERENCES nurses(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  total_hours  NUMERIC NOT NULL,
  total_shifts INTEGER NOT NULL,
  PRIMARY KEY (nurse_id, period_start)
);

-- notification_state
CREATE TABLE notification_state (
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  notif_key  TEXT NOT NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, notif_key)
);

-- locum_requests
CREATE TABLE locum_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_date            DATE NOT NULL,
  shift                 TEXT NOT NULL,
  facility              TEXT NOT NULL,
  ward                  TEXT NOT NULL,
  nurses_in_ward        INTEGER NOT NULL,
  ventilated_patients   INTEGER NOT NULL,
  hdu_nurses            INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  requested_by          UUID NOT NULL,
  requested_by_name     TEXT NOT NULL,
  reviewed_by           UUID,
  reviewed_by_name      TEXT,
  decline_reason        TEXT,
  reviewed_at           TIMESTAMPTZ,
  accepted_by_nurse_id  UUID,
  accepted_by_nurse_name TEXT,
  accepted_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- locum_invites
CREATE TABLE locum_invites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locum_request_id  UUID NOT NULL REFERENCES locum_requests(id) ON DELETE CASCADE,
  nurse_id          UUID NOT NULL,
  nurse_name        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  decline_reason    TEXT,
  responded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- increment_nurse_hours function (called via API for atomic hour updates)
CREATE OR REPLACE FUNCTION increment_nurse_hours(p_nurse_id UUID, p_hours NUMERIC)
RETURNS void AS $$
BEGIN
  UPDATE nurses
  SET hours_this_month = hours_this_month + p_hours,
      updated_at = NOW()
  WHERE id = p_nurse_id;
END;
$$ LANGUAGE plpgsql;

-- Indexes for common query patterns
CREATE INDEX idx_shift_assignments_nurse_date ON shift_assignments(nurse_id, shift_date);
CREATE INDEX idx_shift_assignments_date ON shift_assignments(shift_date);
CREATE INDEX idx_shift_logs_nurse_id ON shift_logs(nurse_id);
CREATE INDEX idx_shift_logs_period ON shift_logs(period_start);
CREATE INDEX idx_leave_requests_nurse_id ON leave_requests(nurse_id);
CREATE INDEX idx_leave_requests_status ON leave_requests(status);
CREATE INDEX idx_locum_requests_status ON locum_requests(status);
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_nurses_ward ON nurses(ward);
CREATE INDEX idx_nurses_facility ON nurses(facility);
