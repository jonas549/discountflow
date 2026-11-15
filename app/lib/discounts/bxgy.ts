// Buy X Get Y campaign management via Shopify Admin API (discountAutomaticBxgyCreate).
// The discount lives in Shopify; we store shopifyDiscountId in config JSON to manage it later.

import { prisma } from "../db";
import {
  getProductsByFilter,
  readQueryData,
} from "../shopify/admin-api";
import { es } from "../../i18n";
import type { SelectionMode } from "./percentage";
import {
  bxgyDiscountTitle,
  bxgyItemsInput,
  quitarExcluidos,
  type BxgyCampaignConfig,
  type BxgyItemsCurrent,
  type BxgyItemsTarget,
} from "./bxgy-client";

export type { BxgyCampaignConfig };
export type BxgyYMode = SelectionMode | "same-as-x";

/**
 * Tope de Shopify para `DiscountProductsInput.productsToAdd` en una oferta BxGy.
 * Superarlo devuelve: «The input array size of N is greater than the maximum
 * allowed of 250».
 *
 * 🔴 Es exclusivo de BxGy. Porcentaje y Rango no pasan por aquí (editan precios
 * de variantes) y Escalonados tampoco (manda su lista en un metafield JSON).
 *
 * Las COLECCIONES no cuentan contra este tope: viajan como ids de colección
 * (`collections.add`), una sola entrada por colección, y Shopify las resuelve en
 * vivo. Por eso son la salida recomendada para catálogos grandes.
 */
export const MAX_PRODUCTOS_BXGY = 250;

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

// NOTE: { all: true } is NOT supported for BXGY discounts (Shopify API limitation).
// Por eso el modo "toda la tienda" se retiró de BxGy: obligaba a resolver el
// catálogo a ids explícitos, y esa lista topa en MAX_PRODUCTOS_BXGY.
// Las colecciones son la alternativa: viajan como ids de colección, sin tope.
function targetDe(
  mode: SelectionMode,
  productIds: string[],
  collectionIds: string[]
): BxgyItemsTarget {
  if (mode === "collections" && collectionIds.length > 0)
    return { kind: "collections", collectionIds };
  return { kind: "products", productIds };
}

/**
 * Los productos de unas colecciones, como ids. Deja de pedir páginas en cuanto
 * supera `tope`: a partir de ahí el resultado ya no cabe en una oferta BxGy y lo
 * único que falta es decírselo al merchant.
 */
