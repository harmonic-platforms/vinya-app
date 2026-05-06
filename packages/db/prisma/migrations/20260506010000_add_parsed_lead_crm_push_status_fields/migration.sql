-- Add CRM push status fields to ParsedLead
ALTER TABLE "ParsedLead"
  ADD COLUMN "crmPushStatus" TEXT,
  ADD COLUMN "crmPushError" TEXT,
  ADD COLUMN "crmAttemptCount" INTEGER NOT NULL DEFAULT 0;
