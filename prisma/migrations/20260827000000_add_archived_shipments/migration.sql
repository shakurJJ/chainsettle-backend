-- CreateTable
CREATE TABLE "archived_shipments" (
    "id" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "buyerAddress" TEXT NOT NULL,
    "supplierAddress" TEXT NOT NULL,
    "logisticsAddress" TEXT NOT NULL,
    "arbiterAddress" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "terminalAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "archived_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "archived_shipments_buyerAddress_idx" ON "archived_shipments"("buyerAddress");

-- CreateIndex
CREATE INDEX "archived_shipments_supplierAddress_idx" ON "archived_shipments"("supplierAddress");

-- CreateIndex
CREATE INDEX "archived_shipments_logisticsAddress_idx" ON "archived_shipments"("logisticsAddress");

-- CreateIndex
CREATE INDEX "archived_shipments_arbiterAddress_idx" ON "archived_shipments"("arbiterAddress");

-- CreateIndex
CREATE INDEX "archived_shipments_status_idx" ON "archived_shipments"("status");

-- CreateIndex
CREATE INDEX "archived_shipments_archivedAt_idx" ON "archived_shipments"("archivedAt");

-- CreateIndex
CREATE INDEX "archived_shipments_terminalAt_idx" ON "archived_shipments"("terminalAt");
