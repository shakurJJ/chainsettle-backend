CREATE TABLE "device_tokens" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "userId"    UUID         NOT NULL,
  "token"     TEXT         NOT NULL,
  "platform"  TEXT         NOT NULL DEFAULT 'fcm',
  "createdAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_tokens_token_key" UNIQUE ("token")
);

CREATE INDEX "device_tokens_userId_idx" ON "device_tokens"("userId");

ALTER TABLE "device_tokens"
  ADD CONSTRAINT "device_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
