// Gestión de campañas TIERED (descuentos escalonados) vía Shopify Functions.
//
// A diferencia de PERCENTAGE/RANGE, aquí NO se tocan precios de variantes: se
// crea un descuento automático de app (discountAutomaticAppCreate) que apunta a
// nuestra Function, y la configuración viaja en un metafield del descuento.
//
// El shopifyDiscountId se guarda en el config JSON de la campaña para poder
// pausar / reactivar / eliminar después (mismo patrón que BXGY).

import { prisma } from "../db";
import {
  getCollectionProductVariants,
  getAllProductVariants,
  getProductsByFilter,
} from "../shopify/admin-api";
import {
  type TieredCampaignConfig,
  toFunctionConfig,
  TIERED_METAFIELD_KEY,
} from "./tiered-client";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

/** Handle de la extensión (extensions/tiered-discount/shopify.extension.toml). */
const FUNCTION_HANDLE = "tiered-discount";

/**
 * Namespace PLANO a propósito: MetafieldInput solo admite alfanuméricos,
 * guiones y guiones bajos, así que "$app:discountflow" podría ser rechazado.
 * La Function lee los dos (ver su input query).
 */
const METAFIELD_NAMESPACE = "discountflow";

// ─── Function ID ──────────────────────────────────────────────────────────────

/**
 * Busca el ID de nuestra Function en la tienda. No se hardcodea porque la app
 * de dev y la de producción tienen IDs distintos.
 *
 * Solo se piden `id`, `title` y `apiType`: el campo `handle` de ShopifyFunction
 * NO existe en la versión 2025-10 de la Admin API, que es la que usa esta app
 * (ver ApiVersion.October25 en shopify.server.ts). El título de la Function es
 * el `name` de extensions/tiered-discount/locales/en.default.json.
 *
 * El emparejamiento es tolerante a propósito: primero por título, y si no,
 * por tipo de API o descarte cuando solo hay una Function instalada.
 */
export async function getTieredFunctionId(admin: AdminClient): Promise<string> {
  const res = await admin.graphql(
    `#graphql
    query TieredFunctionId {
      shopifyFunctions(first: 50) {
        nodes { id title apiType }
      }
    }`
  );
  const json = await res.json();

  if (json.errors?.length)
    throw new Error(
      `No se pudieron listar las Functions: ${json.errors
        .map((e: { message: string }) => e.message)
        .join(", ")}`
    );

  const nodes: Array<{ id: string; title: string; apiType: string }> =
    json.data?.shopifyFunctions?.nodes ?? [];

  const byTitle = nodes.find(
    (n) => (n.title ?? "").toLowerCase().replace(/[\s_]/g, "-") === FUNCTION_HANDLE
  );
  const byApiType = nodes.filter((n) =>
    (n.apiType ?? "").toLowerCase().includes("discount")
  );

  const fn =
    byTitle ??
    (byApiType.length === 1 ? byApiType[0] : undefined) ??
    (nodes.length === 1 ? nodes[0] : undefined);

  if (!fn?.id) {
    const encontradas = nodes.length
      ? ` Functions encontradas: ${nodes
          .map((n) => `"${n.title}" (${n.apiType})`)
          .join(", ")}.`
      : "";
    throw new Error(
      "No se encontró la Function de descuentos escalonados en esta tienda. " +
        "¿Está corriendo `shopify app dev` (o se desplegó con `shopify app deploy`)?" +
        encontradas
    );
  }

  return fn.id;
}

// ─── Resolución de productos ──────────────────────────────────────────────────

/**
 * Convierte la selección del merchant en una lista explícita de product IDs,
 * que es lo único que la Function sabe interpretar.
 *
 * "all" devuelve lista VACÍA a propósito: para la Function, vacío significa
 * "toda la tienda", así que no hay que enumerar el catálogo entero.
 */
export async function resolveTieredProductIds(
  admin: AdminClient,
  config: TieredCampaignConfig
): Promise<string[]> {
  const mode = config.selectionMode;

  if (mode === "all") return [];
  if (mode === "products") return config.productIds ?? [];

  if (mode === "collections") {
    const ids = config.collectionIds ?? [];
    const seen = new Set<string>();
    for (const collectionId of ids) {
      for (const pv of await getCollectionProductVariants(admin, collectionId)) {
        seen.add(pv.productId);
      }
    }
    return [...seen];
  }

  const rawItems = config.rawItems ?? [];
  if (rawItems.length === 0) return [];

  const field =
    mode === "tags" ? "tag" : mode === "vendors" ? "vendor" : "product_type";
  const query = rawItems.map((v) => `${field}:"${v}"`).join(" OR ");
  const products = await getProductsByFilter(admin, query);
  return [...new Set(products.map((p) => p.productId))];
}

