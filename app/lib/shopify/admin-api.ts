// Admin GraphQL API helpers for product variant price management.

export type VariantPrice = {
  id: string;
  price: string;
  compareAtPrice: string | null;
};

export type ProductVariants = {
  productId: string;
  variants: VariantPrice[];
};

export type VariantUpdate = {
  id: string;
  price: string;
  compareAtPrice: string | null;
};

// Fetch all variants for a single product.
export async function getProductVariants(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> },
  productId: string
): Promise<VariantPrice[]> {
  const res = await admin.graphql(
    `#graphql
    query GetProductVariants($productId: ID!) {
      product(id: $productId) {
        variants(first: 250) {
          nodes {
            id
            price
            compareAtPrice
          }
        }
      }
    }`,
    { variables: { productId } }
  );
  const json = await res.json();
  return json.data?.product?.variants?.nodes ?? [];
}

// Fetch all product variants for a collection (paginates automatically).
export async function getCollectionProductVariants(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> },
  collectionId: string
): Promise<ProductVariants[]> {
  const results: ProductVariants[] = [];
  let cursor: string | null = null;

  do {
    const res = await admin.graphql(
      `#graphql
      query GetCollectionProducts($collectionId: ID!, $cursor: String) {
        collection(id: $collectionId) {
          products(first: 50, after: $cursor) {
            nodes {
              id
              variants(first: 100) {
                nodes { id price compareAtPrice }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { collectionId, cursor } }
    );
    const json = await res.json();
    const products = json.data?.collection?.products;
    for (const p of products?.nodes ?? []) {
      results.push({ productId: p.id, variants: p.variants.nodes });
    }
    cursor = products?.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
  } while (cursor);

  return results;
}

// Fetch every product in the store (paginates automatically).
export async function getAllProductVariants(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> }
): Promise<ProductVariants[]> {
  const results: ProductVariants[] = [];
  let cursor: string | null = null;

  do {
    const res = await admin.graphql(
      `#graphql
      query GetAllProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          nodes {
            id
            variants(first: 100) {
              nodes { id price compareAtPrice }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } }
    );
    const json = await res.json();
    const products = json.data?.products;
    for (const p of products?.nodes ?? []) {
      results.push({ productId: p.id, variants: p.variants.nodes });
    }
    cursor = products?.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
  } while (cursor);

  return results;
}

// Apply bulk variant price update for a single product.
// Returns user errors if any; throws on network/API failure.
export async function bulkUpdateVariantPrices(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> },
  productId: string,
  variants: VariantUpdate[]
): Promise<{ id: string; userErrors: { field: string; message: string }[] }[]> {
  const res = await admin.graphql(
    `#graphql
    mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price compareAtPrice }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        productId,
        variants: variants.map((v) => ({
          id: v.id,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
        })),
      },
    }
  );
  const json = await res.json();
  return json.data?.productVariantsBulkUpdate ?? [];
}

// Get unique tags, vendors, and product types from the store (up to 250 products).
export async function getProductMetadata(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> }
): Promise<{ tags: string[]; vendors: string[]; productTypes: string[] }> {
  const res = await admin.graphql(`#graphql
    query GetProductMetadata {
      products(first: 250, sortKey: ID) {
        nodes { vendor productType tags }
      }
    }
  `);
  const json = await res.json();
  const nodes: Array<{ vendor: string; productType: string; tags: string[] }> =
    json.data?.products?.nodes ?? [];
  const tagsSet = new Set<string>();
  const vendorsSet = new Set<string>();
  const typesSet = new Set<string>();
  for (const p of nodes) {
    if (p.vendor) vendorsSet.add(p.vendor);
    if (p.productType) typesSet.add(p.productType);
    for (const t of p.tags ?? []) tagsSet.add(t);
  }
  return {
    tags: [...tagsSet].sort(),
    vendors: [...vendorsSet].sort(),
    productTypes: [...typesSet].filter(Boolean).sort(),
  };
}

// Fetch all products matching a Shopify filter query (paginates automatically).
// Examples: "tag:\"summer\" OR tag:\"sale\"", "vendor:\"Nike\"", "product_type:\"Shirts\""
export async function getProductsByFilter(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> },
  filterQuery: string
): Promise<ProductVariants[]> {
  const results: ProductVariants[] = [];
  let cursor: string | null = null;
  do {
    const res = await admin.graphql(
      `#graphql
      query GetFilteredProducts($q: String!, $cursor: String) {
        products(first: 50, query: $q, after: $cursor) {
          nodes {
            id
            variants(first: 100) {
              nodes { id price compareAtPrice }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { q: filterQuery, cursor } }
    );
    const json = await res.json();
    const products = json.data?.products;
    for (const p of products?.nodes ?? []) {
      results.push({ productId: p.id, variants: p.variants.nodes });
    }
    cursor = products?.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
  } while (cursor);
  return results;
}

// Fetch products by their GIDs (for hydrating saved selections in edit forms).
export type ProductPreview = { id: string; title: string; variants: Array<{ id: string }> };

export async function getProductsByIds(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> },
  ids: string[]
): Promise<ProductPreview[]> {
  if (ids.length === 0) return [];
  const batch = ids.slice(0, 250);
  const res = await admin.graphql(
    `#graphql
    query GetProductsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        ... on Product {
          id
          title
          variants(first: 100) { nodes { id } }
        }
      }
    }`,
    { variables: { ids: batch } }
  );
  const json = await res.json();
  return (json.data?.nodes ?? [])
    .filter((n: { __typename?: string; id?: string }) => n != null && n.__typename === "Product" && n.id)
    .map((n: { id: string; title: string; variants: { nodes: Array<{ id: string }> } }) => ({
      id: n.id,
      title: n.title,
      variants: n.variants?.nodes ?? [],
    }));
}

// Fetch collections by their GIDs (for hydrating saved selections in edit forms).
export type CollectionPreview = { id: string; title: string };

export async function getCollectionsByIds(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> },
  ids: string[]
): Promise<CollectionPreview[]> {
  if (ids.length === 0) return [];
  const batch = ids.slice(0, 250);
  const res = await admin.graphql(
    `#graphql
    query GetCollectionsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        ... on Collection {
          id
          title
        }
      }
    }`,
    { variables: { ids: batch } }
  );
  const json = await res.json();
  return (json.data?.nodes ?? [])
    .filter((n: { __typename?: string; id?: string }) => n != null && n.__typename === "Collection" && n.id)
    .map((n: { id: string; title: string }) => ({ id: n.id, title: n.title }));
}

// Get all collections (for the form dropdown).
export async function getCollections(
  admin: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> }
): Promise<Array<{ id: string; title: string; productsCount: number }>> {
  const res = await admin.graphql(
    `#graphql
    query GetCollections {
      collections(first: 50, sortKey: TITLE) {
        nodes {
          id
          title
          productsCount { count }
        }
      }
    }`
  );
  const json = await res.json();
  return (json.data?.collections?.nodes ?? []).map(
    (c: { id: string; title: string; productsCount: { count: number } }) => ({
      id: c.id,
      title: c.title,
      productsCount: c.productsCount?.count ?? 0,
    })
  );
}
