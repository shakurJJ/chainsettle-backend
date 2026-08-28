-- Migration: add_saved_filters
-- Named, reusable GET /shipments filter presets, private per user

CREATE TABLE "saved_filters" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "filter"    JSONB        NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- Names are unique per user, not globally: two users may both have "Overdue"
CREATE UNIQUE INDEX "saved_filters_userId_name_key" ON "saved_filters"("userId", "name");

CREATE INDEX "saved_filters_userId_idx" ON "saved_filters"("userId");

ALTER TABLE "saved_filters"
    ADD CONSTRAINT "saved_filters_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
