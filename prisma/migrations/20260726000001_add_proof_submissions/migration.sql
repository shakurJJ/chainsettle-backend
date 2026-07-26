-- Migration: add_proof_submissions
-- Adds proof_submissions table for audit trail of proof uploads per milestone

CREATE TABLE "proof_submissions" (
    "id"           TEXT         NOT NULL,
    "milestoneId"  TEXT         NOT NULL,
    "ipfsCid"      TEXT         NOT NULL,
    "submittedBy"  TEXT         NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proof_submissions_pkey" PRIMARY KEY ("id")
);

-- Enable fast lookups by milestone
CREATE INDEX "proof_submissions_milestoneId_idx" ON "proof_submissions"("milestoneId");

-- Enable queries by submitter
CREATE INDEX "proof_submissions_submittedBy_idx" ON "proof_submissions"("submittedBy");

-- FK to milestones (cascade delete when milestone is removed)
ALTER TABLE "proof_submissions"
    ADD CONSTRAINT "proof_submissions_milestoneId_fkey"
    FOREIGN KEY ("milestoneId") REFERENCES "milestones"("id") ON DELETE CASCADE;
