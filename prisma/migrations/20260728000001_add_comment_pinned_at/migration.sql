-- Migration: add_comment_pinned_at
-- Adds pinnedAt to shipment_comments to support pinning important comments (#189).
-- Adds COMMENT_MENTION to the NotificationType enum for @mention notifications (#190).

ALTER TABLE "shipment_comments"
  ADD COLUMN "pinnedAt" TIMESTAMP(3);

-- Add COMMENT_MENTION to the NotificationType enum
ALTER TYPE "NotificationType" ADD VALUE 'COMMENT_MENTION';
