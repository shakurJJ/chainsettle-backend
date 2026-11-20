-- Migration: add_shipment_line_items
-- Adds the shipment_line_items table for structured goods modelling.

CREATE TABLE "shipment_line_items" (
  "id"          TEXT         NOT NULL,
  "shipmentId"  TEXT         NOT NULL,
  "sku"         VARCHAR(100),
  "name"        VARCHAR(255) NOT NULL,
  "quantity"    DECIMAL(18, 6) NOT NULL,
  "unit"        VARCHAR(50)  NOT NULL DEFAULT 'unit',
  "unitPrice"   DECIMAL(18, 6) NOT NULL,
  "currency"    VARCHAR(10)  NOT NULL DEFAULT 'USDC',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "shipment_line_items_pkey" PRIMARY KEY ("id")
);

-- FK to parent shipment; cascade deletes keep orphans impossible.
ALTER TABLE "shipment_line_items"
  ADD CONSTRAINT "shipment_line_items_shipmentId_fkey"
  FOREIGN KEY ("shipmentId")
  REFERENCES "shipments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Index for all look-ups scoped to a single shipment.
CREATE INDEX "shipment_line_items_shipmentId_idx"
  ON "shipment_line_items"("shipmentId");
