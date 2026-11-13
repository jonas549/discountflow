// Hidrata la selección guardada de una campaña para la pantalla de editar.
// Ver `app/lib/discounts/saved-selection.ts` para el porqué.
import { getCollectionsByIds, getProductsByIds, type CollectionPreview, type ProductPreview } from "./admin-api.ts";
import { chunk, missingCount } from "../discounts/saved-selection.ts";

// El cliente admin de las rutas (AdminApiContext) y el del worker no comparten
// tipo; aquí solo se usa `graphql`, así que se acepta cualquiera de los dos.
type Admin = Parameters<typeof getProductsByIds>[0];
type AnyAdmin = unknown;

/** Productos por id, sin el tope de 250 de una sola consulta. */
export async function loadProductsByIds(admin: AnyAdmin, ids: string[]): Promise<ProductPreview[]> {
  const out: ProductPreview[] = [];
  for (const lote of chunk(ids, 250)) out.push(...(await getProductsByIds(admin as Admin, lote)));
  return out;
}

/** Colecciones por id — NO buscándolas en un listado parcial de la tienda. */
export async function loadCollectionsByIds(admin: AnyAdmin, ids: string[]): Promise<CollectionPreview[]> {
  const out: CollectionPreview[] = [];
  for (const lote of chunk(ids, 250)) out.push(...(await getCollectionsByIds(admin as Admin, lote)));
  return out;
}

export { missingCount };
