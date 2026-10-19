-- Additive foundation only. Does not alter schedules, shift enums or active settings.
-- The deployment runner wraps this file in a transaction; do not add BEGIN/COMMIT.
CREATE TABLE scheduling_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduling_facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES scheduling_organizations(id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  legacy_facility TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id)
);

-- Explicit grants: application roles/capabilities alone do not grant facility access.
CREATE TABLE scheduling_facility_access (
  facility_id UUID NOT NULL REFERENCES scheduling_facilities(id),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (facility_id, user_id)
);
CREATE INDEX scheduling_access_user_idx ON scheduling_facility_access(user_id);

-- Atomic, schema-versioned draft documents. Child entities are not live scheduling
-- definitions yet. JSON references are validated by the API against this facility.
CREATE TABLE scheduling_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'archived')),
  configuration JSONB NOT NULL CHECK (
    jsonb_typeof(configuration) = 'object'
    AND configuration @> '{"schemaVersion": 1}'::jsonb
  ),
  created_by UUID NOT NULL REFERENCES profiles(id),
  updated_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, facility_id)
    REFERENCES scheduling_facilities(organization_id, id),
  UNIQUE (facility_id, version)
);

CREATE FUNCTION protect_scheduling_config_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Scheduling versions must be retained';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Archived scheduling versions are immutable';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.facility_id, NEW.version, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.facility_id, OLD.version, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Scheduling version identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Scheduling revision must advance by one';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduling_config_version_guard BEFORE UPDATE OR DELETE
  ON scheduling_config_versions FOR EACH ROW EXECUTE FUNCTION protect_scheduling_config_version();

-- Existing deployment is one customer. This does not claim full application tenancy.
INSERT INTO scheduling_organizations (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Existing hospital organization');
INSERT INTO scheduling_facilities (organization_id, name, legacy_facility)
SELECT '00000000-0000-4000-8000-000000000001'::uuid, facility, facility
FROM (
  SELECT facility FROM wards UNION SELECT facility FROM nurses
) locations WHERE facility IS NOT NULL AND btrim(facility) <> '';

-- Admin/CNO can configure existing facilities. Other users retain only their linked
-- facility scope and still need the new capability. Never match profiles by name.
INSERT INTO scheduling_facility_access (facility_id, user_id)
SELECT f.id, ur.user_id FROM scheduling_facilities f
CROSS JOIN user_roles ur WHERE ur.role::text IN ('admin', 'cno')
UNION
SELECT f.id, n.profile_id FROM scheduling_facilities f
JOIN nurses n ON n.facility = f.legacy_facility WHERE n.profile_id IS NOT NULL;

-- Add missing capability entries without replacing administrator customizations.
INSERT INTO portal_settings (key, value) VALUES ('capabilities', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;
UPDATE portal_settings SET value = value || (
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
  FROM jsonb_array_elements('[
    {"key":"view_scheduling_configuration","roles":["admin","cno","chief_matron"]},
    {"key":"manage_scheduling_configuration","roles":["admin","cno"]}
  ]'::jsonb) entry
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(portal_settings.value) existing
    WHERE existing->>'key' = entry->>'key'
  )
) WHERE key = 'capabilities' AND jsonb_typeof(value) = 'array';
