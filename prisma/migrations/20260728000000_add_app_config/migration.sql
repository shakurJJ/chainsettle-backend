-- Migration: add_app_config
-- Adds a generic key/value AppConfig table so ops can adjust runtime-configurable
-- settings (e.g. IPFS upload limits) without a redeploy.

CREATE TABLE "app_config" (
    "key"       TEXT         NOT NULL,
    "value"     JSONB        NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);
