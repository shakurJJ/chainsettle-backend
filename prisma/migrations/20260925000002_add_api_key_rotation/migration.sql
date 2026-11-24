-- Migration: add rotation fields to api_keys
-- Issue #367: Add POST /auth/api-keys/:id/rotate
--
-- rotatedFromId     — links the new key back to the key it replaced (audit trail)
-- gracePeriodEndsAt — when set, the revoked predecessor key remains valid until this timestamp

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "rotatedFromId"     TEXT,
  ADD COLUMN IF NOT EXISTS "gracePeriodEndsAt" TIMESTAMPTZ;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "api_keys_gracePeriodEndsAt_idx"
  ON "api_keys" ("gracePeriodEndsAt")
  WHERE "gracePeriodEndsAt" IS NOT NULL;
