-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- CreateIndex
CREATE INDEX "OrderAttribution_createdAt_idx" ON "OrderAttribution"("createdAt");

-- CreateIndex
CREATE INDEX "OrderAttribution_campaignId_createdAt_idx" ON "OrderAttribution"("campaignId", "createdAt");
