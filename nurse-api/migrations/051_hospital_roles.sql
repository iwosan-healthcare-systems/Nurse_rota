-- Each hospital chooses which roles it uses. The role catalogue (system roles and
-- custom roles created by any hospital) stays global; hospital_roles enables a
-- role in a hospital. Inside a hospital only its enabled roles (plus Administrator,
-- which every hospital has) are visible and assignable.
CREATE TABLE hospital_roles (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  -- Deferred so a role created inside a hospital can be enabled before its row exists.
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, role_key)
);
CREATE INDEX hospital_roles_role_idx ON hospital_roles (role_key);

ALTER TABLE hospital_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hospital_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY hospital_isolation ON hospital_roles
  USING (app_hospital_visible(hospital_id)) WITH CHECK (app_hospital_visible(hospital_id));

-- Visible roles: Administrator, and roles enabled in the current hospital.
-- VOLATILE so a creating INSERT's RETURNING sees the enablement its trigger added.
CREATE FUNCTION app_role_enabled(role_key TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE
SECURITY DEFINER SET search_path = public AS $$
  SELECT app_platform_scope() OR role_key = 'admin' OR EXISTS (
    SELECT 1 FROM hospital_roles WHERE hospital_roles.role_key = app_role_enabled.role_key
      AND hospital_id = app_current_hospital())
$$;
DROP POLICY roles_read ON roles;
CREATE POLICY roles_read ON roles FOR SELECT USING (app_role_enabled(key));

-- A custom role created inside a hospital is enabled there immediately.
CREATE FUNCTION roles_enable_in_current_hospital() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_current_hospital() IS NOT NULL THEN
    INSERT INTO hospital_roles (hospital_id, role_key) VALUES (app_current_hospital(), NEW.key)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_enable_in_current_hospital BEFORE INSERT ON roles
FOR EACH ROW EXECUTE FUNCTION roles_enable_in_current_hospital();

-- Lagoon keeps every role it has today: all system roles and its custom roles.
-- Last, because the deferred foreign key leaves pending checks that would block
-- the ALTER TABLE statements above within this single-transaction migration.
INSERT INTO hospital_roles (hospital_id, role_key)
SELECT '00000000-0000-4000-8000-000000000001', key FROM roles
WHERE hospital_id IS NULL OR hospital_id = '00000000-0000-4000-8000-000000000001';