async function productosDeColecciones(
  admin: AdminClient,
  collectionIds: string[],
  tope: number
): Promise<string[]> {
  const ids = new Set<string>();
  for (const collectionId of collectionIds) {
    let cursor: string | null = null;
    do {
      const res = await admin.graphql(
        `#graphql
        query DfBxgyCollectionProductIds($id: ID!, $cursor: String) {
          collection(id: $id) {
            products(first: 250, after: $cursor) {
              nodes { id }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { variables: { id: collectionId, cursor } }
      );
      const collection: {
        products?: {
          nodes?: Array<{ id: string }>;
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      } | null = readQueryData(await res.json(), "collection", `colección ${collectionId}`);
      // Una colección borrada NO es una colección vacía (ver admin-api.ts).
      if (!collection)
        throw new Error(`La colección ${collectionId} no existe o la app no tiene acceso a ella.`);
      for (const n of collection.products?.nodes ?? []) ids.add(n.id);
      if (ids.size > tope) return [...ids];
      cursor = collection.products?.pageInfo?.hasNextPage
        ? collection.products.pageInfo.endCursor
        : null;
    } while (cursor);
  }
  return [...ids];
}

type ItemsDeShopify =
  | {
      products?: { nodes?: Array<{ id: string }> };
      collections?: { nodes?: Array<{ id: string }> };
    }
  | null
  | undefined;

/**
 * Qué productos y colecciones lleva HOY la oferta en Shopify, en X y en Y.
 * Hace falta para actualizar: Shopify solo suma lo que se le manda, así que lo
 * que sobra hay que pedirle que lo quite (ver `bxgyItemsInput`).
 *
 * Dos consultas y no una: cada punta puede traer 250 ids y juntas pasarían el
 * coste máximo de una sola consulta.
 */
async function itemsActuales(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<{ x: BxgyItemsCurrent; y: BxgyItemsCurrent }> {
  const leer = async (punta: "customerBuys" | "customerGets"): Promise<BxgyItemsCurrent> => {
    const res = await admin.graphql(
      `#graphql
      query DfBxgyItemsActuales($id: ID!) {
        automaticDiscountNode(id: $id) {
          automaticDiscount {
            ... on DiscountAutomaticBxgy {
              ${punta} {
                items {
                  ... on DiscountProducts { products(first: 250) { nodes { id } } }
                  ... on DiscountCollections { collections(first: 250) { nodes { id } } }
                }
              }
            }
          }
        }
      }`,
      { variables: { id: shopifyDiscountId } }
    );
    const nodo: {
      automaticDiscount?: Record<string, { items?: ItemsDeShopify } | undefined>;
    } | null = readQueryData(
      await res.json(),
      "automaticDiscountNode",
      `descuento ${shopifyDiscountId}`
    );
    const items = nodo?.automaticDiscount?.[punta]?.items;
    return {
      productIds: (items?.products?.nodes ?? []).map((n) => n.id),
      collectionIds: (items?.collections?.nodes ?? []).map((n) => n.id),
    };
  };
  return { x: await leer("customerBuys"), y: await leer("customerGets") };
}

async function resolveToProductIds(
  admin: AdminClient,
  mode: SelectionMode,
  rawItems: string[]
): Promise<string[]> {
  // «Toda la tienda» ya no se ofrece en BxGy: resolvía el catálogo entero a ids
  // explícitos y cualquier tienda con más de 250 productos rompía. Se rechaza
  // también aquí, y no solo en el formulario, porque la ruta no es la única
  // puerta de entrada (un POST a mano llegaría igual).
  if (mode === "all") throw new Error(es.nuevaBxgy.errModoTiendaNoDisponible);
  if (mode === "tags" && rawItems.length > 0) {
    const q = rawItems.map((t) => `tag:"${t}"`).join(" OR ");
    return (await getProductsByFilter(admin, q)).map((p) => p.productId);
  }
  if (mode === "vendors" && rawItems.length > 0) {
    const q = rawItems.map((v) => `vendor:"${v}"`).join(" OR ");
    return (await getProductsByFilter(admin, q)).map((p) => p.productId);
  }
  if (mode === "productTypes" && rawItems.length > 0) {
    const q = rawItems.map((t) => `product_type:"${t}"`).join(" OR ");
    return (await getProductsByFilter(admin, q)).map((p) => p.productId);
  }
  return [];
}

// Resolve X and Y items to the format needed by the Shopify API.
async function resolveItems(admin: AdminClient, config: BxgyCampaignConfig) {
  // tags, vendors y productTypes se resuelven a ids explícitos. "all" sigue en la
  // condición a propósito: una campaña legada guardada con ese modo entra aquí y
  // `resolveToProductIds` lanza con un mensaje claro en vez de rehacer el
  // catálogo entero. Si la campaña legada ya trae sus ids resueltos y son 250 o
  // menos, sigue funcionando: solo la corta el guard del tope.
  let xProductIds = config.xProductIds;
  if (
    (config.xMode === "all" || config.xMode === "tags" || config.xMode === "vendors" || config.xMode === "productTypes") &&
    xProductIds.length === 0
  ) {
    xProductIds = await resolveToProductIds(admin, config.xMode, config.xRawItems);
  }

  // ── Exclusiones de X (QA 2026-11-14, defecto H3) ──────────────────────────
  // Shopify no tiene «todos menos éstos» en una oferta BxGy: la única forma de
  // excluir un producto es no mandarlo. Antes la exclusión se guardaba y se
  // mostraba al editar, pero nunca llegaba al descuento.
  //
  // Lo que se GUARDA en la configuración (`xProductIds`) sigue siendo la
  // selección del merchant sin filtrar: si se guardara ya filtrada, al editar
  // el producto excluido desaparecería también de la selección.
  const excluidos = config.xExcludeProductIds ?? [];
  const xPorColeccion = config.xMode === "collections" && config.xCollectionIds.length > 0;
  let xTarget: BxgyItemsTarget;
  if (excluidos.length === 0) {
    xTarget = targetDe(config.xMode as SelectionMode, xProductIds, config.xCollectionIds);
  } else {
    // Una colección viaja como id y Shopify la resuelve en vivo, así que con
    // exclusiones hay que abrirla aquí y mandar sus productos uno por uno.
    const candidatos = xPorColeccion
      ? await productosDeColecciones(
          admin,
          config.xCollectionIds,
          MAX_PRODUCTOS_BXGY + excluidos.length
        )
      : xProductIds;
    const efectivos = quitarExcluidos(candidatos, excluidos);
    if (efectivos.length === 0) throw new Error(es.nuevaBxgy.errExclusionVaciaX);
    if (xPorColeccion && efectivos.length > MAX_PRODUCTOS_BXGY)
      throw new Error(es.nuevaBxgy.errLimiteConExclusiones);
    xTarget = { kind: "products", productIds: efectivos };
  }

  // Resolve Y. «Los mismos que X» son los que de verdad activan la oferta: un
  // producto excluido de X tampoco se regala.
  const yMode: SelectionMode = config.yMode === "same-as-x" ? (config.xMode as SelectionMode) : (config.yMode as SelectionMode);
  let yProductIds = config.yMode === "same-as-x" ? xProductIds : config.yProductIds;
  const yCollectionIds = config.yMode === "same-as-x" ? config.xCollectionIds : config.yCollectionIds;

  if (
    config.yMode !== "same-as-x" &&
    (yMode === "all" || yMode === "tags" || yMode === "vendors" || yMode === "productTypes") &&
    yProductIds.length === 0
  ) {
    yProductIds = await resolveToProductIds(admin, yMode, config.yRawItems);
  }

  // Guard del tope de Shopify. Se comprueba ANTES de llamar a la mutación para
  // que el merchant lea qué pasó y qué hacer, en vez del error crudo de la API
  // («The input array size of 1065 is greater than the maximum allowed of 250»),
  // que además llegaba después de resolver el catálogo entero.
  //
  // Solo aplica a las listas de PRODUCTOS. Una selección por colecciones pasa por
  // aquí con la lista vacía y nunca topa, que es justo la salida que ofrece el
  // mensaje.
  const yTarget: BxgyItemsTarget =
    config.yMode === "same-as-x" ? xTarget : targetDe(yMode, yProductIds, yCollectionIds);

  if (xTarget.kind === "products") exigirDentroDelTope(xTarget.productIds);
  if (config.yMode !== "same-as-x" && yTarget.kind === "products")
    exigirDentroDelTope(yTarget.productIds);

  return { xTarget, yTarget, xProductIds, yProductIds };
}

function exigirDentroDelTope(productIds: string[]): void {
  if (productIds.length > MAX_PRODUCTOS_BXGY)
    throw new Error(es.nuevaBxgy.errLimiteProductos(productIds.length));
}

function discountEffect(config: BxgyCampaignConfig) {
  return {
    percentage: config.discountType === "free" ? 1.0 : config.discountValue / 100,
  };
}

// ─── Create ────────────────────────────────────────────────────────────────────

export async function createBxgyDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  config: BxgyCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<string> {
  const { xTarget, yTarget, xProductIds, yProductIds } = await resolveItems(admin, config);
  const xItems = bxgyItemsInput(xTarget);
  const yItems = bxgyItemsInput(yTarget);

  const res = await admin.graphql(
    `#graphql
    mutation CreateBxgy($discount: DiscountAutomaticBxgyInput!) {
      discountAutomaticBxgyCreate(automaticBxgyDiscount: $discount) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        discount: {
          title: bxgyDiscountTitle(campaignName),
          startsAt: (startsAt ?? new Date()).toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          customerBuys: {
            value: { quantity: String(config.xMinQuantity) },
            items: xItems,
          },
          customerGets: {
            value: {
              discountOnQuantity: {
                quantity: String(config.yQuantity),
                effect: discountEffect(config),
              },
            },
            items: yItems,
          },
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
        },
      },
    }
  );

  const json = await res.json();
  const result = json.data?.discountAutomaticBxgyCreate;
  if (result?.userErrors?.length > 0) {
    throw new Error(
      result.userErrors.map((e: { message: string }) => e.message).join(", ")
    );
  }

  const shopifyDiscountId: string = result?.automaticDiscountNode?.id;
  if (!shopifyDiscountId) throw new Error("Shopify no retornó un ID de descuento");

  // Persist resolved IDs + shopifyDiscountId back into campaign config
  const updatedConfig: BxgyCampaignConfig = {
    ...config,
    xProductIds,
    yProductIds,
    shopifyDiscountId,
  };
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { config: updatedConfig as unknown as Record<string, unknown> },
  });

  return shopifyDiscountId;
}

