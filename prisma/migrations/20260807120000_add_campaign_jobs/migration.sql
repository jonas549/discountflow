-- CreateEnum
CREATE TYPE "JobOperation" AS ENUM ('NOOP', 'APPLY', 'REACTIVATE', 'REVERT', 'DELETE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RESOLVING', 'RUNNING', 'CANCELLING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "activeJobId" TEXT;

-- AlterTable
ALTER TABLE "CampaignProduct" ADD COLUMN     "processedByJobId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "features" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "CampaignJob" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "operation" "JobOperation" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL DEFAULT 'RESOLVING',
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "processedProducts" INTEGER NOT NULL DEFAULT 0,
    "totalVariants" INTEGER NOT NULL DEFAULT 0,
    "processedVariants" INTEGER NOT NULL DEFAULT 0,
    "resolveCursor" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "leaseNonce" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "lastError" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignJob_shopId_idx" ON "CampaignJob"("shopId");

-- CreateIndex
CREATE INDEX "CampaignJob_campaignId_idx" ON "CampaignJob"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignJob_status_heartbeatAt_idx" ON "CampaignJob"("status", "heartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_activeJobId_key" ON "Campaign"("activeJobId");

-- CreateIndex
CREATE INDEX "CampaignProduct_campaignId_processedByJobId_idx" ON "CampaignProduct"("campaignId", "processedByJobId");

-- AddForeignKey
ALTER TABLE "CampaignJob" ADD CONSTRAINT "CampaignJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

