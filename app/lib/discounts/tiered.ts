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
  tieredDiscountTitle,
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

/**
 * Ejecuta una mutación y NO deja pasar ningún fallo en silencio.
 *
 * Hay tres formas distintas de fallar y hay que mirar las tres:
 *   1. `json.errors`  → la consulta ni se ejecutó (campo o mutación que no
 *      existe en esta versión de la API). Shopify devuelve `data: null`.
 *   2. `json.data[root]` ausente → respuesta inesperada.
 *   3. `userErrors`   → la consulta corrió pero Shopify rechazó los datos.
 *
 * Mirar solo (3) —que es lo que hacía este archivo— hace que un fallo de tipo
 * (1) se trague sin excepción: la app redirige como si todo hubiera ido bien
 * mientras en Shopify no ha cambiado nada.
 */
async function runDiscountMutation(
  admin: AdminClient,
  query: string,
  variables: unknown,
  root: string
): Promise<Record<string, unknown>> {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();

  if (json.errors?.length)
    throw new Error(
      `Shopify rechazó la consulta (${root}): ${json.errors
        .map((e: { message: string }) => e.message)
        .join(", ")}`
    );

  const result = json.data?.[root];
  if (!result)
    throw new Error(`Shopify no devolvió datos para ${root}.`);

  const userErrors = result.userErrors as Array<{ message: string }> | undefined;
  if (userErrors?.length)
    throw new Error(userErrors.map((e) => e.message).join(", "));

  return result;
}

/**
 * TEMPORAL [tiered-debug] — lee de Shopify cómo quedó realmente el descuento:
 * estado, fechas, combinesWith y si el metafield de configuración existe.
 *
 * Envuelto en try/catch a propósito: es diagnóstico, y bajo ningún concepto
 * puede romper el guardado de una campaña si algún campo no existe en esta
 * versión de la API.
 */
