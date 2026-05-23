import { prisma } from "../db";

/** Count active (non-finished) campaigns for quota. */
export async function getCampaignCount(shopId: string): Promise<number> {
  return prisma.campaign.count({
    where: { shopId, status: { notIn: ["CANCELLED", "COMPLETED"] } },
  });
}

/** Count active variant records for quota. */
export async function getVariantCount(shopId: string): Promise<number> {
  return prisma.campaignProduct.count({
    where: {
      campaign: { shopId, status: { notIn: ["CANCELLED", "COMPLETED"] } },
    },
  });
}
