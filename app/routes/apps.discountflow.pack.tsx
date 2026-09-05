// App proxy: le entrega al widget de la tienda la configuración de un pack.
//
// Ruta pública en el STOREFRONT: `/apps/discountflow/pack?campaign=<id>`
// Shopify la reenvía firmada a esta ruta (ver `[app_proxy]` en el .toml).
//
// ─── Por qué un app proxy y no un metafield ──────────────────────────────────
//
// El widget necesita el catálogo curado, los porcentajes y los precios. Las
// alternativas eran:
//
//   · Metafield de tienda leído por Liquid → exige visibilidad de storefront y
//     una definición de metafield, y hay que reescribirlo en cada guardado.
//   · Llamar a la Admin API desde el widget → imposible, es una credencial de
//     servidor.
//   · App proxy (esto) → la fuente es Postgres, siempre está al día, y no
//     necesita NINGÚN scope nuevo, así que ningún merchant reautoriza.
//
// ⚠️ Cada carga de la página del merchant que tenga el bloque es una invocación
// de Vercel. En Hobby eso cuenta. Por eso la respuesta se cachea y NO llama a la
// Admin API: todo sale de la foto que guardó el admin al guardar la campaña.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import {
  PACK_LINE_ATTRIBUTE,
  packMinimum,
  type PackCampaignConfig,
  type PackWidgetPayload,
} from "../lib/discounts/pack-client";
import { normalizePackTiers } from "../lib/discounts/pack-calc";

const SIN_PACK = { pack: null } as const;

/** Respuesta JSON con la caché que corresponde a un dato de tienda. */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 60 s de caché: suficiente para que una ráfaga de visitas no se convierta
      // en una ráfaga de invocaciones, y poco para que un cambio del merchant se
      // vea casi al instante. `stale-while-revalidate` evita el pico al expirar.
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verifica la firma HMAC que pone Shopify. Sin esto, cualquiera podría leer
  // la configuración de packs de cualquier tienda pasando `?shop=`.
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop");
  if (!shopDomain) return json(SIN_PACK, 400);

  const campaignId = url.searchParams.get("campaign");

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, currency: true },
  });
  if (!shop) return json(SIN_PACK, 404);

  const ahora = new Date();
  const campaign = await prisma.campaign.findFirst({
    where: {
      shopId: shop.id,
      type: "PACK",
      status: "ACTIVE",
      ...(campaignId ? { id: campaignId } : {}),
      // Una campaña programada para el futuro no debe pintarse todavía, y una
      // vencida tampoco. Se comprueba acá porque el cron que debería cerrarlas
      // NO EXISTE (deuda conocida: `vercel.json` declara /api/cron/sync-campaigns
      // y la ruta no está). Sin esto, un pack con `endsAt` pasado seguiría
      // ofreciéndose en la tienda aunque su descuento ya no aplicara — el
      // comprador armaría el pack y no vería el descuento en el carrito.
      OR: [{ startsAt: null }, { startsAt: { lte: ahora } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: ahora } }] }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, config: true },
  });

  if (!campaign) return json(SIN_PACK);

  const config = campaign.config as PackCampaignConfig;
  const items = config.items ?? [];
  if (items.length === 0) return json(SIN_PACK);

  const payload: PackWidgetPayload = {
    campaignId: campaign.id,
    heading: config.heading || "Armá tu pack",
    mode: config.mode ?? "PER_PRODUCT",
    tiers: normalizePackTiers(config.tiers),
    minProducts: packMinimum(config),
    attribute: PACK_LINE_ATTRIBUTE,
    currency: shop.currency,
    items,
  };

  return json({ pack: payload });
};
