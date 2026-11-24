-- CreateTable
CREATE TABLE "web_push_subscriptions" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "endpoint"  TEXT         NOT NULL,
    "p256dh"    TEXT         NOT NULL,
    "auth"      TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_key" ON "web_push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "web_push_subscriptions_userId_idx" ON "web_push_subscriptions"("userId");

-- AddForeignKey
ALTER TABLE "web_push_subscriptions"
    ADD CONSTRAINT "web_push_subscriptions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
