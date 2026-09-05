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
import { getDiscountFunctionId, TIERED_FUNCTION_HANDLE } from "./function-id";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

/** Handle de la extensión (extensions/tiered-discount/shopify.extension.toml). */
const FUNCTION_HANDLE = TIERED_FUNCTION_HANDLE;

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
 * Busca el ID de la Function de escalonados en la tienda.
 *
 * La lógica de emparejamiento se mudó a `function-id.ts` el 2026-09-05, cuando
 * apareció la segunda Function de la app (`pack-discount`). Ver ese archivo
 * para el porqué: con dos Functions instaladas los descartes por "es la única"
 * dejan de ser seguros.
 *
 * `allowSingleFunctionFallback: true` conserva EXACTAMENTE el comportamiento
 * que hoy corre en producción: una tienda con una sola Function de descuento
 * instalada sigue resolviendo aunque el título no case. No se quita sin
 * comprobar antes, contra una tienda real, que el título casa de verdad.
 */
export async function getTieredFunctionId(admin: AdminClient): Promise<string> {
  return getDiscountFunctionId(admin, FUNCTION_HANDLE, {
    allowSingleFunctionFallback: true,
  });
}

// ─── Resolución de productos ──────────────────────────────────────────────────

/**
 * Convierte la selección del merchant en una lista explícita de product IDs,
 * que es lo único que la Function sabe interpretar.
 *
 * "all" devuelve lista VACÍA a propósito: la Function lo distingue por el campo
 * `scope` del metafield, no por el tamaño de la lista.
 *
 * 🔴 Para el resto de modos, resolver a CERO productos es un error y se lanza.
 * Una campaña por colección/tag/vendor que no abarca ningún producto no tiene
 * ningún uso legítimo: o la colección está vacía, o el filtro no casa con nada,
 * o la API falló. Guardarla en silencio es lo que creaba una campaña activa,
 * visible y sin efecto — y, antes de la puerta de seguridad de la Function,
 * una que descontaba el catálogo entero.
 */
export async function resolveTieredProductIds(
  admin: AdminClient,
  config: TieredCampaignConfig
): Promise<string[]> {
  const mode = config.selectionMode;

  if (mode === "all") return [];

  if (mode === "products") {
    const ids = config.productIds ?? [];
    if (ids.length === 0)
      throw new Error(
        "La campaña no tiene ningún producto seleccionado. Elige al menos uno."
      );
    return ids;
  }

  if (mode === "collections") {
    const ids = config.collectionIds ?? [];
    if (ids.length === 0)
      throw new Error(
        "La campaña no tiene ninguna colección seleccionada. Elige al menos una."
      );

    const seen = new Set<string>();
    for (const collectionId of ids) {
      for (const pv of await getCollectionProductVariants(admin, collectionId)) {
        seen.add(pv.productId);
      }
    }

    if (seen.size === 0)
      throw new Error(
        ids.length === 1
          ? "La colección seleccionada no contiene ningún producto. Añade productos a la colección o elige otra."
          : "Las colecciones seleccionadas no contienen ningún producto. Añade productos o elige otras."
      );

    return [...seen];
  }

  const rawItems = config.rawItems ?? [];
  const etiqueta =
    mode === "tags" ? "etiqueta" : mode === "vendors" ? "proveedor" : "tipo de producto";
  if (rawItems.length === 0)
    throw new Error(
      `La campaña no tiene ningún ${etiqueta} seleccionado. Elige al menos uno.`
    );

  const field =
    mode === "tags" ? "tag" : mode === "vendors" ? "vendor" : "product_type";
  const query = rawItems.map((v) => `${field}:"${v}"`).join(" OR ");
  const products = await getProductsByFilter(admin, query);
  const resolved = [...new Set(products.map((p) => p.productId))];

  if (resolved.length === 0)
    throw new Error(
      `Ningún producto coincide con el ${etiqueta} seleccionado. Revisa la selección.`
    );

  return resolved;
}

/**
 * Cuántos productos abarca la campaña (solo informativo, para la UI).
 *
 * Devuelve 0 en vez de propagar: `resolveTieredProductIds` lanza cuando la
 * selección no resuelve nada, y eso es correcto al guardar una campaña, pero
 * un contador de una pantalla no puede tumbar la pantalla entera.
 */
export async function countTieredProducts(
  admin: AdminClient,
  config: TieredCampaignConfig
): Promise<number> {
  try {
    if (config.selectionMode === "all")
      return (await getAllProductVariants(admin)).length;
    return (await resolveTieredProductIds(admin, config)).length;
  } catch {
    return 0;
  }
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
