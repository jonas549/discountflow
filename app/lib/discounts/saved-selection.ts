// Selección GUARDADA de una campaña de precio (Porcentaje / Rango), para volver
// a pintarla en la pantalla de editar.
//
// Por qué existe (diagnóstico del 2026-11-13, con la base de producción):
//  - La colección guardada se buscaba dentro de las primeras 50 colecciones de la
//    tienda por orden alfabético. «Rebajas» era la 62 de 67 → no aparecía.
//  - Los productos elegidos no se guardaban en la config: vivían solo en las filas
//    de precios, que nacen al APLICAR. Un borrador o una campaña programada en modo
//    productos perdía su selección.
//  - Si Shopify fallaba al hidratar, la lista quedaba vacía sin avisar.
//
// Este archivo es puro (sin BD ni red) para poder probarlo.

export type SavedSelectionConfig = {
  selectionMode?: string;
  /** Ids de producto elegidos a mano (modo "products"). Desde 2026-11-13. */
  selectedProductIds?: string[];
  collectionIds?: string[];
  /** Forma antigua: una sola colección. */
  collectionId?: string;
};

/**
 * Ids de producto a mostrar al editar. Manda la config; las filas de precios son
 * el respaldo para las campañas guardadas antes de que la config los llevara.
 */
export function savedProductIds(config: SavedSelectionConfig, rowProductIds: string[]): string[] {
  const mode = config.selectionMode ?? "products";
  if (mode !== "products") return [];
  const fromConfig = (config.selectedProductIds ?? []).filter((id) => typeof id === "string" && id);
  return fromConfig.length > 0 ? [...new Set(fromConfig)] : [...new Set(rowProductIds)];
}

/** Ids de colección guardados, aceptando la forma antigua de una sola. */
export function savedCollectionIds(config: SavedSelectionConfig): string[] {
  if (config.collectionIds?.length) return [...new Set(config.collectionIds)];
  return config.collectionId ? [config.collectionId] : [];
}

/**
 * Qué ids de producto guardar en la config al crear o editar.
 *
 * Si el formulario llega sin productos en modo "products" (no se pudo hidratar la
 * lista y el merchant guardó igual), se conservan los anteriores: perderlos
 * dejaría la campaña sin selección que mostrar la próxima vez.
 */
export function productIdsToSave(
  selectionMode: string,
  selected: Array<{ id: string }>,
  previous: string[] | undefined
): string[] {
  if (selectionMode !== "products") return [];
  if (selected.length > 0) return [...new Set(selected.map((p) => p.id))];
  return previous ?? [];
}

/** Parte una lista en tandas (la API de `nodes` admite 250 ids por consulta). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Cuántos de los ids pedidos no volvieron (fallo de Shopify o recurso borrado). */
export function missingCount(requested: string[], loaded: Array<{ id: string }>): number {
  const got = new Set(loaded.map((x) => x.id));
  return requested.filter((id) => !got.has(id)).length;
}
