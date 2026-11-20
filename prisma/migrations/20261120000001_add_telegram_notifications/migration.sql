ALTER TABLE "notification_preferences"
    ADD COLUMN "telegramChatId" TEXT,
    ADD COLUMN "telegramLinkCodeHash" TEXT,
    ADD COLUMN "telegramLinkExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "notification_preferences_telegramChatId_key"
    ON "notification_preferences"("telegramChatId");

CREATE UNIQUE INDEX "notification_preferences_telegramLinkCodeHash_key"
    ON "notification_preferences"("telegramLinkCodeHash");
