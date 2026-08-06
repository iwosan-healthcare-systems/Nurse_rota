ALTER TABLE wards ADD COLUMN IF NOT EXISTS locum_eligible BOOLEAN NOT NULL DEFAULT false;

-- Seed with the previously hardcoded eligible-ward list so behavior doesn't change on deploy.
UPDATE wards SET locum_eligible = true
WHERE name IN ('ICU', 'NICU', 'SCBU', 'HDU', 'ICU & CathLab', 'IP Ward');
