-- Capture the rota stage (no_rota / draft / published) at the moment a leave
-- request is created so the reports page can categorise requests by when they
-- were submitted relative to the rota workflow.
-- Existing rows get NULL, displayed as "–" in the UI.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS rota_stage_at_request TEXT;
