-- Add CRM push fields to ParsedLead
ALTER TABLE "ParsedLead"
  ADD COLUMN "crmPushed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "crmProvider" TEXT,
  ADD COLUMN "crmRecordId" TEXT,
  ADD COLUMN "crmPushedAt" TIMESTAMP(3);
