import { getCollectionProductVariants } from "../shopify/admin-api";
import {
  unirExclusiones,
  type ExcludedProductInput,
  type ResolvedProduct,
} from "./percentage-exclusions";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

/**
 * Ids de variante a excluir de una campaña de Porcentaje: productos sueltos +
 * todos los productos de las colecciones excluidas.
 *
 * 🔴 Lo usan las DOS pantallas (crear y editar) y el resultado alimenta los DOS
 * caminos (síncrono y motor de jobs). Un solo sitio = la misma regla en todos.
 *
 * Lanza si una colección no existe o no se puede leer (`getCollectionProductVariants`
 * ya lo hace): una colección ilegible NO es una colección vacía. Tratarla como
 * vacía rebajaría justo los productos que el merchant quiso dejar afuera.
 * Quien llama tiene que invocarlo ANTES de tocar precios.
 *
 * Es una FOTO del momento de guardar: un producto que entre después en la
 * colección no queda excluido hasta volver a guardar la campaña.
 */
export async function resolverVariantesExcluidas(
  admin: AdminClient,
  productos: ExcludedProductInput[],
  collectionIds: string[]
): Promise<Set<string>> {
  const deColecciones: ResolvedProduct[] = [];
  for (const id of collectionIds) {
    for (const p of await getCollectionProductVariants(admin, id)) {
      deColecciones.push({ productId: p.productId, variants: p.variants });
    }
  }
  return unirExclusiones(productos, deColecciones);
}
