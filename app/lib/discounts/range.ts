import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { bulkUpdateVariantPrices } from "../shopify/admin-api";
import { PlanLimitError } from "../billing/plan-limit-error";
import {
  resolveVariants,
  type SelectionMode,
  type SelectedProductInput,
  type ResolveVariantsOpts,
} from "../shopify/resolve-variants";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

export type RangeMode = "fixedPrice" | "fixedAmount";

export type RangeCampaignConfig = {
  mode: RangeMode;
  value: number;
  selectionMode: string;
  collectionIds?: string[];
  selectedTags?: string[];
  selectedVendors?: string[];
  selectedProductTypes?: string[];
  excludedProductIds?: string[];
  enableExclusions?: boolean;
};

export type RangeCampaignOptions = {
  mode: RangeMode;
  value: number;
  selectionMode: SelectionMode;
  selectedProducts?: SelectedProductInput[];
  collectionIds?: string[];
  collectionId?: string;
  selectedTags?: string[];
  selectedVendors?: string[];
  selectedProductTypes?: string[];
  excludedVariantIds?: Set<string>;
  /**
   * Cuota de variantes que aún cabe en el plan. Si se pasa y la selección
   * resuelve más, se lanza PlanLimitError ANTES de escribir nada. Omitirlo
   * desactiva la comprobación (comportamiento anterior).
   */
  maxVariants?: number;
};

const MIN_PRICE = 1.0;

// Apply range discount: fixedPrice sets a new price for all variants,
// fixedAmount subtracts a fixed amount from each variant's current price.
// Skips variants where the new price would be >= original (fixedPrice) or < MIN_PRICE (fixedAmount).
export async function applyRangeDiscount(
  admin: AdminClient,
  campaignId: string,
  opts: RangeCampaignOptions
): Promise<{ applied: number; skipped: number; errors: string[] }> {
  const resolveOpts: ResolveVariantsOpts = {
    selectionMode: opts.selectionMode,
    selectedProducts: opts.selectedProducts,
    collectionIds: opts.collectionIds,
    collectionId: opts.collectionId,
    selectedTags: opts.selectedTags,
    selectedVendors: opts.selectedVendors,
    selectedProductTypes: opts.selectedProductTypes,
  };

  const variantBatches = await resolveVariants(admin, resolveOpts);

  // ENFORCEMENT DE PLAN — después de resolver y ANTES del bucle, que es donde
  // empiezan los upsert y las escrituras de precios. Lanzar aquí no deja rastro.
  //
  // Cuenta las variantes RESUELTAS (menos las excluidas). En modo rango algunas
  // se descartan luego dentro del bucle porque el precio no supondría descuento,
  // así que esto es una cota superior: puede bloquear un pelín antes de lo
  // estricto, nunca de más. Se prefiere así a duplicar aquí la lógica de precios,
  // que acabaría divergiendo del bucle real.
  if (opts.maxVariants !== undefined) {
    const total = variantBatches.reduce(
      (n, b) => n + b.variants.filter((v) => !opts.excludedVariantIds?.has(v.id)).length,
      0
    );
    if (total > opts.maxVariants) throw new PlanLimitError(total, opts.maxVariants);
  }

  const errors: string[] = [];
  let applied = 0;
  let skipped = 0;

  for (const { productId, variants } of variantBatches) {
    const updates = [];

    for (const variant of variants) {
      if (opts.excludedVariantIds?.has(variant.id)) continue;

      const originalPrice = parseFloat(variant.price);
      const originalCompareAtPrice = variant.compareAtPrice
        ? parseFloat(variant.compareAtPrice)
        : null;

      let newPrice: number;

      if (opts.mode === "fixedPrice") {
        // Skip if the fixed price would not be a discount
        if (opts.value >= originalPrice) {
          skipped++;
          continue;
        }
        newPrice = opts.value;
      } else {
        // fixedAmount: subtract from current price
        newPrice = originalPrice - opts.value;
        if (newPrice < MIN_PRICE) {
          skipped++;
          continue;
        }
      }

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

      updates.push({
        id: variant.id,
        price: newPrice.toFixed(2),
        compareAtPrice: originalPrice.toFixed(2),
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

  return { applied, skipped, errors };
}

// Re-apply range discount to a previously-paused campaign using stored originals.
export async function reactivateRangeDiscount(
  admin: AdminClient,
  campaignId: string
): Promise<{ applied: number; errors: string[] }> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { products: true },
  });

  const config = campaign.config as RangeCampaignConfig;
  const { mode, value } = config;

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
        let newPrice: number;
        if (mode === "fixedPrice") {
          newPrice = value < origPrice ? value : origPrice;
        } else {
          newPrice = Math.max(MIN_PRICE, origPrice - value);
        }
        return {
          id: v.shopifyVariantId!,
          price: newPrice.toFixed(2),
          compareAtPrice: origPrice.toFixed(2),
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

// Revert range discount by restoring originalPrice / originalCompareAtPrice.
export async function revertRangeDiscount(
  admin: AdminClient,
  campaignId: string
): Promise<{ reverted: number; errors: string[] }> {
  const products = await prisma.campaignProduct.findMany({
    where: { campaignId },
  });

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
