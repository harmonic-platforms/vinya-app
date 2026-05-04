/*
  Warnings:

  - You are about to drop the column `externalId` on the `CrmIntegration` table. All the data in the column will be lost.
  - You are about to drop the column `email` on the `EmailAccount` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[tenantId,provider]` on the table `CrmIntegration` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenantId,provider,emailAddress]` on the table `EmailAccount` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `provider` on the `CrmIntegration` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `emailAddress` to the `EmailAccount` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `provider` on the `EmailAccount` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('GMAIL');

-- CreateEnum
CREATE TYPE "CrmProvider" AS ENUM ('CLOSE', 'HUBSPOT');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR', 'NEEDS_REAUTH');

-- DropIndex
DROP INDEX "EmailAccount_email_key";

-- AlterTable
ALTER TABLE "CrmIntegration" DROP COLUMN "externalId",
ADD COLUMN     "accountName" TEXT,
ADD COLUMN     "config" JSONB,
ADD COLUMN     "encryptedAccessToken" TEXT,
ADD COLUMN     "encryptedRefreshToken" TEXT,
ADD COLUMN     "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3),
DROP COLUMN "provider",
ADD COLUMN     "provider" "CrmProvider" NOT NULL;

-- AlterTable
ALTER TABLE "EmailAccount" DROP COLUMN "email",
ADD COLUMN     "emailAddress" TEXT NOT NULL,
ADD COLUMN     "gmailHistoryId" TEXT,
ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
ADD COLUMN     "watchExpiration" TIMESTAMP(3),
DROP COLUMN "provider",
ADD COLUMN     "provider" "EmailProvider" NOT NULL;

-- CreateTable
CREATE TABLE "GmailCredential" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GmailCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailCredential_emailAccountId_key" ON "GmailCredential"("emailAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmIntegration_tenantId_provider_key" ON "CrmIntegration"("tenantId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_tenantId_provider_emailAddress_key" ON "EmailAccount"("tenantId", "provider", "emailAddress");

-- AddForeignKey
ALTER TABLE "GmailCredential" ADD CONSTRAINT "GmailCredential_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
