-- #653: lock FX rates for reporting
ALTER TABLE "shipments" ADD COLUMN "fxRateAtCreation" DOUBLE PRECISION;
ALTER TABLE "milestones" ADD COLUMN "fxRateAtRelease" DOUBLE PRECISION;

-- #655: two-admin approval for ADMIN promotions
CREATE TYPE "RoleRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'EXPIRED');
CREATE TABLE "admin_role_requests" (
  "id" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "approvedBy" TEXT,
  "status" "RoleRequestStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_role_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_role_requests_targetUserId_status_idx" ON "admin_role_requests"("targetUserId", "status");
