-- New rota pipeline: draft -> submitted -> hr_approved -> published.
-- Chief Matron and CNO's separate approval steps (approved_chief, approved_cno)
-- are retired — left in the enum unused (Postgres can't cheaply drop enum
-- values) rather than removed, same pattern as leaving `ward_manager` in the
-- roles table after the dynamic-roles migration.
ALTER TYPE assignment_status ADD VALUE IF NOT EXISTS 'hr_approved';
