-- Migration: add_shipment_comment_created_notification_type
-- Adds SHIPMENT_COMMENT_CREATED to the NotificationType enum for the
-- shipment.comment.created webhook event (#537)

ALTER TYPE "NotificationType" ADD VALUE 'SHIPMENT_COMMENT_CREATED';
