-- Migration: add_comment_replies
-- Adds parentCommentId to shipment_comments to support threaded replies (#299).

ALTER TABLE "shipment_comments"
  ADD COLUMN "parentCommentId" TEXT;

CREATE INDEX "shipment_comments_parentCommentId_idx" ON "shipment_comments"("parentCommentId");

ALTER TABLE "shipment_comments"
  ADD CONSTRAINT "shipment_comments_parentCommentId_fkey"
  FOREIGN KEY ("parentCommentId") REFERENCES "shipment_comments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
