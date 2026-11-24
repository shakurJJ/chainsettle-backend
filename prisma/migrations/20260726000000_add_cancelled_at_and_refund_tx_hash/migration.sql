-- Migration: add_cancelled_at_and_refund_tx_hash
-- Adds cancelledAt timestamp and refundTxHash to shipments for refund detail endpoint

-- AlterTable: shipments
-- Add cancelledAt (nullable DateTime, set when shipment is cancelled)
ALTER TABLE "shipments"
    ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- Add refundTxHash (nullable String, tx hash of the cancellation/refund)
ALTER TABLE "shipments"
    ADD COLUMN "refundTxHash" TEXT;