/** Cuántos productos abarca la campaña (solo informativo, para la UI). */
export async function countTieredProducts(
  admin: AdminClient,
  config: TieredCampaignConfig
): Promise<number> {
  if (config.selectionMode === "all")
    return (await getAllProductVariants(admin)).length;
  return (await resolveTieredProductIds(admin, config)).length;
}

// ─── Crear ────────────────────────────────────────────────────────────────────

export async function createTieredDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  config: TieredCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<string> {
  const functionId = await getTieredFunctionId(admin);
  const productIds = await resolveTieredProductIds(admin, config);

  const resolved: TieredCampaignConfig = { ...config, productIds, functionId };

  const res = await admin.graphql(
    `#graphql
    mutation CreateTiered($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        discount: {
          title: `[DiscountFlow] ${campaignName}`,
          functionId,
          startsAt: (startsAt ?? new Date()).toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          discountClasses: ["PRODUCT"],
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key: TIERED_METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(toFunctionConfig(resolved)),
            },
          ],
        },
      },
    }
  );

  const json = await res.json();
  const result = json.data?.discountAutomaticAppCreate;
  if (result?.userErrors?.length > 0) {
    throw new Error(
      result.userErrors.map((e: { message: string }) => e.message).join(", ")
    );
  }

  const shopifyDiscountId: string = result?.automaticAppDiscount?.discountId;
  if (!shopifyDiscountId)
    throw new Error("Shopify no retornó un ID de descuento");

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      config: {
        ...resolved,
        shopifyDiscountId,
      } as unknown as Record<string, unknown>,
    },
  });

  return shopifyDiscountId;
}

// ─── Actualizar ───────────────────────────────────────────────────────────────

export async function updateTieredDiscount(
  admin: AdminClient,
  shopifyDiscountId: string,
  campaignId: string,
  campaignName: string,
  config: TieredCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<void> {
  const productIds = await resolveTieredProductIds(admin, config);
  const resolved: TieredCampaignConfig = { ...config, productIds, shopifyDiscountId };

  const res = await admin.graphql(
    `#graphql
    mutation UpdateTiered($id: ID!, $discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        id: shopifyDiscountId,
        discount: {
          title: `[DiscountFlow] ${campaignName}`,
          startsAt: (startsAt ?? new Date()).toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key: TIERED_METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(toFunctionConfig(resolved)),
            },
          ],
        },
      },
    }
  );

  const json = await res.json();
  const errors = json.data?.discountAutomaticAppUpdate?.userErrors;
  if (errors?.length > 0)
    throw new Error(errors.map((e: { message: string }) => e.message).join(", "));

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { config: resolved as unknown as Record<string, unknown> },
  });
}

// ─── Pausar / reactivar / eliminar ────────────────────────────────────────────
//
// Son las mismas mutaciones genéricas de descuento automático que usa BXGY.
// Se duplican aquí a propósito en vez de refactorizar bxgy.ts: esa ruta está en
// producción con clientes reales y no hay motivo para tocarla hoy.

export async function deactivateTieredDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  const res = await admin.graphql(
    `#graphql
    mutation DeactivateTiered($id: ID!) {
      discountAutomaticDeactivate(id: $id) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    { variables: { id: shopifyDiscountId } }
  );
  const json = await res.json();
  const errors = json.data?.discountAutomaticDeactivate?.userErrors;
  if (errors?.length > 0)
    throw new Error(errors.map((e: { message: string }) => e.message).join(", "));
}

export async function activateTieredDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  const res = await admin.graphql(
    `#graphql
    mutation ActivateTiered($id: ID!) {
      discountAutomaticActivate(id: $id) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    { variables: { id: shopifyDiscountId } }
  );
  const json = await res.json();
  const errors = json.data?.discountAutomaticActivate?.userErrors;
  if (errors?.length > 0)
    throw new Error(errors.map((e: { message: string }) => e.message).join(", "));
}

export async function deleteTieredDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  const res = await admin.graphql(
    `#graphql
    mutation DeleteTiered($id: ID!) {
      discountAutomaticDelete(id: $id) {
        deletedAutomaticDiscountId
        userErrors { field message }
      }
    }`,
    { variables: { id: shopifyDiscountId } }
  );
  const json = await res.json();
  const errors = json.data?.discountAutomaticDelete?.userErrors;
  if (errors?.length > 0)
    throw new Error(errors.map((e: { message: string }) => e.message).join(", "));
}
