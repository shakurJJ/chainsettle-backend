ALTER TABLE "notifications" ADD COLUMN "deliverAfter" TIMESTAMP(3);
CREATE INDEX "notifications_deliverAfter_idx" ON "notifications"("deliverAfter");