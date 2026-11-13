import { getCollectionProductVariants, readQueryData } from "../shopify/admin-api";
import {
  resolverExclusiones,
  type ExcludedProductInput,
} from "./percentage-exclusions";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

/**
 * Todas las variantes de un producto, o LANZA.
 *
 * No se usa `getProductVariants` a propósito: ese helper devuelve una lista
 * vacía ante cualquier fallo, y aquí una lista vacía significaría «no excluyas
 * nada» — el fallo caro. Un producto que no se puede leer no es un producto sin
 * variantes.
 */
async function leerVariantesDeProducto(
  admin: AdminClient,
  productId: string
): Promise<Array<{ id: string }>> {
  const ids: Array<{ id: string }> = [];
  let cursor: string | null = null;
  do {
    const res: Response = await admin.graphql(
      `#graphql
      query VariantesDeProductoExcluido($productId: ID!, $cursor: String) {
        product(id: $productId) {
          variants(first: 250, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { productId, cursor } }
    );
    const json = await res.json();
    const product = readQueryData<{
      variants?: {
        nodes?: Array<{ id: string }>;
        pageInfo?: { hasNextPage: boolean; endCursor: string };
      };
    }>(json, "product", `producto excluido ${productId}`);
    if (!product)
      throw new Error(
        `El producto excluido ${productId} no existe o la app no tiene acceso a él.`
      );
    ids.push(...(product.variants?.nodes ?? []));
    cursor = product.variants?.pageInfo?.hasNextPage
      ? product.variants.pageInfo.endCursor
      : null;
  } while (cursor);
  return ids;
}

/**
 * Ids de variante a excluir de una campaña de Porcentaje: productos sueltos +
 * todos los productos de las colecciones excluidas.
 *
 * 🔴 Lo usan las DOS pantallas (crear y editar) y el resultado alimenta los DOS
 * caminos (síncrono y motor de jobs). Un solo sitio = la misma regla en todos.
 *
 * Un producto suelto que llega SIN variantes elegidas se excluye ENTERO (se leen
 * sus variantes de Shopify). Ver `resolverExclusiones`.
 *
 * Lanza si una colección o un producto no existe o no se puede leer: algo
 * ilegible NO es algo vacío. Tratarlo como vacío rebajaría justo los productos
 * que el merchant quiso dejar afuera. Quien llama tiene que invocarlo ANTES de
 * tocar precios.
 *
 * Es una FOTO del momento de guardar: un producto que entre después en la
 * colección no queda excluido hasta volver a guardar la campaña.
 */
export async function resolverVariantesExcluidas(
  admin: AdminClient,
  productos: ExcludedProductInput[],
  collectionIds: string[]
): Promise<Set<string>> {
  return resolverExclusiones({
    productos,
    collectionIds,
    leerColeccion: (id) => getCollectionProductVariants(admin, id),
    leerProducto: (id) => leerVariantesDeProducto(admin, id),
  });
}
