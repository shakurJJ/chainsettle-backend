-- #392 milestone checklists, #393 deadline extension requests

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DEADLINE_EXTENSION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DEADLINE_EXTENSION_DECIDED';

CREATE TYPE "ExtensionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

CREATE TABLE "milestone_checklist_items" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "milestone_checklist_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "milestone_checklist_items_milestoneId_idx" ON "milestone_checklist_items"("milestoneId");
ALTER TABLE "milestone_checklist_items" ADD CONSTRAINT "milestone_checklist_items_milestoneId_fkey"
    FOREIGN KEY ("milestoneId") REFERENCES "milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "deadline_extension_requests" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "proposedDueAt" TIMESTAMP(3) NOT NULL,
    "previousDueAt" TIMESTAMP(3),
    "reason" VARCHAR(1000) NOT NULL,
    "status" "ExtensionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deadline_extension_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "deadline_extension_requests_milestoneId_status_idx" ON "deadline_extension_requests"("milestoneId", "status");
-- Enforce at most one PENDING request per milestone at the database level.
CREATE UNIQUE INDEX "deadline_extension_requests_one_pending_per_milestone"
    ON "deadline_extension_requests"("milestoneId") WHERE "status" = 'PENDING';
ALTER TABLE "deadline_extension_requests" ADD CONSTRAINT "deadline_extension_requests_milestoneId_fkey"
    FOREIGN KEY ("milestoneId") REFERENCES "milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