// ─── Update ────────────────────────────────────────────────────────────────────

export async function updateBxgyDiscount(
  admin: AdminClient,
  shopifyDiscountId: string,
  campaignId: string,
  campaignName: string,
  config: BxgyCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<void> {
  const { xTarget, yTarget, xProductIds, yProductIds } = await resolveItems(admin, config);
  // Actualizar es incremental en Shopify: hay que decirle también qué quitar.
  const actual = await itemsActuales(admin, shopifyDiscountId);
  const xItems = bxgyItemsInput(xTarget, actual.x);
  const yItems = bxgyItemsInput(yTarget, actual.y);

  const res = await admin.graphql(
    `#graphql
    mutation UpdateBxgy($id: ID!, $discount: DiscountAutomaticBxgyInput!) {
      discountAutomaticBxgyUpdate(id: $id, automaticBxgyDiscount: $discount) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        id: shopifyDiscountId,
        discount: {
          title: bxgyDiscountTitle(campaignName),
          startsAt: (startsAt ?? new Date()).toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          customerBuys: {
            value: { quantity: String(config.xMinQuantity) },
            items: xItems,
          },
          customerGets: {
            value: {
              discountOnQuantity: {
                quantity: String(config.yQuantity),
                effect: discountEffect(config),
              },
            },
            items: yItems,
          },
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
        },
      },
    }
  );

  const json = await res.json();
  const errors = json.data?.discountAutomaticBxgyUpdate?.userErrors;
  if (errors?.length > 0) {
    throw new Error(errors.map((e: { message: string }) => e.message).join(", "));
  }

  const updatedConfig: BxgyCampaignConfig = {
    ...config,
    xProductIds,
    yProductIds,
    shopifyDiscountId,
  };
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { config: updatedConfig as unknown as Record<string, unknown> },
  });
}

// ─── Deactivate (pause) ────────────────────────────────────────────────────────

export async function deactivateBxgyDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  const res = await admin.graphql(
    `#graphql
    mutation DeactivateBxgy($id: ID!) {
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

// ─── Activate (reactivate) ─────────────────────────────────────────────────────

export async function activateBxgyDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  const res = await admin.graphql(
    `#graphql
    mutation ActivateBxgy($id: ID!) {
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

// ─── Delete ────────────────────────────────────────────────────────────────────

export async function deleteBxgyDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  const res = await admin.graphql(
    `#graphql
    mutation DeleteBxgy($id: ID!) {
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

