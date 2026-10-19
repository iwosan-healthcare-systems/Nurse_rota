-- Custom roles belong to the hospital that created them. Built-in system roles
-- (hospital_id NULL) are shared by every hospital and read-only inside one.
ALTER TABLE roles ADD COLUMN hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE;
UPDATE roles SET hospital_id = '00000000-0000-4000-8000-000000000001' WHERE NOT is_system;
-- New roles default to the hospital being worked in (platform scope: a system role).
ALTER TABLE roles ALTER COLUMN hospital_id SET DEFAULT app_current_hospital();
CREATE INDEX roles_hospital_idx ON roles (hospital_id);
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_read ON roles FOR SELECT
  USING (hospital_id IS NULL OR app_hospital_visible(hospital_id));
CREATE POLICY roles_write ON roles FOR INSERT
  WITH CHECK (app_platform_scope() OR hospital_id = app_current_hospital());
CREATE POLICY roles_update ON roles FOR UPDATE
  USING (app_platform_scope() OR hospital_id = app_current_hospital())
  WITH CHECK (app_platform_scope() OR hospital_id = app_current_hospital());
CREATE POLICY roles_delete ON roles FOR DELETE
  USING (app_platform_scope() OR hospital_id = app_current_hospital());

-- A role can only be assigned where it is visible: a system role, or a custom
-- role of the hospital being worked in. (Foreign keys ignore row-level security.)
CREATE FUNCTION user_roles_visible_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM roles WHERE key = NEW.role) THEN
    RAISE EXCEPTION 'Role % is not available in this hospital', NEW.role
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_visible_role BEFORE INSERT OR UPDATE OF role ON user_roles
FOR EACH ROW EXECUTE FUNCTION user_roles_visible_role();

-- First platform administrator. Further ones are granted on the Hospitals page.
UPDATE profiles SET is_super_admin = TRUE
WHERE lower(email) = 'ekene.okoli@lagoonhospitals.com';
