-- Migration: add_proof_rejected_notification_type
-- Adds PROOF_REJECTED to the NotificationType enum for the proof rejection flow

ALTER TYPE "NotificationType" ADD VALUE 'PROOF_REJECTED';
