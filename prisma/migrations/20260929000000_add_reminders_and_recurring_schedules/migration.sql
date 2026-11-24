-- CreateEnum
CREATE TYPE "RecurringInterval" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "shipment_reminders" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "message" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipment_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_schedules" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "interval" "RecurringInterval" NOT NULL,
    "totalAmount" BIGINT NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "recurring_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_reminders_shipmentId_userId_idx" ON "shipment_reminders"("shipmentId", "userId");
CREATE INDEX "shipment_reminders_sentAt_remindAt_idx" ON "shipment_reminders"("sentAt", "remindAt");
CREATE INDEX "recurring_schedules_ownerId_idx" ON "recurring_schedules"("ownerId");
CREATE INDEX "recurring_schedules_templateId_idx" ON "recurring_schedules"("templateId");
CREATE INDEX "recurring_schedules_active_nextRunAt_idx" ON "recurring_schedules"("active", "nextRunAt");

-- AddForeignKey
ALTER TABLE "shipment_reminders" ADD CONSTRAINT "shipment_reminders_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shipment_reminders" ADD CONSTRAINT "shipment_reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "shipment_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
