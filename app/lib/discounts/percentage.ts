import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import {
  getProductVariants,
  getCollectionProductVariants,
  getAllProductVariants,
  bulkUpdateVariantPrices,
  type ProductVariants,
} from "../shopify/admin-api";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

export type SelectedProductInput = {
  id: string; // gid://shopify/Product/...
  variants?: Array<{ id: string }>; // if empty = all variants
};

export type PercentageCampaignOptions = {
  discountPercent: number;
  useCompareAtPriceAsBase: boolean;
  selectionMode: "products" | "collections" | "all";
  selectedProducts?: SelectedProductInput[];
  collectionId?: string;
  excludedVariantIds?: Set<string>;
};

// Resolve all affected variants based on selection mode.
async function resolveVariants(
  admin: AdminClient,
  opts: PercentageCampaignOptions
): Promise<ProductVariants[]> {
  if (opts.selectionMode === "all") {
    return getAllProductVariants(admin);
  }

  if (opts.selectionMode === "collections" && opts.collectionId) {
    return getCollectionProductVariants(admin, opts.collectionId);
  }

  // products mode
  const products = opts.selectedProducts ?? [];
  const result: ProductVariants[] = [];

  for (const p of products) {
    if (p.variants && p.variants.length > 0) {
      // User selected specific variants
      const allVariants = await getProductVariants(admin, p.id);
      const selectedIds = new Set(p.variants.map((v) => v.id));
      result.push({
        productId: p.id,
        variants: allVariants.filter((v) => selectedIds.has(v.id)),
      });
    } else {
      // All variants of the product
      const variants = await getProductVariants(admin, p.id);
      result.push({ productId: p.id, variants });
    }
  }

  return result;
}

// Apply a percentage discount to a campaign. Stores originals in DB and
// modifies price + compareAtPrice via Admin API.
export async function applyPercentageDiscount(
  admin: AdminClient,
  campaignId: string,
  opts: PercentageCampaignOptions
): Promise<{ applied: number; errors: string[] }> {
  const variantBatches = await resolveVariants(admin, opts);
  const errors: string[] = [];
  let applied = 0;

  for (const { productId, variants } of variantBatches) {
    const updates = [];

    for (const variant of variants) {
      if (opts.excludedVariantIds?.has(variant.id)) continue;

      const originalPrice = parseFloat(variant.price);
      const originalCompareAtPrice = variant.compareAtPrice
        ? parseFloat(variant.compareAtPrice)
        : null;

      // Store original prices in DB (skip if already stored)
      await prisma.campaignProduct.upsert({
        where: {
          campaignId_shopifyVariantId: {
            campaignId,
            shopifyVariantId: variant.id,
          },
        },
        create: {
          campaignId,
          shopifyProductId: productId,
          shopifyVariantId: variant.id,
          originalPrice: new Prisma.Decimal(originalPrice),
          originalCompareAtPrice:
            originalCompareAtPrice !== null
              ? new Prisma.Decimal(originalCompareAtPrice)
              : null,
        },
        update: {},
      });

      const basePrice =
        opts.useCompareAtPriceAsBase && originalCompareAtPrice !== null
          ? originalCompareAtPrice
          : originalPrice;

      const newPrice = basePrice * (1 - opts.discountPercent / 100);

      updates.push({
        id: variant.id,
        price: newPrice.toFixed(2),
        compareAtPrice: basePrice.toFixed(2),
      });
    }

    if (updates.length === 0) continue;

    try {
      await bulkUpdateVariantPrices(admin, productId, updates);
      applied += updates.length;
    } catch (err) {
      errors.push(`Error actualizando producto ${productId}: ${String(err)}`);
    }
  }

  return { applied, errors };
}

// Re-apply a percentage discount to a previously-paused campaign using stored
// originals and the campaign's current config JSON.
export async function reactivatePercentageDiscount(
  admin: AdminClient,
  campaignId: string
): Promise<{ applied: number; errors: string[] }> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { products: true },
  });

  const config = campaign.config as {
    discountPercent: number;
    showCompareAtPrice?: boolean;
  };
  const discountPercent = config.discountPercent;
  const useCompareAtPriceAsBase = config.showCompareAtPrice ?? false;

  const byProduct = new Map<string, typeof campaign.products>();
  for (const cp of campaign.products) {
    if (!byProduct.has(cp.shopifyProductId)) byProduct.set(cp.shopifyProductId, []);
    byProduct.get(cp.shopifyProductId)!.push(cp);
  }

  const errors: string[] = [];
  let applied = 0;

  for (const [productId, variants] of byProduct) {
    const updates = variants
      .filter((v) => v.shopifyVariantId !== null)
      .map((v) => {
        const origPrice = parseFloat(v.originalPrice?.toString() ?? "0");
        const origCap = v.originalCompareAtPrice
          ? parseFloat(v.originalCompareAtPrice.toString())
          : null;
        const base = useCompareAtPriceAsBase && origCap !== null ? origCap : origPrice;
        const newPrice = base * (1 - discountPercent / 100);
        return {
          id: v.shopifyVariantId!,
          price: newPrice.toFixed(2),
          compareAtPrice: base.toFixed(2),
        };
      });

    if (updates.length === 0) continue;

    try {
      await bulkUpdateVariantPrices(admin, productId, updates);
      applied += updates.length;
    } catch (err) {
      errors.push(`Error reactivando producto ${productId}: ${String(err)}`);
    }
  }

  return { applied, errors };
}

// Revert prices for a campaign by restoring originalPrice / originalCompareAtPrice.
export async function revertPercentageDiscount(
  admin: AdminClient,
  campaignId: string
): Promise<{ reverted: number; errors: string[] }> {
  const products = await prisma.campaignProduct.findMany({
    where: { campaignId },
  });

  // Group by productId
  const byProduct = new Map<string, typeof products>();
  for (const cp of products) {
    const key = cp.shopifyProductId;
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(cp);
  }

  const errors: string[] = [];
  let reverted = 0;

  for (const [productId, variants] of byProduct) {
    const updates = variants
      .filter((v) => v.shopifyVariantId !== null)
      .map((v) => ({
        id: v.shopifyVariantId!,
        price: v.originalPrice?.toString() ?? "0",
        compareAtPrice: v.originalCompareAtPrice?.toString() ?? null,
      }));

    try {
      await bulkUpdateVariantPrices(admin, productId, updates);
      reverted += updates.length;
    } catch (err) {
      errors.push(`Error revirtiendo producto ${productId}: ${String(err)}`);
    }
  }

  return { reverted, errors };
}
