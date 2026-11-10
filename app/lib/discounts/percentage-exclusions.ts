// Exclusiones de las campañas de PORCENTAJE: productos sueltos + colecciones.
//
// Módulo PURO (sin red ni base): une las dos fuentes en el único formato que
// entiende el motor — un conjunto de ids de VARIANTE —, que es lo que ya leen
// `applyPercentageDiscount` (percentage.ts) y el motor de jobs (campaign-ops.ts).
// Así el motor no cambia: la exclusión por colección llega igual que siempre.
//
// La resolución de colecciones contra Shopify vive en
// `percentage-exclusions.server.ts`.

export type ExcludedProductInput = {
  id: string;
  /** Variantes elegidas en el picker. Vacío = el producto entero. */
  variants?: Array<{ id: string }>;
};

export type ResolvedProduct = {
  productId: string;
  variants: Array<{ id: string }>;
};

/**
 * Une las exclusiones.
 *
 * - Producto suelto: las variantes que el merchant marcó en el picker (el
 *   comportamiento de siempre, sin cambios).
 * - Colección: TODAS las variantes de cada producto de la colección.
 *
 * Las dos listas se SUMAN: un producto que está en las dos se excluye una vez.
 */
export function unirExclusiones(
  productos: ExcludedProductInput[],
  productosDeColecciones: ResolvedProduct[]
): Set<string> {
  const ids = new Set<string>();
  for (const p of productos) for (const v of p.variants ?? []) ids.add(v.id);
  for (const p of productosDeColecciones) for (const v of p.variants) ids.add(v.id);
  return ids;
}

/** Lee el JSON de colecciones excluidas del formulario. Cualquier cosa rara = ninguna. */
export function parseExcludedCollectionIds(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}
