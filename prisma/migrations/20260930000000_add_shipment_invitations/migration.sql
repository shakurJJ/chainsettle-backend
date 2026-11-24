-- Migration: add_shipment_invitations
-- Email invitations for counterparties without an account (#379)

CREATE TABLE "shipment_invitations" (
    "id"           TEXT         NOT NULL,
    "shipmentId"   TEXT,
    "templateId"   TEXT,
    "email"        TEXT         NOT NULL,
    "role"         "UserRole"   NOT NULL,
    "tokenHash"    TEXT         NOT NULL,
    "invitedById"  TEXT         NOT NULL,
    "acceptedById" TEXT,
    "acceptedAt"   TIMESTAMP(3),
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipment_invitations_tokenHash_key" ON "shipment_invitations"("tokenHash");

CREATE INDEX "shipment_invitations_invitedById_createdAt_idx" ON "shipment_invitations"("invitedById", "createdAt");

ALTER TABLE "shipment_invitations"
    ADD CONSTRAINT "shipment_invitations_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shipment_invitations"
    ADD CONSTRAINT "shipment_invitations_acceptedById_fkey"
    FOREIGN KEY ("acceptedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
