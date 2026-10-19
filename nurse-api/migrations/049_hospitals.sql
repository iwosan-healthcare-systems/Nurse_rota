-- Hospitals (tenants). Every hospital's facilities, staff, rota, leave,
-- attendance, locum, notifications, audit and settings are separated by
-- hospital_id and enforced with row-level security.
--
-- Request context: the API sets app.hospital_id (the hospital being worked in)
-- and app.user_id on every pooled connection. '*' (or unset, as for psql and
-- migrations) means platform scope: every hospital is visible. New rows default
-- to the current hospital; in platform scope they must name hospital_id.
-- Future migrations inserting tenant rows must therefore set hospital_id.

CREATE TABLE hospitals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The existing deployment is Iwosan Lagoon Hospital; reuse the scheduling
-- organization id so scheduling data maps to it directly.
INSERT INTO hospitals (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Iwosan Lagoon Hospital');
UPDATE scheduling_organizations SET name = 'Iwosan Lagoon Hospital'
WHERE id = '00000000-0000-4000-8000-000000000001';
INSERT INTO scheduling_organizations (id, name)
SELECT id, name FROM hospitals ON CONFLICT (id) DO NOTHING;
ALTER TABLE scheduling_organizations
  ADD CONSTRAINT scheduling_organizations_hospital_fkey FOREIGN KEY (id) REFERENCES hospitals(id);
CREATE FUNCTION hospitals_scheduling_organization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO scheduling_organizations (id, name) VALUES (NEW.id, NEW.name)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
  RETURN NEW;
END $$;
CREATE TRIGGER hospitals_scheduling_organization AFTER INSERT OR UPDATE OF name ON hospitals
FOR EACH ROW EXECUTE FUNCTION hospitals_scheduling_organization();

-- Platform administrators may enter and create any hospital.
ALTER TABLE profiles ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Which hospitals a (non-super-admin) user may work in. Roles are global.
CREATE TABLE hospital_memberships (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  -- Deferred so an account created inside a hospital can record its membership
  -- before the profile row exists (see profiles_join_current_hospital).
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  granted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, user_id)
);
CREATE INDEX hospital_memberships_user_idx ON hospital_memberships(user_id);
INSERT INTO hospital_memberships (hospital_id, user_id)
SELECT '00000000-0000-4000-8000-000000000001', id FROM profiles;

