-- Migration: add_expected_delivery_at_and_delivery_delayed
-- Adds DELIVERY_DELAYED to the NotificationType enum and expectedDeliveryAt to the shipments table.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'DELIVERY_DELAYED';

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN "expectedDeliveryAt" TIMESTAMP(3);
