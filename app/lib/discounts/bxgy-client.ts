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

// ─── Qué productos lleva la oferta en Shopify ─────────────────────────────────

/** Lo que una punta de la oferta (X o Y) tiene que llevar en Shopify. */
export type BxgyItemsTarget =
  | { kind: "collections"; collectionIds: string[] }
  | { kind: "products"; productIds: string[] };

/** Lo que esa punta lleva HOY en Shopify (solo al actualizar). */
export type BxgyItemsCurrent = { productIds: string[]; collectionIds: string[] };

/** Quita de la lista los productos excluidos, sin alterar el orden. */
export function quitarExcluidos(productIds: string[], excluidos: readonly string[]): string[] {
  if (excluidos.length === 0) return productIds;
  const fuera = new Set(excluidos);
  return productIds.filter((id) => !fuera.has(id));
}

/**
 * El `DiscountItemsInput` que deja la punta EXACTAMENTE como dice `target`.
 *
 * 🔴 En Shopify, actualizar una oferta BxGy es INCREMENTAL (medido contra la API
 * el 2026-11-15): `productsToAdd` suma a lo que ya había y no quita nada, y
 * pasar de colección a productos sin retirar la colección se rechaza con
 * «Cannot have collection prerequisites in combination with product
 * prerequisites». Por eso, al actualizar, se manda también lo que hay que
 * QUITAR: todo lo que la oferta lleva hoy y ya no está en el objetivo. Sin eso,
 * un producto que el merchant saca (o excluye) seguía activando la oferta.
 *
 * Quitar algo que ya no estaba no es un error para Shopify.
 */
export function bxgyItemsInput(
  target: BxgyItemsTarget,
  current: BxgyItemsCurrent = { productIds: [], collectionIds: [] }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (target.kind === "collections") {
    const quedan = new Set(target.collectionIds);
    const sobran = current.collectionIds.filter((id) => !quedan.has(id));
    out.collections = sobran.length > 0
      ? { add: target.collectionIds, remove: sobran }
      : { add: target.collectionIds };
    if (current.productIds.length > 0) out.products = { productsToRemove: current.productIds };
    return out;
  }

  const quedan = new Set(target.productIds);
  const sobran = current.productIds.filter((id) => !quedan.has(id));
  out.products = sobran.length > 0
    ? { productsToAdd: target.productIds, productsToRemove: sobran }
    : { productsToAdd: target.productIds };
  if (current.collectionIds.length > 0) out.collections = { remove: current.collectionIds };
  return out;
}
