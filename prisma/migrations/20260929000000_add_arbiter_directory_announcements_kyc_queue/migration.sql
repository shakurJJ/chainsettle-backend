-- #398 public arbiter directory, #428 manual KYC review queue
ALTER TABLE "users" ADD COLUMN "kycSubmittedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "organization" TEXT;
ALTER TABLE "users" ADD COLUMN "listedInDirectory" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "arbiterAvailable" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "users_role_listedInDirectory_idx" ON "users"("role", "listedInDirectory");
CREATE INDEX "users_kycStatus_kycSubmittedAt_idx" ON "users"("kycStatus", "kycSubmittedAt");

-- Backfill: existing PENDING cases enter the queue ordered by their last update
UPDATE "users" SET "kycSubmittedAt" = "updatedAt" WHERE "kycStatus" = 'PENDING' AND "kycSubmittedAt" IS NULL;

-- #426 platform announcements
CREATE TYPE "AnnouncementSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" "AnnouncementSeverity" NOT NULL DEFAULT 'INFO',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "audienceRoles" "UserRole"[] DEFAULT ARRAY[]::"UserRole"[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "announcements_startsAt_endsAt_idx" ON "announcements"("startsAt", "endsAt");

CREATE TABLE "announcement_dismissals" (
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "announcement_dismissals_pkey" PRIMARY KEY ("announcementId", "userId")
);
CREATE INDEX "announcement_dismissals_userId_idx" ON "announcement_dismissals"("userId");
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
