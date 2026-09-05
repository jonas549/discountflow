// Gestión de campañas PACK (packs armables por el comprador) vía Shopify Functions.
//
// Igual que TIERED, aquí NO se tocan precios de variantes: se crea un descuento
// automático de app (`discountAutomaticAppCreate`) que apunta a la Function
// `pack-discount`, y la configuración viaja en un metafield del descuento.
//
// La diferencia con TIERED es de dónde salen las líneas elegibles: no de una
// selección de catálogo, sino de lo que el comprador armó en el widget. La
// Function las reconoce por la propiedad de línea `_df_pack`.

import { prisma } from "../db";
import { readQueryData } from "../shopify/admin-api";
import { runDiscountMutation, type AdminClient } from "./discount-mutation";
import { getDiscountFunctionId, PACK_FUNCTION_HANDLE } from "./function-id";
import {
  type PackCampaignConfig,
  type PackItemSnapshot,
  toPackFunctionConfig,
  packDiscountTitle,
  PACK_METAFIELD_KEY,
  PACK_DEFAULT_MESSAGE,
} from "./pack-client";

/**
 * Namespace PLANO a propósito: MetafieldInput solo admite alfanuméricos,
 * guiones y guiones bajos, así que "$app:discountflow" podría ser rechazado.
 * La Function lee los dos (ver su input query).
 */
const METAFIELD_NAMESPACE = "discountflow";

/** El ID de la Function de packs en esta tienda. */
export async function getPackFunctionId(admin: AdminClient): Promise<string> {
  return getDiscountFunctionId(admin, PACK_FUNCTION_HANDLE, {
    // 🔴 `false` a propósito. Con dos Functions instaladas, "es la única de
    // descuento" ya no identifica a nadie, y acertar por descarte enganchando
    // los packs al Wasm de escalonados daría una campaña que la app muestra
    // activa y que en el checkout no descuenta nada.
    allowSingleFunctionFallback: false,
  });
}

// ─── Foto del catálogo para el widget ────────────────────────────────────────

type ProductNode = {
  __typename?: string;
  id: string;
  handle: string;
  title: string;
  featuredImage?: { url: string } | null;
  variants?: { nodes: Array<{ id: string; price: string; availableForSale: boolean }> };
};

/**
 * Trae los datos de presentación de los productos curados.
 *
 * Se guardan en el config de la campaña para que el widget de la tienda pueda
 * pintarse SIN una llamada a la Admin API por cada carga de página. El precio
 * que se guarda es una foto del momento de guardar; el widget lo refresca
 * contra `/products/{handle}.js`, que es del storefront y va por CDN.
 *
 * ⚠️ Ese precio NUNCA decide dinero: el descuento lo calcula la Function sobre
 * el precio real del carrito.
 */
export async function getPackProductSnapshots(
  admin: AdminClient,
  productIds: string[]
): Promise<PackItemSnapshot[]> {
  if (productIds.length === 0) return [];

  const res = await admin.graphql(
    `#graphql
    query PackProductSnapshots($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        ... on Product {
          id
          handle
          title
          featuredImage { url }
          variants(first: 20) {
            nodes { id price availableForSale }
          }
        }
      }
    }`,
    { variables: { ids: productIds.slice(0, 250) } }
  );

  // Fail-loud: un fallo de API no puede pasar por "el pack no tiene productos".
  const nodes =
    readQueryData<ProductNode[]>(await res.json(), "nodes", "pack/snapshots") ?? [];

  const porId = new Map<string, PackItemSnapshot>();
  for (const n of nodes) {
    if (!n || n.__typename !== "Product" || !n.id) continue;
    const variantes = n.variants?.nodes ?? [];
    // La primera disponible; si ninguna lo está, la primera a secas, para que el
    // merchant vea el producto en el formulario en vez de que desaparezca sin
    // explicación.
    const variante = variantes.find((v) => v.availableForSale) ?? variantes[0];
    if (!variante) continue;

    const price = Number(variante.price);
    porId.set(n.id, {
      productId: n.id,
      handle: n.handle,
      title: n.title,
      variantId: variante.id,
      price: Number.isFinite(price) ? price : 0,
      image: n.featuredImage?.url ?? null,
    });
  }

  // Se devuelve en el orden en que el merchant los eligió, no en el que
  // respondió Shopify: ese orden es el que verá el comprador en el widget.
  return productIds
    .map((id) => porId.get(id))
    .filter((s): s is PackItemSnapshot => Boolean(s));
}

