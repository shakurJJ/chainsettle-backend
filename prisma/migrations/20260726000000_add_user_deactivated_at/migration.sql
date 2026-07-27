-- AlterTable: add deactivatedAt to users (soft account deactivation)
ALTER TABLE "users" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
