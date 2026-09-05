// De dónde sale la configuración que el widget de packs necesita para pintarse.
//
// Existe para que el app proxy y el metafield del tema NO tengan dos consultas
// distintas a Postgres. Son dos caminos de entrega del MISMO dato: si uno
// filtrara las campañas de otra forma, el widget mostraría una cosa en el primer
// pintado y otra al revalidar, y nadie sabría cuál está bien.

import { prisma } from "../db";
import {
  PACK_LINE_ATTRIBUTE,
  packMinimum,
  type PackCampaignConfig,
  type PackWidgetPayload,
} from "./pack-client";
import { normalizePackTiers } from "./pack-calc";

/**
 * Los packs que una tienda está ofreciendo AHORA, del más nuevo al más viejo.
 *
 * La ventana de fechas se comprueba acá y no en el cron porque **el cron no
 * existe**: `vercel.json` declara `/api/cron/sync-campaigns` y la ruta no está.
 * Sin esta comprobación, un pack con `endsAt` pasado se seguiría ofreciendo en
 * la tienda aunque su descuento ya no aplicara, y el comprador armaría un pack
 * que en el carrito no rebaja nada.
 */
export async function packsActivosDeLaTienda(
  shopId: string,
  currency: string,
  ahora: Date = new Date()
): Promise<PackWidgetPayload[]> {
  const campaigns = await prisma.campaign.findMany({
    where: {
      shopId,
      type: "PACK",
      status: "ACTIVE",
      OR: [{ startsAt: null }, { startsAt: { lte: ahora } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: ahora } }] }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, config: true },
  });

  const out: PackWidgetPayload[] = [];
  for (const campaign of campaigns) {
    const config = campaign.config as PackCampaignConfig;
    const items = config.items ?? [];
    // Un pack sin catálogo no es un pack: no se ofrece.
    if (items.length === 0) continue;

    out.push({
      campaignId: campaign.id,
      heading: config.heading || "Armá tu pack",
      mode: config.mode ?? "PER_PRODUCT",
      tiers: normalizePackTiers(config.tiers),
      minProducts: packMinimum(config),
      attribute: PACK_LINE_ATTRIBUTE,
      currency,
      items,
    });
  }
  return out;
}