/**
 * Con qué otros descuentos automáticos convive un pack.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 `orderDiscounts: true` — POR QUÉ CAMBIÓ, Y QUÉ SE MIDIÓ
 *
 * Estaba en `false`, y eso hacía DESAPARECER el descuento por monto de compra.
 * Medido en la tienda de dev el 2026-09-05: un pack de 4 productos ($278 de
 * lista) aplicaba su 30% y dejaba el carrito en $194,60; el descuento de valor
 * de carrito, que a $194,60 tenía que dar $25, no aparecía por ningún lado.
 *
 * `combinesWith` es BILATERAL: los dos descuentos tienen que decir que sí. El
 * de valor de carrito decía `productDiscounts: true`; el pack decía
 * `orderDiscounts: false`. Con uno solo que diga no, Shopify descarta al otro
 * — y no avisa a nadie. Comprobado leyendo los dos descuentos de la tienda:
 *
 *   [DiscountFlow] Pack prueba          PRODUCT  order:false product:false
 *   [DiscountFlow · PRUEBA F1] ...      ORDER    order:false product:true
 *
 * Ahora los dos dicen que sí, y quién gana deja de decidirlo Shopify en
 * silencio: lo decide el merchant con la EXCLUSIÓN ENTRE CAMPAÑAS, que se
 * evalúa dentro de nuestra Function y deja un log de por qué no aplicó. Ver
 * `cart-value-client.ts`.
 *
 * `productDiscounts` sigue en `false` a propósito: es otra pregunta —si un pack
 * se suma a un escalonado sobre los MISMOS productos— y esa sí sería regalar
 * descuento sobre descuento. Se gestiona avisando en el formulario, con
 * `findPackOverlaps`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const COMBINACION_DEL_PACK = {
  orderDiscounts: true,
  productDiscounts: false,
  shippingDiscounts: false,
};

// ─── Solapamiento con otras campañas ─────────────────────────────────────────

export type PackOverlap = { campaignName: string; productCount: number };

/**
 * ¿Alguno de los productos del pack está ya cubierto por otra campaña ACTIVA?
 *
 * Por qué existe: los descuentos de pack se crean con
 * `combinesWith.productDiscounts: false`, igual que el resto de la app. Si un
 * producto del pack también está en una campaña escalonada o BxGy activa,
 * Shopify aplicará uno de los dos y el otro se pierde **en silencio**.
 *
 * En escalonados eso no es un problema real: nadie pone dos campañas sobre el
 * mismo producto a propósito, porque sería regalar descuento sobre descuento.
 * En packs sí, porque el merchant cura una lista de productos sueltos y es fácil
 * que alguno esté cubierto por otra campaña sin haberlo buscado.
 *
 * Esto NO bloquea el guardado: avisa. Puede haber razones legítimas para el
 * solapamiento, y bloquear al merchant por una heurística es peor que
 * informarlo.
 */
