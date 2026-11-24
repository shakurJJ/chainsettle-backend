-- Migration: add expiresAt and expiryWarningSentAt to api_keys
-- Issue #369: Add optional expiry (expiresAt) to API keys

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "expiryWarningSentAt" TIMESTAMP(3);

-- Index to support daily expiry-warning cron query (keys expiring in ~7 days,
-- warning not yet sent, not already revoked)
CREATE INDEX IF NOT EXISTS "api_keys_expiresAt_idx" ON "api_keys" ("expiresAt");
