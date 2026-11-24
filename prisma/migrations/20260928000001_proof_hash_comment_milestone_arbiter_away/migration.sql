-- #394: SHA-256 + size for milestone proof uploads
ALTER TABLE "proof_submissions" ADD COLUMN "sha256" TEXT;
ALTER TABLE "proof_submissions" ADD COLUMN "fileSize" INTEGER;
CREATE INDEX "proof_submissions_sha256_idx" ON "proof_submissions"("sha256");

-- #395: index for upcoming-milestone queries
CREATE INDEX "milestones_dueAt_idx" ON "milestones"("dueAt");

-- #396: milestone-scoped comments
ALTER TABLE "shipment_comments" ADD COLUMN "milestoneIndex" INTEGER;
CREATE INDEX "shipment_comments_shipmentId_milestoneIndex_idx" ON "shipment_comments"("shipmentId", "milestoneIndex");

-- #397: arbiter availability
ALTER TABLE "users" ADD COLUMN "arbiterAwayUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "awayMessage" VARCHAR(500);
