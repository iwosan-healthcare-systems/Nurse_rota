-- Overrides the DEFAULT cap itself (lib/leave-entitlements.js's
-- LEAVE_ENTITLEMENTS), not usage — a completely different concept from
-- leave_entitlement_adjustments (033), which credits days already taken.
-- Two scopes, resolved individual-first: a specific nurse's override beats
-- their job role's override, which beats the system default. Admin only —
-- unlike adjustments (hr_admin can also record those), changing what
-- someone is entitled to in the first place is kept to admin.
--
-- Unlike leave_entitlement_adjustments, this is a CONFIG table, not a log —
-- it supports real UPDATE/DELETE (revert to default), since "what someone
-- is currently entitled to" is a setting, not a historical event that needs
-- an immutable trail the way "days already used" does.
CREATE TABLE leave_entitlement_overrides (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            TEXT NOT NULL CHECK (scope IN ('individual', 'role')),
  nurse_id         UUID REFERENCES nurses(id) ON DELETE CASCADE,  -- set only when scope='individual'
  role             TEXT,                                          -- set only when scope='role'
  type             TEXT NOT NULL,   -- one of LEAVE_ENTITLEMENTS' tracked keys (Annual, Sick, ...)
  days             NUMERIC NOT NULL CHECK (days >= 0),
  created_by       UUID REFERENCES profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'individual' AND nurse_id IS NOT NULL AND role IS NULL) OR
    (scope = 'role' AND role IS NOT NULL AND nurse_id IS NULL)
  )
);

-- One override per nurse/type, and separately one per role/type — an UPSERT
-- target so re-saving the same individual/role+type from the frontend
-- updates the existing row rather than creating a duplicate.
CREATE UNIQUE INDEX uq_leave_entitlement_overrides_individual
  ON leave_entitlement_overrides (nurse_id, type) WHERE scope = 'individual';
CREATE UNIQUE INDEX uq_leave_entitlement_overrides_role
  ON leave_entitlement_overrides (role, type) WHERE scope = 'role';
