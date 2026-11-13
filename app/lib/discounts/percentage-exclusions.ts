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
  /**
   * Variantes elegidas en el picker. Vacío o ausente = el producto ENTERO.
   *
   * 🔴 Eso lo cumple `resolverExclusiones`, no `unirExclusiones`: para excluir el
   * producto entero hay que leer sus variantes de Shopify. Hasta el 2026-11-13
   * un producto que llegaba sin variantes NO excluía nada, en silencio (7 de 17
   * productos de una campaña real se rebajaron estando marcados como excluidos).
   */
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

/** Un producto que llegó del formulario sin variantes elegidas. */
export const sinVariantesElegidas = (p: ExcludedProductInput) =>
  !Array.isArray(p.variants) || p.variants.length === 0;

/**
 * Arma el conjunto completo de variantes a excluir, leyendo de Shopify lo que
 * haga falta. Los lectores llegan por parámetro para poder probarlo sin red.
 *
 * - Colección: todas las variantes de sus productos.
 * - Producto con variantes elegidas: esas variantes (como siempre).
 * - Producto SIN variantes: se leen todas las suyas → se excluye entero.
 *
 * 🔴 Falla CERRADO: si un lector lanza, o si un producto sin variantes elegidas
 * vuelve de Shopify sin ninguna, esto LANZA. Quien llama lo invoca antes de
 * tocar precios, así que el merchant ve el error en vez de una campaña que
 * rebaja justo lo que quiso dejar afuera.
 */
export async function resolverExclusiones(input: {
  productos: ExcludedProductInput[];
  collectionIds: string[];
  leerColeccion: (collectionId: string) => Promise<ResolvedProduct[]>;
  leerProducto: (productId: string) => Promise<Array<{ id: string }>>;
}): Promise<Set<string>> {
  const enteros: ResolvedProduct[] = [];
  for (const id of input.collectionIds) {
    for (const p of await input.leerColeccion(id)) {
      enteros.push({ productId: p.productId, variants: p.variants });
    }
  }
  for (const p of input.productos) {
    if (!sinVariantesElegidas(p)) continue;
    const variants = await input.leerProducto(p.id);
    if (variants.length === 0)
      throw new Error(
        `El producto excluido ${p.id} no devolvió ninguna variante: no se puede excluir.`
      );
    enteros.push({ productId: p.id, variants });
  }
  return unirExclusiones(input.productos, enteros);
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
