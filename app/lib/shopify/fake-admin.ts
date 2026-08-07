// Cliente Shopify falso — catálogos sintéticos de cualquier tamaño, sin tienda.
//
// La costura ya existía en el repo: percentage.ts, range.ts y tiered.ts declaran
// todos el mismo tipo mínimo
//
//     type AdminClient = { graphql: (q, o?) => Promise<Response> }
//
// Es UNA función. Doblarla permite simular 20.000 variantes de forma determinista,
// en segundos, sin dev store y sin rate limits — y, sobre todo, permite provocar a
// voluntad lo que en una tienda real es imposible de reproducir a demanda:
// THROTTLED en la mutación número 47, un userError en el producto 900, latencia de
// 3 s por llamada, o matar el proceso a mitad.
//
// No se usa en producción. Vive en app/lib para que los tests puedan importarlo con
// las mismas rutas que el resto del código.

export type FakeCatalogOptions = {
  /** Productos del catálogo sintético. */
  products: number;
  /** Variantes por producto. */
  variantsPerProduct?: number;
  /** Precio base; cada producto suma 1 para que no sean todos iguales. */
  basePrice?: number;
};

export type FakeBehaviour = {
  /** Latencia artificial de cada llamada, en ms. */
  latencyMs?: number;
  /** Índices de mutación (1-based) que responden THROTTLED una vez. */
  throttleAtCalls?: number[];
  /** Índices de mutación que responden con userErrors. */
  userErrorAtCalls?: number[];
  /** Índices de mutación que responden con json.errors (consulta rechazada). */
  hardErrorAtCalls?: number[];
};

export type FakeAdminClient = {
  graphql: (q: string, o?: { variables: unknown }) => Promise<Response>;
  /** Mutaciones de precio recibidas, en orden. Para asertar en los tests. */
  readonly mutationCalls: Array<{ productId: string; variantIds: string[] }>;
  /** Total de llamadas GraphQL (lecturas incluidas). */
  readonly callCount: number;
  reset(): void;
};

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function createFakeAdmin(
  catalog: FakeCatalogOptions,
  behaviour: FakeBehaviour = {}
): FakeAdminClient {
  const variantsPer = catalog.variantsPerProduct ?? 1;
  const basePrice = catalog.basePrice ?? 100;

  const mutationCalls: Array<{ productId: string; variantIds: string[] }> = [];
  let calls = 0;
  let mutations = 0;
  const throttledOnce = new Set<number>();

  const productNode = (i: number) => ({
    id: `gid://shopify/Product/${i}`,
    variants: {
      nodes: Array.from({ length: variantsPer }, (_, v) => ({
        id: `gid://shopify/ProductVariant/${i}-${v}`,
        price: (basePrice + i).toFixed(2),
        compareAtPrice: null,
      })),
    },
  });

  /** Página de productos con el mismo contrato que la Admin API real. */
  function page(cursor: string | null, size: number) {
    const from = cursor ? Number(cursor) : 0;
    const to = Math.min(from + size, catalog.products);
    const nodes = [];
    for (let i = from; i < to; i++) nodes.push(productNode(i));
    return {
      nodes,
      pageInfo: { hasNextPage: to < catalog.products, endCursor: String(to) },
    };
  }

  const client: FakeAdminClient = {
    get mutationCalls() {
      return mutationCalls;
    },
    get callCount() {
      return calls;
    },
    reset() {
      mutationCalls.length = 0;
      calls = 0;
      mutations = 0;
      throttledOnce.clear();
    },
    async graphql(query: string, opts?: { variables: unknown }) {
      calls += 1;
      await sleep(behaviour.latencyMs ?? 0);

      const vars = (opts?.variables ?? {}) as Record<string, unknown>;

      // ── Mutación de precios ────────────────────────────────────────────────
      if (query.includes("productVariantsBulkUpdate")) {
        mutations += 1;
        const n = mutations;

        if (behaviour.throttleAtCalls?.includes(n) && !throttledOnce.has(n)) {
          throttledOnce.add(n);
          return json({
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          });
        }
        if (behaviour.hardErrorAtCalls?.includes(n))
          return json({ errors: [{ message: "Field 'x' doesn't exist" }] });

        const productId = String(vars.productId ?? "");
        const variants = (vars.variants ?? []) as Array<{ id: string; price: string }>;
        mutationCalls.push({ productId, variantIds: variants.map((v) => v.id) });

        if (behaviour.userErrorAtCalls?.includes(n))
          return json({
            data: {
              productVariantsBulkUpdate: {
                productVariants: [],
                userErrors: [{ field: "price", message: "Precio inválido (simulado)" }],
              },
            },
          });

        return json({
          data: {
            productVariantsBulkUpdate: {
              productVariants: variants.map((v) => ({
                id: v.id,
                price: v.price,
                compareAtPrice: null,
              })),
              userErrors: [],
            },
          },
        });
      }

      // ── Lecturas paginadas ─────────────────────────────────────────────────
      const cursor = (vars.cursor as string | null) ?? null;

      if (query.includes("GetCollectionProducts"))
        return json({ data: { collection: { products: page(cursor, 50) } } });

      if (query.includes("GetAllProducts") || query.includes("GetFilteredProducts"))
        return json({ data: { products: page(cursor, 50) } });

      if (query.includes("GetProductVariants")) {
        const id = String(vars.productId ?? "gid://shopify/Product/0");
        const i = Number(id.split("/").pop());
        return json({ data: { product: productNode(i) } });
      }

      // Cualquier otra consulta: respuesta vacía pero VÁLIDA. Nunca se devuelve
      // `data: null`, que es justo lo que readQueryData debe tratar como fallo.
      return json({ data: {} });
    },
  };

  return client;
}
