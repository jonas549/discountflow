// Buy X Get Y campaign management via Shopify Admin API (discountAutomaticBxgyCreate).
// The discount lives in Shopify; we store shopifyDiscountId in config JSON to manage it later.

import { prisma } from "../db";
import {
  getProductsByFilter,
} from "../shopify/admin-api";
import { es } from "../../i18n";
import type { SelectionMode } from "./percentage";
import { bxgyDiscountTitle, type BxgyCampaignConfig } from "./bxgy-client";

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

function buildDiscountItems(
  mode: SelectionMode,
  productIds: string[],
  collectionIds: string[]
): Record<string, unknown> {
  // NOTE: { all: true } is NOT supported for BXGY discounts (Shopify API limitation).
  // Por eso el modo "toda la tienda" se retiró de BxGy: obligaba a resolver el
  // catálogo a ids explícitos, y esa lista topa en MAX_PRODUCTOS_BXGY.
  // Las colecciones son la alternativa: viajan como ids de colección, sin tope.
  if (mode === "collections" && collectionIds.length > 0)
    return { collections: { add: collectionIds } };
  if (productIds.length > 0)
    return { products: { productsToAdd: productIds } };
  return { products: { productsToAdd: [] } };
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

  // Resolve Y
  let yMode: SelectionMode = config.yMode === "same-as-x" ? config.xMode : (config.yMode as SelectionMode);
  let yProductIds = config.yMode === "same-as-x" ? xProductIds : config.yProductIds;
  let yCollectionIds = config.yMode === "same-as-x" ? config.xCollectionIds : config.yCollectionIds;

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
  exigirDentroDelTope(xProductIds);
  if (config.yMode !== "same-as-x") exigirDentroDelTope(yProductIds);

  const xItems = buildDiscountItems(config.xMode, xProductIds, config.xCollectionIds);
  const yItems = buildDiscountItems(yMode, yProductIds, yCollectionIds);

  return { xItems, yItems, xProductIds, yProductIds };
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
  const { xItems, yItems, xProductIds, yProductIds } = await resolveItems(admin, config);

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
  const { xItems, yItems, xProductIds, yProductIds } = await resolveItems(admin, config);

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