CREATE FUNCTION app_current_hospital() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting('app.hospital_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN current_setting('app.hospital_id', true)::uuid
  END
$$;
CREATE FUNCTION app_platform_scope() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.hospital_id', true), '') IN ('', '*')
$$;
CREATE FUNCTION app_hospital_visible(h UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT app_platform_scope() OR h = app_current_hospital()
$$;

-- Tenant tables: backfill to Lagoon, default to the current hospital, enforce.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'nurses', 'wards', 'shift_assignments', 'shift_logs', 'leave_requests',
    'leave_entitlement_adjustments', 'leave_entitlement_overrides', 'locum_requests',
    'locum_invites', 'notification_state', 'audit_logs', 'nurse_period_hours',
    'rota_edit_requests', 'rota_transitions', 'portal_settings', 'user_capability_overrides'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN hospital_id UUID REFERENCES hospitals(id)', t);
    EXECUTE format('UPDATE %I SET hospital_id = %L', t, '00000000-0000-4000-8000-000000000001');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN hospital_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN hospital_id SET DEFAULT app_current_hospital()', t);
    EXECUTE format('CREATE INDEX %I ON %I (hospital_id)', t || '_hospital_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY hospital_isolation ON %I USING (app_hospital_visible(hospital_id)) WITH CHECK (app_hospital_visible(hospital_id))',
      t);
  END LOOP;
END $$;

-- Uniqueness that was global becomes per hospital.
ALTER TABLE portal_settings DROP CONSTRAINT portal_settings_pkey;
ALTER TABLE portal_settings ADD PRIMARY KEY (hospital_id, key);
DROP INDEX nurses_employee_id_unique;
CREATE UNIQUE INDEX nurses_employee_id_unique ON nurses (hospital_id, employee_id)
  WHERE employee_id IS NOT NULL;
DROP INDEX uq_leave_entitlement_overrides_role;
CREATE UNIQUE INDEX uq_leave_entitlement_overrides_role ON leave_entitlement_overrides (hospital_id, role, type)
  WHERE scope = 'role';
DROP INDEX uq_user_capability_overrides_user_key;
CREATE UNIQUE INDEX uq_user_capability_overrides_user_key
  ON user_capability_overrides (hospital_id, user_id, capability_key);
DROP INDEX uq_rota_edit_requests_active;
CREATE UNIQUE INDEX uq_rota_edit_requests_active ON rota_edit_requests
  (hospital_id, facility, COALESCE(ward, ''), COALESCE(role_group, ''), period_start)
  WHERE status = 'Pending' OR (status = 'Approved' AND revoked_at IS NULL);

-- Scheduling: organizations are hospitals; facility names are unique per hospital.
ALTER TABLE scheduling_facilities DROP CONSTRAINT scheduling_facilities_legacy_facility_key;
ALTER TABLE scheduling_facilities
  ADD CONSTRAINT scheduling_facilities_legacy_facility_key UNIQUE (organization_id, legacy_facility);
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduling_facilities', 'scheduling_config_versions', 'scheduling_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN organization_id SET DEFAULT app_current_hospital()', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY hospital_isolation ON %I USING (app_hospital_visible(organization_id)) WITH CHECK (app_hospital_visible(organization_id))',
      t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['scheduling_policy_events', 'scheduling_facility_access'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY hospital_isolation ON %I USING (app_platform_scope() OR facility_id IN (SELECT id FROM scheduling_facilities)) WITH CHECK (app_platform_scope() OR facility_id IN (SELECT id FROM scheduling_facilities))',
      t);
  END LOOP;
END $$;

-- Users: inside a hospital only its members (and yourself) are visible, so staff
-- lists, role lookups and name matches never reach another hospital's accounts.
-- VOLATILE so the membership a creating INSERT just added is visible to its RETURNING check.
CREATE FUNCTION app_user_visible(u UUID) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public AS $$
  SELECT app_platform_scope()
    OR u::text = current_setting('app.user_id', true)
    OR EXISTS (SELECT 1 FROM hospital_memberships m
               WHERE m.user_id = u AND m.hospital_id = app_current_hospital())
$$;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY hospital_members ON profiles USING (app_user_visible(id)) WITH CHECK (true);
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY hospital_members ON user_roles USING (app_user_visible(user_id)) WITH CHECK (true);

-- Accounts created while working in a hospital join that hospital immediately,
-- so the creating request can read the new profile back.
CREATE FUNCTION profiles_join_current_hospital() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_current_hospital() IS NOT NULL THEN
    INSERT INTO hospital_memberships (hospital_id, user_id, granted_by)
    VALUES (app_current_hospital(), NEW.id, NULLIF(current_setting('app.user_id', true), '')::uuid)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profiles_join_current_hospital BEFORE INSERT ON profiles
FOR EACH ROW EXECUTE FUNCTION profiles_join_current_hospital();

-- Lagoon's built-in sites and leave caps become its own explicit settings (only
-- where it never saved them), so no hospital ever falls back to Lagoon's values.
INSERT INTO portal_settings (hospital_id, key, value) VALUES
  ('00000000-0000-4000-8000-000000000001', 'gps_settings', '{
    "radius_m": 1000,
    "facilities": {
      "Ikeja": [
        {"lat": 6.6044, "lng": 3.3458, "label": "Ikeja — 91 Obafemi Awolowo Way"},
        {"lat": 6.6153343, "lng": 3.3458773, "label": "Ikeja — 91 Adeniyi Jones, Ogba"}
      ],
      "Ikoyi": [{"lat": 6.4531, "lng": 3.4329, "label": "Ikoyi — 17B Bourdillon Road"}],
      "Ligali": [{"lat": 6.428565, "lng": 3.44097, "label": "Ligali — 3B Ligali Ayorinde Street"}]
    }
  }'),
  ('00000000-0000-4000-8000-000000000001', 'leave_entitlement_defaults',
   '{"Annual": 15, "Study Leave": 5, "Compassionate Leave": 5, "Maternity": 84, "Sick": 12}')
ON CONFLICT (hospital_id, key) DO NOTHING;
