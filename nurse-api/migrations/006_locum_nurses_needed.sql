ALTER TABLE locum_requests ADD COLUMN IF NOT EXISTS nurses_needed integer NOT NULL DEFAULT 1;
