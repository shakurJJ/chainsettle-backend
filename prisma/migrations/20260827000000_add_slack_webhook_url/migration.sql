-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "slackWebhookUrl" TEXT;
