-- New leave_requests outcome distinct from 'Rejected': a request that was
-- never decided by the time the rota auto-generated for its period, so the
-- system resolved it automatically rather than blocking generation
-- indefinitely (see jobs/auto-generate-rota.js). Mirrors the same
-- Declined-vs-Expired distinction already established for locum requests.
ALTER TYPE leave_status ADD VALUE IF NOT EXISTS 'Expired';
