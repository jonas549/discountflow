import { prisma } from "../db";

/** Count only ACTIVE campaigns (used for plan enforcement and display). */
export async function getActiveCampaignCount(shopId: string): Promise<number> {
  return prisma.campaign.count({
    where: { shopId, status: "ACTIVE" },
  });
}

/** @deprecated Alias kept for backwards-compat — use getActiveCampaignCount. */
export const getCampaignCount = getActiveCampaignCount;

/** Count variant records in ACTIVE campaigns for quota display. */
export async function getVariantCount(shopId: string): Promise<number> {
  return prisma.campaignProduct.count({
    where: { campaign: { shopId, status: "ACTIVE" } },
  });
}
