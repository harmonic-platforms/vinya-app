-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "from" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "receivedAt" TIMESTAMP(3),
    "rawHeaders" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_gmailMessageId_key" ON "InboundMessage"("gmailMessageId");

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
