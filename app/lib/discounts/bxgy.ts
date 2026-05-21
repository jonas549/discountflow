// Buy X Get Y campaign management via Shopify Admin API (discountAutomaticBxgyCreate).
// The discount lives in Shopify; we store shopifyDiscountId in config JSON to manage it later.

import { prisma } from "../db";
import {
  getProductsByFilter,
  getAllProductVariants,
} from "../shopify/admin-api";
import type { SelectionMode } from "./percentage";
import type { BxgyCampaignConfig } from "./bxgy-client";

export type { BxgyCampaignConfig };
export type BxgyYMode = SelectionMode | "same-as-x";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildDiscountItems(
  mode: SelectionMode,
  productIds: string[],
  collectionIds: string[]
): Record<string, unknown> {
  if (mode === "all") return { all: true };
  if (mode === "collections" && collectionIds.length > 0)
    return { collections: { collectionsToAdd: collectionIds } };
  if (productIds.length > 0)
    return { products: { productsToAdd: productIds } };
  return { all: true };
}

async function resolveToProductIds(
  admin: AdminClient,
  mode: SelectionMode,
  rawItems: string[]
): Promise<string[]> {
  if (mode === "all") {
    const all = await getAllProductVariants(admin);
    return all.map((p) => p.productId);
  }
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
  // Resolve X product IDs (tags/vendors/types need resolution; products/collections are already IDs)
  let xProductIds = config.xProductIds;
  if (
    (config.xMode === "tags" || config.xMode === "vendors" || config.xMode === "productTypes") &&
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
    (yMode === "tags" || yMode === "vendors" || yMode === "productTypes") &&
    yProductIds.length === 0
  ) {
    yProductIds = await resolveToProductIds(admin, yMode, config.yRawItems);
  }

  const xItems = buildDiscountItems(config.xMode, xProductIds, config.xCollectionIds);
  const yItems = buildDiscountItems(yMode, yProductIds, yCollectionIds);

  return { xItems, yItems, xProductIds, yProductIds };
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
          title: `[DiscountFlow] ${campaignName}`,
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
          title: `[DiscountFlow] ${campaignName}`,
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

