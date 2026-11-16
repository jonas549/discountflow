// Client-safe helpers for BXGY campaigns (no server imports).

export type BxgyCampaignConfig = {
  xMode: string;
  xProductIds: string[];
  xCollectionIds: string[];
  xRawItems: string[];
  xMinQuantity: number;
  xExcludeProductIds: string[];
  /**
   * Variantes sueltas de X, por producto (defecto H7). Solo figuran los
   * productos de los que el merchant eligió ALGUNAS variantes; el producto
   * sigue estando en `xProductIds`. Ausente o sin la clave = producto entero,
   * que es como se comportan todas las campañas guardadas antes.
   */
  xVariantIds?: Record<string, string[]>;
  yMode: string;
  yProductIds: string[];
  yCollectionIds: string[];
  yRawItems: string[];
  /** Lo mismo que `xVariantIds`, para Y. */
  yVariantIds?: Record<string, string[]>;
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
  | { kind: "products"; productIds: string[]; variantIds?: string[] };

/** Lo que esa punta lleva HOY en Shopify (solo al actualizar). */
export type BxgyItemsCurrent = {
  productIds: string[];
  collectionIds: string[];
  variantIds?: string[];
};

// ─── Variantes sueltas (defecto H7) ───────────────────────────────────────────

export type SeleccionDeProducto = { id: string; variants?: Array<{ id: string }> };

/**
 * De la selección del formulario, qué productos van con variantes SUELTAS.
 *
 * Un producto es parcial solo si el merchant eligió al menos una variante y
 * menos de las que el producto tiene hoy en Shopify (`totales`). En cualquier
 * otro caso va entero, igual que antes: sin variantes en la selección (el
 * selector a veces las manda vacías), con todas elegidas, o si no se sabe
 * cuántas tiene. Entero es además lo que sigue al día solo cuando el producto
 * gana una variante nueva.
 */
export function variantesParciales(
  seleccion: SeleccionDeProducto[],
  totales: ReadonlyMap<string, number>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of seleccion) {
    const elegidas = [...new Set((p.variants ?? []).map((v) => v?.id).filter(Boolean))] as string[];
    const total = totales.get(p.id);
    if (total === undefined) continue;
    if (elegidas.length > 0 && elegidas.length < total) out[p.id] = elegidas;
  }
  return out;
}

/**
 * Reparte una lista de productos en lo que viaja a Shopify: los enteros como
 * producto y los parciales como sus variantes. Sin parciales devuelve
 * exactamente el objetivo de siempre (sin la clave `variantIds`).
 */
export function targetDeProductos(
  productIds: string[],
  variantesPorProducto: Record<string, string[]> | undefined
): BxgyItemsTarget {
  const parciales = variantesPorProducto ?? {};
  const enteros: string[] = [];
  const variantIds: string[] = [];
  for (const id of productIds) {
    const vs = parciales[id];
    if (vs && vs.length > 0) variantIds.push(...vs);
    else enteros.push(id);
  }
  return variantIds.length > 0
    ? { kind: "products", productIds: enteros, variantIds }
    : { kind: "products", productIds: enteros };
}

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
    const variantesHoy = current.variantIds ?? [];
    if (current.productIds.length > 0 || variantesHoy.length > 0) {
      const quitar: Record<string, unknown> = {};
      if (current.productIds.length > 0) quitar.productsToRemove = current.productIds;
      if (variantesHoy.length > 0) quitar.productVariantsToRemove = variantesHoy;
      out.products = quitar;
    }
    return out;
  }

  const quedan = new Set(target.productIds);
  const sobran = current.productIds.filter((id) => !quedan.has(id));
  const products: Record<string, unknown> = sobran.length > 0
    ? { productsToAdd: target.productIds, productsToRemove: sobran }
    : { productsToAdd: target.productIds };
  // Variantes sueltas (H7). Las claves solo se mandan si hay algo que poner o
  // quitar: una oferta de productos enteros recibe el mismo input que antes.
  const variantes = target.variantIds ?? [];
  const quedanVariantes = new Set(variantes);
  const sobranVariantes = (current.variantIds ?? []).filter((id) => !quedanVariantes.has(id));
  if (variantes.length > 0) products.productVariantsToAdd = variantes;
  if (sobranVariantes.length > 0) products.productVariantsToRemove = sobranVariantes;
  out.products = products;
  if (current.collectionIds.length > 0) out.collections = { remove: current.collectionIds };
  return out;
}
