-- Migration: add permanent failure tracking and createdAt to webhook_deliveries
-- Adds: permanentlyFailedAt, createdAt, and updates the nextRetryAt index

ALTER TABLE "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "permanentlyFailedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Index for the scheduler: find deliveries due for retry
CREATE INDEX IF NOT EXISTS "webhook_deliveries_nextRetryAt_idx"
  ON "webhook_deliveries" ("nextRetryAt")
  WHERE "nextRetryAt" IS NOT NULL AND "permanentlyFailedAt" IS NULL;

-- Index for querying permanent failures
CREATE INDEX IF NOT EXISTS "webhook_deliveries_permanentlyFailedAt_idx"
  ON "webhook_deliveries" ("permanentlyFailedAt")
  WHERE "permanentlyFailedAt" IS NOT NULL;
