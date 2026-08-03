-- Per-request, per-person edit access to a draft rota. A head_nurse must hold
-- an active grant (status='Approved' AND revoked_at IS NULL) to edit a draft
-- cell — see nurse-api/routes/shift-assignments.js. One table doubles as both
-- the request log and the active-grant state, mirroring how locum_requests
-- tracks its whole lifecycle without a separate "active" table.
CREATE TABLE rota_edit_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility           TEXT NOT NULL,
  ward               TEXT,              -- NULL for facility-wide role-group cards
  role_group         TEXT,              -- 'matron'|'head'|'porter'|'intern' when ward IS NULL
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  requested_by       UUID NOT NULL REFERENCES profiles(id),
  requested_by_name  TEXT,
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Declined')),
  reviewed_by        UUID REFERENCES profiles(id),
  reviewed_at        TIMESTAMPTZ,
  review_note        TEXT,
  revoked_at         TIMESTAMPTZ,
  revoke_reason      TEXT,              -- 'auto_closed_t17' | 'submitted' | 'manual_revoke'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ward IS NOT NULL OR role_group IS NOT NULL)
);

CREATE INDEX idx_rota_edit_requests_lookup
  ON rota_edit_requests (facility, ward, role_group, period_start, status);

-- Only one live (pending, or approved-and-not-yet-revoked) request per
-- requester + ward/group + period at a time.
CREATE UNIQUE INDEX uq_rota_edit_requests_active
  ON rota_edit_requests (requested_by, facility, COALESCE(ward, ''), COALESCE(role_group, ''), period_start)
  WHERE status = 'Pending' OR (status = 'Approved' AND revoked_at IS NULL);
