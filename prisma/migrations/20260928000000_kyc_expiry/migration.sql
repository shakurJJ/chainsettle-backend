-- #429: KYC expiry and re-verification reminders
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'KYC_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'KYC_EXPIRED';

ALTER TABLE "users"
  ADD COLUMN "kycVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "kycExpiresAt" TIMESTAMP(3),
  ADD COLUMN "kycReminder30dSentAt" TIMESTAMP(3),
  ADD COLUMN "kycReminder7dSentAt" TIMESTAMP(3);

CREATE INDEX "users_kycExpiresAt_idx" ON "users"("kycExpiresAt");
