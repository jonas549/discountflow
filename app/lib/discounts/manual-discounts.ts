// Productos que YA tienen un descuento puesto a mano por el merchant.
//
// Caso real (2026-11-13): una colección de 20 productos, 3 con precio comparativo
// puesto por la clienta. La campaña de Porcentaje debe aplicarse a los 17 y dejar
// esos 3 intactos, y al terminar decir cuáles saltó y por qué.
//
// Regla (decisión de Jonas): se salta el PRODUCTO ENTERO si ALGUNA de sus
// variantes tiene precio comparativo mayor que su precio y esa rebaja no la puso
// otra campaña activa de DiscountFlow.
//
// Archivo puro (sin BD ni red) para poder probarlo.

export type VariantForCheck = {
  id: string;
  price: string;
  compareAtPrice?: string | null;
};

/** ¿Esta variante se ve rebajada en la tienda? (comparativo > precio) */
export function looksDiscounted(v: VariantForCheck): boolean {
  if (v.compareAtPrice == null || v.compareAtPrice === "") return false;
  const price = Number.parseFloat(v.price);
  const compare = Number.parseFloat(v.compareAtPrice);
  if (!Number.isFinite(price) || !Number.isFinite(compare)) return false;
  // Un comparativo igual o menor que el precio no es una rebaja: Shopify no lo
  // muestra tachado.
  return compare > price;
}

/**
 * ¿El producto tiene un descuento puesto a mano?
 *
 * `ownVariantIds` = variantes que hoy están rebajadas por OTRA campaña activa de
 * DiscountFlow. Su precio comparativo lo puso la app, no el merchant, así que no
 * cuentan como descuento manual.
 */
export function hasManualDiscount(
  variants: VariantForCheck[],
  ownVariantIds: ReadonlySet<string>
): boolean {
  return variants.some((v) => looksDiscounted(v) && !ownVariantIds.has(v.id));
}

export type SkippedProduct = {
  /** GID del producto. */
  id: string;
  title: string | null;
  /** Precio y comparativo de la primera variante rebajada a mano, tal como estaban. */
  price: string;
  compareAtPrice: string;
  /** Cuántas variantes tiene el producto (se saltaron todas). */
  variants: number;
};

export type SkipReport = {
  reason: "manual-discount";
  /** Total de productos salteados (puede superar a `products.length`). */
  total: number;
  products: SkippedProduct[];
  /** true si la lista se cortó en el tope. */
  truncated: boolean;
  /** Cuándo se generó (ISO). */
  at: string;
};

/** Tope de productos listados en el reporte. El total se cuenta siempre entero. */
export const SKIP_REPORT_CAP = 200;

export function describeSkipped(
  product: { productId: string; title?: string | null; variants: VariantForCheck[] },
  ownVariantIds: ReadonlySet<string>
): SkippedProduct {
  const culpable =
    product.variants.find((v) => looksDiscounted(v) && !ownVariantIds.has(v.id)) ?? product.variants[0];
  return {
    id: product.productId,
    title: product.title ?? null,
    price: culpable?.price ?? "",
    compareAtPrice: culpable?.compareAtPrice ?? "",
    variants: product.variants.length,
  };
}

/** Suma una tanda de salteados al reporte acumulado (la resolución va por páginas). */
export function appendSkipped(prev: SkipReport | null, items: SkippedProduct[], at: Date): SkipReport | null {
  if (items.length === 0) return prev;
  const ya = new Set((prev?.products ?? []).map((p) => p.id));
  const nuevos = items.filter((p) => !ya.has(p.id));
  const products = [...(prev?.products ?? []), ...nuevos].slice(0, SKIP_REPORT_CAP);
  const total = (prev?.total ?? 0) + nuevos.length;
  return {
    reason: "manual-discount",
    total,
    products,
    truncated: total > products.length,
    at: at.toISOString(),
  };
}

/** Lee el reporte guardado en la base sin fiarse de su forma. */
export function readSkipReport(raw: unknown): SkipReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Partial<SkipReport>;
  if (r.reason !== "manual-discount" || !Array.isArray(r.products)) return null;
  const total = typeof r.total === "number" ? r.total : r.products.length;
  if (total <= 0) return null;
  return {
    reason: "manual-discount",
    total,
    products: r.products.filter((p) => p && typeof p.id === "string"),
    truncated: r.truncated === true,
    at: typeof r.at === "string" ? r.at : "",
  };
}

/** "8123456789" a partir del GID: es el número que se ve en la URL del producto. */
export const productNumericId = (gid: string): string => gid.split("/").pop() ?? gid;
