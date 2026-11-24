CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "defaultRole" "UserRole",
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contacts_ownerId_stellarAddress_key" ON "contacts"("ownerId", "stellarAddress");
CREATE INDEX "contacts_ownerId_label_idx" ON "contacts"("ownerId", "label");

ALTER TABLE "contacts" ADD CONSTRAINT "contacts_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;