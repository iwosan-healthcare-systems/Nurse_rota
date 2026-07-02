-- Add employee_id column to nurses table.
-- Idempotent: safe to run multiple times.
ALTER TABLE nurses ADD COLUMN IF NOT EXISTS employee_id TEXT;

-- Unique index allows multiple NULLs (i.e. nurses without an assigned ID).
CREATE UNIQUE INDEX IF NOT EXISTS nurses_employee_id_unique
  ON nurses (employee_id)
  WHERE employee_id IS NOT NULL;
