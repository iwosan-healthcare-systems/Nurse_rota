-- Introduces a dynamic `roles` table replacing the fixed `app_role` enum, so
-- admins can create custom system roles from the UI with real backend
-- enforcement (see nurse-api/middleware/capability.js). Apply manually against
-- the target DB — no migration runner in this repo, same convention as
-- migrations 001-021.

BEGIN;

-- 1. Authoritative role registry (system + custom roles).
CREATE TABLE roles (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Seed the 10 roles baked into the frontend AppRole union and the many
--    hardcoded business-workflow checks (rota approval pipeline, etc).
--    is_system = true is PERMANENT: these keys must never be renamed or
--    deleted, or those literal-string comparisons silently break.
INSERT INTO roles (key, label, description, is_system) VALUES
  ('admin',             'System Administrator',  'Full system access — manage staff, wards, users and all settings', true),
  ('cno',               'Chief Nursing Officer',  'Approve rotas, manage shift switches and oversee all facilities', true),
  ('chief_matron',      'Chief Matron',           'Review and approve rotas, manage leave and ward staffing', true),
  ('head_nurse',        'Head Nurse',             'Provide coverage across wards, manage schedules and approve leave', true),
  ('hr_admin',          'HR / Admin',             'Manage staff records, leave requests and HR administration', true),
  ('service_support',   'Service Support',        'Manage user accounts, reset passwords, assign roles and view audit logs', true),
  ('nurse',             'Nurse',                  'View your schedule, submit leave requests and access rota', true),
  ('porter',            'Porter',                 'View your schedule, submit leave requests and access rota', true),
  ('nursing_assistant', 'Nursing Assistant',      'View your schedule, submit leave requests and access rota', true),
  ('surgical_nurse',    'Surgical Nurse',         'Surgical Unit — view your schedule, submit leave requests and access rota', true);

-- 3. Legacy enum value with no application-code usage (not in the frontend
--    AppRole union, not referenced by any requireRole/cap() call). Seeded as
--    non-system so the FK conversion below can never fail regardless of any
--    stray user_roles row, and so it can be cleaned up later via
--    DELETE /roles/ward_manager once confirmed unused (the route's delete
--    guard checks for zero remaining references before allowing it).
INSERT INTO roles (key, label, description, is_system) VALUES
  ('ward_manager', 'Ward Manager', 'Legacy role from the original enum — not referenced by any current frontend or backend logic. Safe to delete once confirmed unused.', false);

-- 4. Convert user_roles.role from the app_role ENUM to TEXT with FK integrity.
--    Existing values (already valid enum labels, exactly the keys seeded
--    above) survive unchanged via the ::text cast.
ALTER TABLE user_roles ALTER COLUMN role TYPE TEXT USING role::text;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_role_fkey FOREIGN KEY (role) REFERENCES roles(key);

-- 5. Support the role-filtered query already used by GET /api/user-roles?role=.
CREATE INDEX idx_user_roles_role ON user_roles(role);

COMMIT;

-- ── OPTIONAL, run separately after the above has soaked in production ──────
-- Drop the now-unused app_role enum type. Run this verification query FIRST
-- (outside a transaction) to confirm no other column anywhere still uses it —
-- schema.sql shows only user_roles.role ever did, but confirm live:
--
--   SELECT c.relname AS table_name, a.attname AS column_name
--   FROM pg_attribute a
--   JOIN pg_class c ON a.attrelid = c.oid
--   JOIN pg_type t ON a.atttypid = t.oid
--   WHERE t.typname = 'app_role' AND a.attnum > 0 AND NOT a.attisdropped;
--
-- If that returns zero rows, it is safe to run:
--
--   DROP TYPE IF EXISTS app_role;
