-- Tracks who last edited a shift_assignments row, mirroring the existing
-- created_by column, plus a human-readable name for both so system-generated
-- rows (cron auto-generate/submit/publish) can carry a readable label
-- instead of a bare NULL that's indistinguishable from "unknown".
ALTER TABLE shift_assignments
  ADD COLUMN created_by_name TEXT,
  ADD COLUMN updated_by      UUID,
  ADD COLUMN updated_by_name TEXT;

-- Backfill: recover created_by_name for existing rows that already have a
-- created_by UUID (join to profiles). Rows where created_by is already NULL
-- can't be attributed retroactively — no record exists of whether that was
-- a pre-tracking manual edit or an auto-generated cell — so they're labeled
-- as unknown rather than guessed. updated_by/updated_by_name have no
-- backfill: nothing recorded who last touched a cell before this migration,
-- so they simply start NULL for existing rows.
UPDATE shift_assignments sa
   SET created_by_name = p.full_name
  FROM profiles p
 WHERE sa.created_by = p.id
   AND sa.created_by_name IS NULL;

UPDATE shift_assignments
   SET created_by_name = 'Unknown (pre-tracking)'
 WHERE created_by IS NULL
   AND created_by_name IS NULL;
