// Resolución de variantes PÁGINA A PÁGINA, con un cursor serializable.
//
// ¿Por qué no se reutiliza `resolveVariants` de resolve-variants.ts? Porque aquel
// pagina POR DENTRO y no devuelve el control hasta haber recorrido el catálogo
// entero. En una tienda de 20.000 variantes eso son ~80 consultas seguidas: se
// come el plazo de la invocación, Vercel la mata, el job reintenta desde cero y
// vuelve a morir en el mismo sitio. El job agotaría sus intentos SIN HABER
// EMPEZADO a aplicar nada.
//
// Aquí cada llamada devuelve UNA página y un cursor con el que retomar. El
// cursor va a `CampaignJob.resolveCursor` como JSON, así que la resolución
// sobrevive a que la invocación muera a mitad.
//
// resolve-variants.ts NO se toca: sigue siendo el camino del flujo síncrono
// antiguo, que es el que queda vivo cuando el flag está apagado.

import { readQueryData, type ProductVariants, type VariantPrice } from "./admin-api.ts";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

export type PagedSelection = {
  selectionMode: "products" | "collections" | "tags" | "vendors" | "productTypes" | "all";
  selectedProducts?: Array<{ id: string; variants?: Array<{ id: string }> }>;
  collectionIds?: string[];
  collectionId?: string;
  selectedTags?: string[];
  selectedVendors?: string[];
  selectedProductTypes?: string[];
};

/**
 * Estado de la resolución entre lotes.
 *   ci    → índice de la colección en curso (modo "collections", que tiene un
 *           cursor POR colección y hay que recorrerlas en orden)
 *   after → cursor de página de Shopify
 *   pi    → índice del producto en curso (modo "products", lista explícita)
 */
export type ResolveCursor = { ci?: number; after?: string | null; pi?: number };

export type ResolvePage = {
  batch: ProductVariants[];
  /** null = no queda nada por resolver. */
  next: ResolveCursor | null;
};

const PRODUCTS_PER_PAGE = 50;
const VARIANTS_PER_PRODUCT = 250;

