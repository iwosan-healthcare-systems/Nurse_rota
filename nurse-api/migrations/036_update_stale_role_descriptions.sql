-- 022_dynamic_roles.sql seeded cno/chief_matron descriptions describing the
-- OLD rota pipeline (Chief Matron approves, then CNO approves) — retired by
-- 026_seed_rota_hr_capabilities.sql in favour of a single HR approval step
-- (CNO now only publishes; Chief Matron only edits, never approves). The
-- descriptions were never updated to match, so the role picker/admin UI kept
-- describing a process that no longer exists. Targeted UPDATE, not a re-seed,
-- so it leaves label/capabilities and any other admin edits untouched.
UPDATE roles SET description = 'Publish rotas, manage shift switches and oversee all facilities'
  WHERE key = 'cno' AND description = 'Approve rotas, manage shift switches and oversee all facilities';
UPDATE roles SET description = 'Edit rotas, manage leave and ward staffing'
  WHERE key = 'chief_matron' AND description = 'Review and approve rotas, manage leave and ward staffing';
