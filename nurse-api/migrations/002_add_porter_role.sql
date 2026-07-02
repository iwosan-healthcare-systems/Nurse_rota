-- Add porter system role to the app_role enum.
-- Idempotent: safe to run multiple times (ADD VALUE IF NOT EXISTS).
ALTER TYPE app_role ADD VALUE IF NOT EXISTS 'porter';
