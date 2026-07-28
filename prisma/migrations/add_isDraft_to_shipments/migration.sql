-- Migration: add_isDraft_to_shipments
-- Issue #162: Add isDraft column to support CSV bulk import of draft shipments

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN shipments.is_draft IS 'True when created via CSV bulk import; no on-chain backing yet';
