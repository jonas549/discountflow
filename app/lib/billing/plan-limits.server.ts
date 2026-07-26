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

/**
 * Count the variant rows of ONE campaign, whatever its status.
 *
 * Necesario para el enforcement al activar/reactivar: en ese momento la campaña
 * NO está ACTIVE, así que `getVariantCount` (que solo cuenta activas) no la
 * incluye. El total real tras activar es `getVariantCount + esta`.
 *
 * Solo PERCENTAGE y RANGE crean filas en CampaignProduct; BXGY y TIERED
 * devuelven 0 por diseño (no editan precios de variantes).
 */
export async function getCampaignVariantCount(campaignId: string): Promise<number> {
  return prisma.campaignProduct.count({ where: { campaignId } });
}

/**
 * Campañas ACTIVAS de un tipo concreto. Sublímite de BXGY y TIERED.
 *
 * Solo cuentan las ACTIVE: pausadas y borradores no ocupan cuota, así que el
 * merchant puede tener varias guardadas y pausar una para activar otra.
 */
export async function getActiveCampaignCountByType(
  shopId: string,
  type: "BXGY" | "TIERED"
): Promise<number> {
  return prisma.campaign.count({ where: { shopId, status: "ACTIVE", type } });
}