export function parseCursor(raw: string | null | undefined): ResolveCursor {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ResolveCursor;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const serializeCursor = (c: ResolveCursor): string => JSON.stringify(c);

type PageNode = { id: string; variants: { nodes: VariantPrice[] } };
type PageResult = {
  nodes?: PageNode[];
  pageInfo?: { hasNextPage: boolean; endCursor: string };
};

const PRODUCT_FIELDS = `
  id
  variants(first: ${VARIANTS_PER_PRODUCT}) {
    nodes { id price compareAtPrice }
  }
`;

const toBatch = (page: PageResult | null): ProductVariants[] =>
  (page?.nodes ?? []).map((p) => ({ productId: p.id, variants: p.variants.nodes }));

/** Una página de la selección del merchant. */
export async function resolveNextPage(
  admin: AdminClient,
  sel: PagedSelection,
  cursor: ResolveCursor
): Promise<ResolvePage> {
  // ── Toda la tienda ─────────────────────────────────────────────────────────
  if (sel.selectionMode === "all") {
    const res = await admin.graphql(
      `#graphql
      query GetAllProducts($cursor: String) {
        products(first: ${PRODUCTS_PER_PAGE}, after: $cursor) {
          nodes { ${PRODUCT_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor: cursor.after ?? null } }
    );
    const page = readQueryData<PageResult>(await res.json(), "products", "catálogo completo");
    return {
      batch: toBatch(page),
      next: page?.pageInfo?.hasNextPage
        ? { after: page.pageInfo.endCursor }
        : null,
    };
  }

  // ── Colecciones ────────────────────────────────────────────────────────────
  if (sel.selectionMode === "collections") {
    const ids = sel.collectionIds?.length
      ? sel.collectionIds
      : sel.collectionId
      ? [sel.collectionId]
      : [];
    const ci = cursor.ci ?? 0;
    if (ci >= ids.length) return { batch: [], next: null };

    const res = await admin.graphql(
      `#graphql
      query GetCollectionProducts($collectionId: ID!, $cursor: String) {
        collection(id: $collectionId) {
          products(first: ${PRODUCTS_PER_PAGE}, after: $cursor) {
            nodes { ${PRODUCT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { collectionId: ids[ci], cursor: cursor.after ?? null } }
    );
    const collection = readQueryData<{ products?: PageResult }>(
      await res.json(),
      "collection",
      `colección ${ids[ci]}`
    );
    // Una colección borrada NO es una colección vacía: pasar por vacía aquí es
    // exactamente lo que llevaba a una campaña sin efecto (o, antes de la puerta
    // de seguridad de la Function, a una que descontaba el catálogo entero).
    if (!collection)
      throw new Error(
        `La colección ${ids[ci]} no existe o la app no tiene acceso a ella.`
      );

    const page = collection.products ?? null;
    if (page?.pageInfo?.hasNextPage)
      return { batch: toBatch(page), next: { ci, after: page.pageInfo.endCursor } };

    // Colección agotada → a la siguiente, desde el principio.
    return {
      batch: toBatch(page),
      next: ci + 1 < ids.length ? { ci: ci + 1, after: null } : null,
    };
  }

  // ── Tags / vendors / tipos: una sola consulta filtrada ─────────────────────
  if (sel.selectionMode !== "products") {
    const { field, values } =
      sel.selectionMode === "tags"
        ? { field: "tag", values: sel.selectedTags ?? [] }
        : sel.selectionMode === "vendors"
        ? { field: "vendor", values: sel.selectedVendors ?? [] }
        : { field: "product_type", values: sel.selectedProductTypes ?? [] };

    if (values.length === 0) return { batch: [], next: null };
    const q = values.map((v) => `${field}:"${v}"`).join(" OR ");

    const res = await admin.graphql(
      `#graphql
      query GetFilteredProducts($q: String!, $cursor: String) {
        products(first: ${PRODUCTS_PER_PAGE}, query: $q, after: $cursor) {
          nodes { ${PRODUCT_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { q, cursor: cursor.after ?? null } }
    );
    const page = readQueryData<PageResult>(await res.json(), "products", `filtro ${q}`);
    return {
      batch: toBatch(page),
      next: page?.pageInfo?.hasNextPage ? { after: page.pageInfo.endCursor } : null,
    };
  }

  // ── Lista explícita de productos ───────────────────────────────────────────
  // No hay paginación de Shopify que seguir: se trocea la lista del merchant.
  const list = sel.selectedProducts ?? [];
  const pi = cursor.pi ?? 0;
  if (pi >= list.length) return { batch: [], next: null };

  const slice = list.slice(pi, pi + PRODUCTS_PER_PAGE);
  const res = await admin.graphql(
    `#graphql
    query GetProductsPage($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        ... on Product { ${PRODUCT_FIELDS} }
      }
    }`,
    { variables: { ids: slice.map((p) => p.id) } }
  );
  const nodes = readQueryData<Array<(PageNode & { __typename?: string }) | null>>(
    await res.json(),
    "nodes",
    "productos seleccionados"
  );

  const wanted = new Map(
    slice.map((p) => [p.id, new Set((p.variants ?? []).map((v) => v.id))])
  );
  const batch: ProductVariants[] = [];
  for (const n of nodes ?? []) {
    if (!n || n.__typename !== "Product") continue;
    const only = wanted.get(n.id);
    const variants =
      only && only.size > 0
        ? n.variants.nodes.filter((v) => only.has(v.id))
        : n.variants.nodes;
    batch.push({ productId: n.id, variants });
  }

  return {
    batch,
    next: pi + PRODUCTS_PER_PAGE < list.length ? { pi: pi + PRODUCTS_PER_PAGE } : null,
  };
}
