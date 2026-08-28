-- Migration: add_shipment_approvals
-- Multi-signature approval for shipments above a configurable value threshold

ALTER TABLE "shipments" ADD COLUMN "requiredApprovals" INTEGER;

CREATE TABLE "shipment_approvals" (
    "id"              TEXT         NOT NULL,
    "shipmentId"      TEXT         NOT NULL,
    "approverAddress" TEXT         NOT NULL,
    "note"            TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_approvals_pkey" PRIMARY KEY ("id")
);

-- One approval per approver per shipment; a repeat sign-off must not count twice
CREATE UNIQUE INDEX "shipment_approvals_shipmentId_approverAddress_key"
    ON "shipment_approvals"("shipmentId", "approverAddress");

CREATE INDEX "shipment_approvals_shipmentId_idx" ON "shipment_approvals"("shipmentId");

ALTER TABLE "shipment_approvals"
    ADD CONSTRAINT "shipment_approvals_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
