import {
  getProductVariants,
  getCollectionProductVariants,
  getAllProductVariants,
  getProductsByFilter,
  type ProductVariants,
} from "./admin-api";

type AdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
};

export type SelectionMode =
  | "products"
  | "collections"
  | "tags"
  | "vendors"
  | "productTypes"
  | "all";

export type SelectedProductInput = {
  id: string;
  variants?: Array<{ id: string }>;
};

export type ResolveVariantsOpts = {
  selectionMode: SelectionMode;
  selectedProducts?: SelectedProductInput[];
  collectionIds?: string[];
  collectionId?: string;
  selectedTags?: string[];
  selectedVendors?: string[];
  selectedProductTypes?: string[];
};

export async function resolveVariants(
  admin: AdminClient,
  opts: ResolveVariantsOpts
): Promise<ProductVariants[]> {
  if (opts.selectionMode === "all") return getAllProductVariants(admin);

  if (opts.selectionMode === "collections") {
    const ids = opts.collectionIds?.length
      ? opts.collectionIds
      : opts.collectionId
      ? [opts.collectionId]
      : [];
    if (ids.length === 0) return [];
    const seen = new Set<string>();
    const results: ProductVariants[] = [];
    for (const id of ids) {
      for (const pv of await getCollectionProductVariants(admin, id)) {
        if (!seen.has(pv.productId)) {
          seen.add(pv.productId);
          results.push(pv);
        }
      }
    }
    return results;
  }

  if (opts.selectionMode === "tags" && opts.selectedTags?.length) {
    const q = opts.selectedTags.map((t) => `tag:"${t}"`).join(" OR ");
    return getProductsByFilter(admin, q);
  }

  if (opts.selectionMode === "vendors" && opts.selectedVendors?.length) {
    const q = opts.selectedVendors.map((v) => `vendor:"${v}"`).join(" OR ");
    return getProductsByFilter(admin, q);
  }

  if (opts.selectionMode === "productTypes" && opts.selectedProductTypes?.length) {
    const q = opts.selectedProductTypes.map((t) => `product_type:"${t}"`).join(" OR ");
    return getProductsByFilter(admin, q);
  }

  const products = opts.selectedProducts ?? [];
  const result: ProductVariants[] = [];
  for (const p of products) {
    if (p.variants?.length) {
      const all = await getProductVariants(admin, p.id);
      const ids = new Set(p.variants.map((v) => v.id));
      result.push({ productId: p.id, variants: all.filter((v) => ids.has(v.id)) });
    } else {
      result.push({ productId: p.id, variants: await getProductVariants(admin, p.id) });
    }
  }
  return result;
}
