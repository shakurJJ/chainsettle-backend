-- Add snoozedUntil to notifications
-- A null value means "not snoozed". When set to a future timestamp the notification
-- is excluded from the default GET /notifications list until that time passes, at
-- which point it reappears as unread (the read flag is never touched by snooze).
ALTER TABLE "notifications" ADD COLUMN "snoozedUntil" TIMESTAMP(3);

-- Index used by the WHERE filter:
--   snoozedUntil IS NULL OR snoozedUntil < now()
CREATE INDEX "notifications_snoozedUntil_idx" ON "notifications"("snoozedUntil");
