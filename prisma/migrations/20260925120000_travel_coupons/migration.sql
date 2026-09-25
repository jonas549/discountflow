-- Cupones de viaje (feature de una sola tienda, detras del flag cupones:viaje).
-- 100% ADITIVA: un enum nuevo y tres tablas nuevas. Ningun ALTER sobre tablas existentes.

-- CreateEnum
CREATE TYPE "TravelCouponMode" AS ENUM ('FULL_PAYMENT', 'RESERVATION');

-- CreateTable
CREATE TABLE "TravelCouponCampaign" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "optionName" TEXT NOT NULL,
    "fullPaymentValue" TEXT NOT NULL,
    "reservationValue" TEXT NOT NULL,
    "fullPaymentVariantIds" JSONB NOT NULL DEFAULT '[]',
    "reservationVariantIds" JSONB NOT NULL DEFAULT '[]',
    "visibleCount" INTEGER NOT NULL DEFAULT 1,
    "heading" TEXT NOT NULL,
    "messageFullPayment" TEXT NOT NULL,
    "messageReservation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TravelCouponCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelCoupon" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "stock" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "code" TEXT NOT NULL,
    "shopifyDiscountId" TEXT,
    "shopifyActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TravelCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelCouponRedemption" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "mode" "TravelCouponMode" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "excess" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'webhook',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TravelCouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TravelCouponCampaign_shopId_idx" ON "TravelCouponCampaign"("shopId");

-- CreateIndex
CREATE INDEX "TravelCouponCampaign_shopId_productId_idx" ON "TravelCouponCampaign"("shopId", "productId");

-- CreateIndex
CREATE INDEX "TravelCoupon_code_idx" ON "TravelCoupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "TravelCoupon_campaignId_position_key" ON "TravelCoupon"("campaignId", "position");

-- CreateIndex
CREATE INDEX "TravelCouponRedemption_campaignId_createdAt_idx" ON "TravelCouponRedemption"("campaignId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TravelCouponRedemption_couponId_shopifyOrderId_key" ON "TravelCouponRedemption"("couponId", "shopifyOrderId");

-- AddForeignKey
ALTER TABLE "TravelCouponCampaign" ADD CONSTRAINT "TravelCouponCampaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelCoupon" ADD CONSTRAINT "TravelCoupon_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TravelCouponCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelCouponRedemption" ADD CONSTRAINT "TravelCouponRedemption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TravelCouponCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelCouponRedemption" ADD CONSTRAINT "TravelCouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "TravelCoupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
