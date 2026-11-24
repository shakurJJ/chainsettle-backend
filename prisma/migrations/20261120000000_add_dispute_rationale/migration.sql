-- Store the immutable written decision rationale for resolved disputes
CREATE TABLE "dispute_rationale" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "writtenBy" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "ipfsCid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispute_rationale_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dispute_rationale_milestoneId_key"
    ON "dispute_rationale"("milestoneId");

CREATE INDEX "dispute_rationale_writtenBy_idx"
    ON "dispute_rationale"("writtenBy");

ALTER TABLE "dispute_rationale"
    ADD CONSTRAINT "dispute_rationale_milestoneId_fkey"
    FOREIGN KEY ("milestoneId") REFERENCES "milestones"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
