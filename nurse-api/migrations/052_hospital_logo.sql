-- Each hospital may have its own logo, shown to its staff after sign-in. Stored
-- inline as a small image data URL (the browser downsizes photos before upload);
-- hospitals without one keep the application's general logo.
ALTER TABLE hospitals ADD COLUMN logo TEXT
  CHECK (
    logo IS NULL OR (
      length(logo) <= 550000
      AND logo ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$'
    )
  );
ALTER TABLE hospitals ADD COLUMN logo_updated_at TIMESTAMPTZ;
