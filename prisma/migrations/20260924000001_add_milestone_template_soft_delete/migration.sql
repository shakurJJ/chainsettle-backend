-- Migration: add_milestone_template_soft_delete
-- Adds deletedAt to milestones and shipment_templates so DELETE endpoints
-- soft-delete instead of removing the row (#306).

ALTER TABLE "milestones"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "shipment_templates"
  ADD COLUMN "deletedAt" TIMESTAMP(3);
