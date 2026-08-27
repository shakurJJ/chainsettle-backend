-- Migration: add_shipment_favorites
-- Per-user private favorites for quick shipment access

CREATE TABLE "shipment_favorites" (
    "id"         TEXT         NOT NULL,
    "shipmentId" TEXT         NOT NULL,
    "userId"     TEXT         NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_favorites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipment_favorites_shipmentId_userId_key"
    ON "shipment_favorites"("shipmentId", "userId");

CREATE INDEX "shipment_favorites_userId_idx" ON "shipment_favorites"("userId");

ALTER TABLE "shipment_favorites"
    ADD CONSTRAINT "shipment_favorites_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shipment_favorites"
    ADD CONSTRAINT "shipment_favorites_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