async function logTieredDiscountState(
  admin: AdminClient,
  shopifyDiscountId: string,
  contexto: string
): Promise<void> {
  try {
    const res = await admin.graphql(
      `#graphql
      query TieredDiscountState($id: ID!) {
        discountNode(id: $id) {
          id
          discount {
            ... on DiscountAutomaticApp {
              title
              status
              startsAt
              endsAt
              combinesWith {
                orderDiscounts
                productDiscounts
                shippingDiscounts
              }
              appDiscountType { functionId }
            }
          }
          metafield(namespace: "discountflow", key: "tiered-config") {
            value
          }
        }
      }`,
      { variables: { id: shopifyDiscountId } }
    );
    const json = await res.json();

    if (json.errors?.length) {
      console.log(
        `[tiered-debug] estado/${contexto} ERROR-GRAPHQL`,
        JSON.stringify(json.errors.map((e: { message: string }) => e.message))
      );
      return;
    }

    const node = json.data?.discountNode;
    const raw: string | undefined = node?.metafield?.value;
    let parsed: { productIds?: string[]; mode?: string; tiers?: unknown[] } | null = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    console.log(
      `[tiered-debug] estado/${contexto}`,
      JSON.stringify({
        encontrado: !!node,
        title: node?.discount?.title ?? null,
        status: node?.discount?.status ?? null,
        startsAt: node?.discount?.startsAt ?? null,
        endsAt: node?.discount?.endsAt ?? null,
        combinesWith: node?.discount?.combinesWith ?? null,
        functionId: node?.discount?.appDiscountType?.functionId ?? null,
        metafieldExiste: !!raw,
        metafieldBytes: raw?.length ?? 0,
        configModo: parsed?.mode ?? null,
        configTiers: parsed?.tiers?.length ?? 0,
        configProductIds: parsed?.productIds?.length ?? null,
        configMuestraIds: parsed?.productIds?.slice(0, 3) ?? null,
      })
    );
  } catch (err) {
    console.log(`[tiered-debug] estado/${contexto} EXCEPCION`, String(err));
  }
}

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
  const functionConfig = toFunctionConfig(resolved);

  // TEMPORAL [tiered-debug] — instrumentación para diagnosticar SkinUp.
  // Quitar en cuanto se cierre el caso.
  console.log(
    "[tiered-debug] create/resolve",
    JSON.stringify({
      campaignId,
      campaignName,
      functionId,
      selectionMode: config.selectionMode,
      collectionIdsEntrada: config.collectionIds?.length ?? 0,
      rawItemsEntrada: config.rawItems?.length ?? 0,
      productIdsEntrada: config.productIds?.length ?? 0,
      productIdsResueltos: productIds.length,
      muestraIds: productIds.slice(0, 3),
      tiers: functionConfig.tiers,
      metafieldBytes: JSON.stringify(functionConfig).length,
      startsAt: (startsAt ?? new Date()).toISOString(),
      endsAt: endsAt?.toISOString() ?? null,
    })
  );

  const result = await runDiscountMutation(
    admin,
    `#graphql
    mutation CreateTiered($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
        discount: {
          title: tieredDiscountTitle(campaignName),
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

  // TEMPORAL [tiered-debug]
  console.log(
    "[tiered-debug] create/resultado",
    JSON.stringify({
      campaignId,
      shopifyDiscountId: shopifyDiscountId ?? null,
      metafieldNamespace: METAFIELD_NAMESPACE,
      metafieldKey: TIERED_METAFIELD_KEY,
      combinesWithEnviado: {
        orderDiscounts: false,
        productDiscounts: false,
        shippingDiscounts: false,
      },
      discountClassesEnviado: ["PRODUCT"],
    })
  );

  if (!shopifyDiscountId)
    throw new Error("Shopify no retornó un ID de descuento");

  // TEMPORAL [tiered-debug] — verificación contra Shopify de lo que quedó.
  await logTieredDiscountState(admin, shopifyDiscountId, "tras-crear");

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

  // TEMPORAL [tiered-debug]
  console.log(
    "[tiered-debug] update/resolve",
    JSON.stringify({
      campaignId,
      campaignName,
      shopifyDiscountId,
      selectionMode: config.selectionMode,
      collectionIdsEntrada: config.collectionIds?.length ?? 0,
      rawItemsEntrada: config.rawItems?.length ?? 0,
      productIdsEntrada: config.productIds?.length ?? 0,
      productIdsResueltos: productIds.length,
      muestraIds: productIds.slice(0, 3),
      metafieldBytes: JSON.stringify(toFunctionConfig(resolved)).length,
    })
  );

  const result = await runDiscountMutation(
    admin,
    `#graphql
    mutation UpdateTiered($id: ID!, $discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      id: shopifyDiscountId,
      discount: {
        title: tieredDiscountTitle(campaignName),
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
    "discountAutomaticAppUpdate"
  );

  // Sin este guardia, una respuesta vacía volvería a pasar desapercibida.
  if (!(result.automaticAppDiscount as { discountId?: string } | undefined)?.discountId)
    throw new Error(
      "Shopify aceptó la actualización pero no devolvió el descuento. " +
        "La configuración puede no haberse guardado."
    );

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { config: resolved as unknown as Record<string, unknown> },
  });

  // TEMPORAL [tiered-debug]
  await logTieredDiscountState(admin, shopifyDiscountId, "tras-actualizar");
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
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeactivateTiered($id: ID!) {
      discountAutomaticDeactivate(id: $id) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticDeactivate"
  );
}

export async function activateTieredDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation ActivateTiered($id: ID!) {
      discountAutomaticActivate(id: $id) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticActivate"
  );
}

export async function deleteTieredDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeleteTiered($id: ID!) {
      discountAutomaticDelete(id: $id) {
        deletedAutomaticDiscountId
        userErrors { field message }
      }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticDelete"
  );
}
