-- uq_rota_edit_requests_active (025) scoped uniqueness to
-- (requested_by, facility, ward/role_group, period_start) — which only
-- stopped the SAME head_nurse from filing a duplicate request. It never
-- stopped a DIFFERENT head_nurse from also raising a live request for the
-- same ward/period at the same time. That's a real problem: if two people
-- have a live request for the same ward and HR declines one (which
-- auto-submits the draft as-is), the other person's still-pending request
-- is now moot but left dangling, and the ward that just got force-submitted
-- may not reflect the changes the SECOND requester was hoping to make.
--
-- Re-scope the lock to the ward/group + period itself, dropping
-- requested_by entirely — only one live (pending, or approved-and-not-yet-
-- revoked) edit-access request is allowed per ward/period at a time,
-- regardless of who raises it.
DROP INDEX IF EXISTS uq_rota_edit_requests_active;

CREATE UNIQUE INDEX uq_rota_edit_requests_active
  ON rota_edit_requests (facility, COALESCE(ward, ''), COALESCE(role_group, ''), period_start)
  WHERE status = 'Pending' OR (status = 'Approved' AND revoked_at IS NULL);
