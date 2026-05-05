-- CreateTable
CREATE TABLE "ParsedLead" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "message" TEXT,
    "rawText" TEXT NOT NULL,
    "parseStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParsedLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParsedLead_inboundMessageId_key" ON "ParsedLead"("inboundMessageId");

-- AddForeignKey
ALTER TABLE "ParsedLead" ADD CONSTRAINT "ParsedLead_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
