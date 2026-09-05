// App proxy: le entrega al widget de la tienda la configuración de un pack.
//
// Ruta pública en el STOREFRONT: `/apps/discountflow/pack?campaign=<id>`
// Shopify la reenvía firmada a esta ruta (ver `[app_proxy]` en el .toml).
//
// ─── 🔴 ESTO YA NO ES EL CAMINO NORMAL ───────────────────────────────────────
//
// Hasta el 2026-09-05 el widget SIEMPRE pedía acá su configuración, y por eso
// mostraba «Cargando tu pack…» en cada visita. Hoy el bloque de tema se pinta
// completo en el servidor leyendo el metafield de la app (ver
// `pack-widget-metafield.server.ts`), y esta ruta quedó para tres casos:
//
//   1. La tienda todavía no tiene el metafield escrito (campaña anterior al
//      cambio, o app recién instalada).
//   2. El bloque apunta a una campaña que no está en el metafield.
//   3. El bloque resolvió MENOS productos de los que debía — `all_products` solo
//      da 20 handles POR PÁGINA y el tema puede estar gastando parte del cupo.
//
// Y, siempre, para la revalidación en segundo plano: el widget ya pintado
// pregunta acá y se corrige solo si algo difiere. Sin estado de carga en ningún
// camino.
//
// ⚠️ Cada llamada es una invocación de Vercel. En Hobby eso cuenta. Por eso la
// respuesta se cachea y NO llama a la Admin API: todo sale de la foto que
// guardó el admin al guardar la campaña.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { packsActivosDeLaTienda } from "../lib/discounts/pack-widget-payload.server";

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

  // La consulta vive en `pack-widget-payload.server.ts` porque el metafield del
  // tema entrega EXACTAMENTE lo mismo por otro camino. Dos consultas distintas
  // para el mismo dato es como se llega a que el primer pintado diga una cosa y
  // la revalidacion diga otra.
  const packs = await packsActivosDeLaTienda(shop.id, shop.currency);
  const pack = campaignId
    ? packs.find((p) => p.campaignId === campaignId)
    : packs[0];

  if (!pack) return json(SIN_PACK);

  return json({ pack });
};
