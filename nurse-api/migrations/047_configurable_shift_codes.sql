-- Hospital-defined shift codes: rota and attendance columns move from the fixed
-- shift_code enum to text validated with the same format the scheduling
-- configuration enforces. Meaning, times and credits for a code come from the
-- immutable run snapshot, not this column. The enum type is kept so older casts of legacy codes stay valid.
ALTER TABLE shift_assignments
  ALTER COLUMN shift TYPE TEXT USING shift::text,
  ALTER COLUMN pre_leave_shift TYPE TEXT USING pre_leave_shift::text;
ALTER TABLE shift_assignments
  ADD CONSTRAINT shift_assignments_shift_code CHECK (shift ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  ADD CONSTRAINT shift_assignments_pre_leave_shift_code CHECK (
    pre_leave_shift IS NULL OR pre_leave_shift ~ '^[A-Z][A-Z0-9_]{0,15}$'
  );
ALTER TABLE shift_logs ALTER COLUMN shift_type TYPE TEXT USING shift_type::text;
ALTER TABLE shift_logs
  ADD CONSTRAINT shift_logs_shift_type_code CHECK (shift_type ~ '^[A-Z][A-Z0-9_]{0,15}$');
