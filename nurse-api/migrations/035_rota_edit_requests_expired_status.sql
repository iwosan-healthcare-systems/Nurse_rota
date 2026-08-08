-- A rota_edit_requests row left 'Pending' when the T-17 deadline hits stayed
-- 'Pending' forever — jobs/auto-submit-draft.js only stamped revoked_at on it,
-- never touched status. Two problems: HR still saw an actionable-looking
-- Pending row (PATCH /:id would even still succeed, since it only checks
-- status = 'Pending', not revoked_at), and there was no clear signal in the
-- UI that the window had already closed. New 'Expired' status makes this
-- explicit and, since PATCH's WHERE clause requires status = 'Pending', a
-- row that's Expired can no longer be approved/declined at all — the head
-- nurse has to wait for the draft to be reverted and request access again.
ALTER TABLE rota_edit_requests DROP CONSTRAINT IF EXISTS rota_edit_requests_status_check;
ALTER TABLE rota_edit_requests ADD CONSTRAINT rota_edit_requests_status_check
  CHECK (status IN ('Pending', 'Approved', 'Declined', 'Expired'));
