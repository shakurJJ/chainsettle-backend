-- Migration: add scopes to api_keys
-- Issue #368: Add scopes to API keys (read-only vs read-write)
--
-- Existing rows get the full ["read","write"] set so no behaviour changes
-- for keys created before this migration.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "scopes" TEXT[] NOT NULL DEFAULT ARRAY['read','write'];
