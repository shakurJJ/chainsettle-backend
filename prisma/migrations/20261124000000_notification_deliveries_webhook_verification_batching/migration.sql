-- #635 Notification delivery log
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_deliveries_notificationId_idx" ON "notification_deliveries"("notificationId");
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #637 Webhook verification (existing endpoints are migrated as verified/ACTIVE)
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE');
ALTER TABLE "webhook_endpoints" ADD COLUMN "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "webhook_endpoints" ADD COLUMN "verifiedAt" TIMESTAMP(3);
UPDATE "webhook_endpoints" SET "verifiedAt" = "createdAt";

-- #638 Webhook batching
ALTER TABLE "webhook_endpoints" ADD COLUMN "batchSize" INTEGER;
ALTER TABLE "webhook_endpoints" ADD COLUMN "batchWindowMs" INTEGER;
