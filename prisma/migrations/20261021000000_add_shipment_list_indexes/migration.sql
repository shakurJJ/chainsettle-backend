-- Index common participant/status/date list queries and updatedAfter filters.
CREATE INDEX "shipments_buyerAddress_status_createdAt_idx"
  ON "shipments"("buyerAddress", "status", "createdAt");

CREATE INDEX "shipments_supplierAddress_status_createdAt_idx"
  ON "shipments"("supplierAddress", "status", "createdAt");

CREATE INDEX "shipments_updatedAt_idx"
  ON "shipments"("updatedAt");