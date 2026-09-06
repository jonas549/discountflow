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
  discountType: "free" | "percentage";
  discountValue: number;
  shopifyDiscountId?: string;
};

export const BXGY_TITLE_PREFIX = "[DiscountFlow] ";

/**
 * El título con el que vive el descuento BXGY dentro de Shopify.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 EXISTE PORQUE ESTE PREFIJO, ESCRITO A MANO EN DOS SITIOS, HIZO QUE BXGY NO
 * ATRIBUYERA UN SOLO PEDIDO EN TODA LA VIDA DE LA APP.
 *
 * El descuento se creaba con `[DiscountFlow] <nombre>` (commit cfbe02e, el que
 * trajo BxGy). Ocho commits después, el webhook de pedidos buscaba la campaña
 * comparando el título contra `campaign.name`, **sin el prefijo**, con este
 * comentario al lado: *"y title igual al nombre de la campaña en DiscountFlow"*.
 * La comparación es exacta, así que nunca coincidió: cero filas, cero errores,
 * cero atribuciones, y un dashboard que decía "0 pedidos · ROI N/A" mientras el
 * descuento se aplicaba perfecto en el checkout.
 *
 * Ahora las dos puntas —la que crea el descuento y la que lo reconoce en el
 * pedido— llaman a esta función. No pueden divergir sin que se caiga un test.
 *
 * ⚠️ Cambiar este texto **renombra el descuento en la tienda del merchant** y
 * deja de reconocer los pedidos de los descuentos ya creados con el nombre
 * viejo. No se toca.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function bxgyDiscountTitle(campaignName: string): string {
  return `${BXGY_TITLE_PREFIX}${campaignName}`;
}

export function bxgyDiscountLabel(config: BxgyCampaignConfig): string {
  const xQty = config.xMinQuantity ?? 1;
  const yQty = config.yQuantity ?? 1;
  if (config.discountType === "free") return `Compra ${xQty}, lleva ${yQty} GRATIS`;
  return `Compra ${xQty}, lleva ${yQty} al ${config.discountValue ?? 0}%`;
}
