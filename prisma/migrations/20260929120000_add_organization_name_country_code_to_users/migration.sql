-- AlterTable: add business identity fields to users
-- Both columns are nullable for backwards compatibility with existing rows.
ALTER TABLE "users"
  ADD COLUMN "organizationName" VARCHAR(200),
  ADD COLUMN "countryCode"      CHAR(2);
