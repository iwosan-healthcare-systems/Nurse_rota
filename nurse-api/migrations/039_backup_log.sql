-- Visibility into the daily pg_dump cron on NRota-DB (set up manually,
-- outside this repo — /var/backups/nrota-db/pg_backup.sh). Previously the
-- only way to know if a backup succeeded, or was even still running, was to
-- SSH into NRota-DB and look at the directory. The backup script writes one
-- row here after each attempt (success or failure), regardless of which of
-- the two databases (nurse_rota / nurse_rota_uat) it just dumped — always
-- into THIS database, since that's the one the app's System Settings page
-- actually queries.
CREATE TABLE backup_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database    TEXT NOT NULL,
  filename    TEXT,
  size_bytes  BIGINT,
  status      TEXT NOT NULL DEFAULT 'success',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backup_log_created_at ON backup_log (created_at DESC);
