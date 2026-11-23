-- Migration: add_proof_rejection_reason
-- Adds the ProofRejectionReason enum and two nullable columns to proof_submissions
-- so that every rejection carries a structured reason code (and an optional note
-- that is required when the code is OTHER).

CREATE TYPE "ProofRejectionReason" AS ENUM (
  'ILLEGIBLE',
  'WRONG_DOCUMENT',
  'INCOMPLETE',
  'MISMATCHED_QUANTITY',
  'OTHER'
);

ALTER TABLE "proof_submissions"
  ADD COLUMN "rejectionCode" "ProofRejectionReason",
  ADD COLUMN "rejectionNote" TEXT;

CREATE INDEX "proof_submissions_rejectionCode_idx"
  ON "proof_submissions" ("rejectionCode");
