-- The CNO review step (formerly HR's) has been called 'hr_approved' in the
-- assignment_status enum since migration 024, even though the app has long
-- since moved to CNO as the actual approver — every label already says "CNO
-- review step" / "Approve Rota (CNO review step)", only the underlying
-- status literal was stuck on the old name. Renaming the enum value in place
-- (not adding a new one) means every existing row just reads correctly
-- afterward — no data UPDATE needed, no window where two names mean the
-- same thing.
ALTER TYPE assignment_status RENAME VALUE 'hr_approved' TO 'cno_approved';
