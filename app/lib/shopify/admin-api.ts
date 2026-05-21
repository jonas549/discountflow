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
