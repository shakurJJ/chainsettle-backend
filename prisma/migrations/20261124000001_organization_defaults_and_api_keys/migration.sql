-- #646: organization default shipment settings
ALTER TABLE "organizations" ADD COLUMN "defaults" JSONB;

-- #647: organization-owned API keys
ALTER TABLE "api_keys" ADD COLUMN "organizationId" TEXT;
CREATE INDEX "api_keys_organizationId_idx" ON "api_keys"("organizationId");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
