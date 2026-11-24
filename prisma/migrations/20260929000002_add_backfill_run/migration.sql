-- Migration: add_backfill_run
-- Adds the backfill_runs table and BackfillStatus enum to track admin-initiated
-- ledger-range event backfill jobs.

CREATE TYPE "BackfillStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "backfill_runs" (
    "id"             TEXT          NOT NULL,
    "status"         "BackfillStatus" NOT NULL DEFAULT 'PENDING',
    "fromLedger"     INTEGER       NOT NULL,
    "toLedger"       INTEGER       NOT NULL,
    "processedCount" INTEGER       NOT NULL DEFAULT 0,
    "errorCount"     INTEGER       NOT NULL DEFAULT 0,
    "currentLedger"  INTEGER,
    "errorSummary"   JSONB,
    "startedAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"    TIMESTAMP(3),
    "initiatedBy"    TEXT,

    CONSTRAINT "backfill_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backfill_runs_status_idx"     ON "backfill_runs"("status");
CREATE INDEX "backfill_runs_startedAt_idx"  ON "backfill_runs"("startedAt");