export async function findPackOverlaps(
  shopId: string,
  productIds: string[],
  excludeCampaignId?: string
): Promise<PackOverlap[]> {
  if (productIds.length === 0) return [];

  const activas = await prisma.campaign.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      type: { in: ["TIERED", "BXGY", "PACK"] },
      ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}),
    },
    select: { id: true, name: true, type: true, config: true },
  });

  const enElPack = new Set(productIds);
  const out: PackOverlap[] = [];

  for (const c of activas) {
    const cfg = c.config as Record<string, unknown>;
    const ids = new Set<string>();

    if (c.type === "PACK") {
      for (const p of (cfg.products as Array<{ productId?: string }>) ?? [])
        if (p?.productId) ids.add(p.productId);
    } else if (c.type === "TIERED") {
      // Una campaña escalonada de "toda la tienda" cubre todo por definición.
      if (cfg.selectionMode === "all") {
        out.push({ campaignName: c.name, productCount: enElPack.size });
        continue;
      }
      for (const id of (cfg.productIds as string[]) ?? []) ids.add(id);
    } else {
      for (const id of (cfg.xProductIds as string[]) ?? []) ids.add(id);
      for (const id of (cfg.yProductIds as string[]) ?? []) ids.add(id);
    }

    let n = 0;
    for (const id of ids) if (enElPack.has(id)) n++;
    if (n > 0) out.push({ campaignName: c.name, productCount: n });
  }

  return out;
}

// ─── Crear ───────────────────────────────────────────────────────────────────

export async function createPackDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  config: PackCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<string> {
  const functionId = await getPackFunctionId(admin);
  const functionConfig = toPackFunctionConfig(campaignId, config);

  const result = await runDiscountMutation(
    admin,
    `#graphql
    mutation CreatePack($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      discount: {
        title: packDiscountTitle(campaignName),
        functionId,
        startsAt: (startsAt ?? new Date()).toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        discountClasses: ["PRODUCT"],
        combinesWith: COMBINACION_DEL_PACK,
        metafields: [
          {
            namespace: METAFIELD_NAMESPACE,
            key: PACK_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(functionConfig),
          },
        ],
      },
    },
    "discountAutomaticAppCreate"
  );

  const shopifyDiscountId = (
    result.automaticAppDiscount as { discountId?: string } | undefined
  )?.discountId;

  if (!shopifyDiscountId)
    throw new Error("Shopify no retornó un ID de descuento");

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      config: {
        ...config,
        shopifyDiscountId,
        functionId,
      } as unknown as Record<string, unknown>,
    },
  });

  return shopifyDiscountId;
}

// ─── Actualizar ──────────────────────────────────────────────────────────────

/**
 * Reescribe título, fechas y metafield de un descuento de pack existente.
 *
 * Se llama también al REACTIVAR desde el listado, no solo al editar: sin eso,
 * una campaña que se pausó, se editó y se volvió a activar quedaría viva en
 * Shopify con la configuración vieja. Es la misma lección que dejó la capa 5 del
 * blindaje de escalonados del 2026-07-28.
 */
export async function updatePackDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  shopifyDiscountId: string,
  config: PackCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<void> {
  const functionConfig = toPackFunctionConfig(campaignId, config);

  await runDiscountMutation(
    admin,
    `#graphql
    mutation UpdatePack($id: ID!, $discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      id: shopifyDiscountId,
      discount: {
        title: packDiscountTitle(campaignName),
        startsAt: (startsAt ?? new Date()).toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        // 🔴 Se reescribe TAMBIEN al actualizar. Sin esto, un descuento creado
        // antes del 2026-09-05 se quedaria con `orderDiscounts: false` para
        // siempre y el descuento por monto de compra seguiria perdiendose.
        combinesWith: COMBINACION_DEL_PACK,
        metafields: [
          {
            namespace: METAFIELD_NAMESPACE,
            key: PACK_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(functionConfig),
          },
        ],
      },
    },
    "discountAutomaticAppUpdate"
  );
}

// ─── Activar / pausar / eliminar ─────────────────────────────────────────────

export async function activatePackDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation ActivatePack($id: ID!) {
      discountAutomaticActivate(id: $id) {
        userErrors { field message }
      }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticActivate"
  );
}

export async function deactivatePackDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeactivatePack($id: ID!) {
      discountAutomaticDeactivate(id: $id) {
        userErrors { field message }
      }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticDeactivate"
  );
}

export async function deletePackDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeletePack($id: ID!) {
      discountAutomaticDelete(id: $id) {
        userErrors { field message }
      }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticDelete"
  );
}

export { PACK_DEFAULT_MESSAGE };
