-- Add leave type values that the frontend exposes but are absent from the enum.
-- IF NOT EXISTS is safe to re-run — Postgres silently skips values already present.
ALTER TYPE leave_type ADD VALUE IF NOT EXISTS 'Maternity';
ALTER TYPE leave_type ADD VALUE IF NOT EXISTS 'Public Holiday';
ALTER TYPE leave_type ADD VALUE IF NOT EXISTS 'Leave of Absence';
ALTER TYPE leave_type ADD VALUE IF NOT EXISTS 'Swap';
