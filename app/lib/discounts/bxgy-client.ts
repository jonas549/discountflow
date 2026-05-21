// Client-safe helpers for BXGY campaigns (no server imports).

export type BxgyCampaignConfig = {
  xMode: string;
  xProductIds: string[];
  xCollectionIds: string[];
  xRawItems: string[];
  xMinQuantity: number;
  xExcludeProductIds: string[];
  yMode: string;
  yProductIds: string[];
  yCollectionIds: string[];
  yRawItems: string[];
  yQuantity: number;
  discountType: "free" | "percentage" | "freeShipping";
  discountValue: number;
  shopifyDiscountId?: string;
};

export function bxgyDiscountLabel(config: BxgyCampaignConfig): string {
  const xQty = config.xMinQuantity ?? 1;
  const yQty = config.yQuantity ?? 1;
  if (config.discountType === "freeShipping") return `Compra ${xQty}, envío gratis`;
  if (config.discountType === "free") return `Compra ${xQty}, lleva ${yQty} GRATIS`;
  return `Compra ${xQty}, lleva ${yQty} al ${config.discountValue ?? 0}%`;
}
