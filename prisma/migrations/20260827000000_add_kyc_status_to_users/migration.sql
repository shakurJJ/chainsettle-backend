-- Migration: add_kyc_status_to_users
-- Adds a KYC/AML verification status to users so higher-value shipments can
-- require both parties to be verified before creation (#233).

CREATE TYPE "KycStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

ALTER TABLE "users"
  ADD COLUMN "kycStatus" "KycStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "kycReference" TEXT;
