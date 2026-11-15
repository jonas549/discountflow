import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  bulkUpdateVariantPrices,
  getExistingVariantIds,
  getProductMetadata,
  getProductsByTags,
  isMissingInShopify,
  tieneEtiquetaExacta,
} from "./admin-api.ts";

// ─── isMissingInShopify ───────────────────────────────────────────────────────
//
// El matcher decide si una unidad se SALTEA o se trata como fallo. Si se abriera
// de más, una campaña se pausaría dando por revertidos precios que siguen
// rebajados — el fallo caro y en la dirección contraria.

test("reconoce los dos textos reales de Shopify", () => {
  // Verificados contra producción (Greta, 2026-09-07).
  assert.equal(
    isMissingInShopify(
      new Error(
        "Shopify rechazó los precios del producto gid://shopify/Product/158: Product does not exist"
      )
    ),
    true
  );
  assert.equal(
    isMissingInShopify(
      new Error(
        "Shopify rechazó los precios del producto gid://shopify/Product/158: Product variant does not exist, Product variant does not exist"
      )
    ),
    true
  );
});

test("🔴 NO reconoce nada más: todo lo demás es un fallo de verdad", () => {
  // Si alguno de estos se tragara como "salteado", la campaña quedaría pausada
  // con precios rebajados vivos y nadie se enteraría.
  for (const msg of [
    "Throttled",
    "Precio inválido (simulado)",
    "Shopify no devolvió datos para productVariantsBulkUpdate (producto X).",
    "fetch failed",
    "Access denied for productVariantsBulkUpdate",
    "The collection does not exist", // ojo: colección, no producto
  ]) {
    assert.equal(isMissingInShopify(new Error(msg)), false, msg);
  }
});

test("tolera que le llegue algo que no es un Error", () => {
  assert.equal(isMissingInShopify("Product does not exist"), true);
  assert.equal(isMissingInShopify(null), false);
  assert.equal(isMissingInShopify(undefined), false);
});

// ─── getExistingVariantIds ────────────────────────────────────────────────────

function adminQueDevuelve(body: unknown) {
  return {
    graphql: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };
}

test("devuelve los ids de las variantes vivas", async () => {
  const admin = adminQueDevuelve({
    data: {
      product: {
        id: "gid://shopify/Product/1",
        variants: { nodes: [{ id: "gid://v/1" }, { id: "gid://v/2" }] },
      },
    },
  });
  const vivas = await getExistingVariantIds(admin, "gid://shopify/Product/1");
  assert.deepEqual([...(vivas ?? [])].sort(), ["gid://v/1", "gid://v/2"]);
});

test("producto borrado devuelve null, que NO es lo mismo que un producto sin variantes", async () => {
  const borrado = await getExistingVariantIds(
    adminQueDevuelve({ data: { product: null } }),
    "gid://shopify/Product/1"
  );
  assert.equal(borrado, null);

  const vivoSinVariantes = await getExistingVariantIds(
    adminQueDevuelve({
      data: { product: { id: "gid://shopify/Product/1", variants: { nodes: [] } } },
    }),
    "gid://shopify/Product/1"
  );
  assert.ok(vivoSinVariantes instanceof Set);
  assert.equal(vivoSinVariantes?.size, 0);
});

test("🔴 una consulta rechazada LANZA, no devuelve null", async () => {
  // Este es el punto entero de que la función exista en vez de reusar
  // getProductVariants, que hace `?? []`. Si un token caducado o un throttling
  // se leyera como "el producto no existe", se saltearían productos VIVOS y sus
  // precios se quedarían rebajados para siempre.
  await assert.rejects(
    () =>
      getExistingVariantIds(
        adminQueDevuelve({ errors: [{ message: "Throttled" }] }),
        "gid://shopify/Product/1"
      ),
    /Throttled/
  );
});

test("🔴 una respuesta sin data LANZA", async () => {
  await assert.rejects(
    () => getExistingVariantIds(adminQueDevuelve({}), "gid://shopify/Product/1"),
    /no devolvió datos/
  );
});

test("un throttling LANZADO por el cliente también se reintenta (no es incidencia)", async () => {
  let llamadas = 0;
  const admin = {
    graphql: async () => {
      llamadas += 1;
      if (llamadas === 1) throw new Error("Throttled");
      return new Response(
        JSON.stringify({
          data: {
            productVariantsBulkUpdate: {
              productVariants: [{ id: "v1", price: "10.00", compareAtPrice: null }],
              userErrors: [],
            },
          },
        })
      );
    },
  };
  const out = await bulkUpdateVariantPrices(admin, "gid://shopify/Product/1", [
    { id: "v1", price: "10.00", compareAtPrice: null },
  ]);
  assert.equal(llamadas, 2);
  assert.equal(out.length, 1);
  // Un error lanzado que NO es throttling sigue saliendo tal cual.
  await assert.rejects(
    () =>
      bulkUpdateVariantPrices(
        { graphql: async () => { throw new Error("boom"); } },
        "gid://shopify/Product/1",
        [{ id: "v1", price: "10.00", compareAtPrice: null }]
      ),
    /boom/
  );
});

// ─── getProductMetadata (QA 2026-11-14, defecto H4) ──────────────────────────
//
// Antes deducía tags, vendedores y tipos de los primeros 250 productos: en una
// tienda más grande faltaban opciones en los selectores.

function adminDeMetadata(
  paginas: Record<string, string[][]>,
  opciones: { romperListas?: boolean } = {}
) {
  const consultas: string[] = [];
  const admin = {
    graphql: async (q: string, o?: { variables: unknown }) => {
      const campo = ["productTags", "productVendors", "productTypes"].find((c) => q.includes(`${c}(`));
      consultas.push(campo ?? "products");
      if (campo) {
        if (opciones.romperListas) return Response.json({ errors: [{ message: "no existe" }] });
        const after = (o?.variables as { after: string | null }).after;
        const i = after ? Number(after) : 0;
        const todas = paginas[campo] ?? [[]];
        return Response.json({
          data: {
            [campo]: {
              nodes: todas[i] ?? [],
              pageInfo: { hasNextPage: i < todas.length - 1, endCursor: String(i + 1) },
            },
          },
        });
      }
      return Response.json({
        data: { products: { nodes: [{ vendor: "Viejo", productType: "Tipo", tags: ["b", "a"] }] } },
      });
    },
  };
  return { admin, consultas };
}

test("getProductMetadata lee las listas completas, sin pasar por los productos", async () => {
  const { admin, consultas } = adminDeMetadata({
    productTags: [["verano", "oferta", "verano"]],
    productVendors: [["Zeta", "", "Alfa"]],
    productTypes: [["Ropa"]],
  });
  const m = await getProductMetadata(admin);
  assert.deepEqual(m, { tags: ["oferta", "verano"], vendors: ["Alfa", "Zeta"], productTypes: ["Ropa"] });
  assert.equal(consultas.includes("products"), false);
});

test("getProductMetadata sigue paginando hasta agotar cada lista", async () => {
  const { admin, consultas } = adminDeMetadata({
    productTags: [["a"], ["b"], ["c"]],
    productVendors: [["V1"], ["V2"]],
    productTypes: [["T"]],
  });
  const m = await getProductMetadata(admin);
  assert.deepEqual(m.tags, ["a", "b", "c"]);
  assert.deepEqual(m.vendors, ["V1", "V2"]);
  assert.equal(consultas.filter((c) => c === "productTags").length, 3);
});

test("getProductMetadata cae al método anterior si las listas fallan", async () => {
  const { admin } = adminDeMetadata({}, { romperListas: true });
  const m = await getProductMetadata(admin);
  assert.deepEqual(m, { tags: ["a", "b"], vendors: ["Viejo"], productTypes: ["Tipo"] });
});

// ─── Etiqueta exacta (QA 2026-11-15, defecto H9) ─────────────────────────────
//
// `tag:"qa"` de Shopify también devuelve productos con `qa-test`. Una campaña
// por «sale» rebajaba además los de «summer-sale».

test("tieneEtiquetaExacta no acepta etiquetas que solo contienen la elegida", () => {
  assert.equal(tieneEtiquetaExacta(["qa-test", "discountflow-qa"], ["qa"]), false);
  assert.equal(tieneEtiquetaExacta(["summer-sale"], ["sale"]), false);
  assert.equal(tieneEtiquetaExacta(["qa-test", "qa"], ["qa"]), true);
  assert.equal(tieneEtiquetaExacta(["Verano"], ["verano "]), true);
  assert.equal(tieneEtiquetaExacta(["a"], ["x", "a"]), true);
  assert.equal(tieneEtiquetaExacta(undefined, ["qa"]), false);
  assert.equal(tieneEtiquetaExacta([], ["qa"]), false);
});

test("getProductsByTags descarta lo que la búsqueda de Shopify trae de más", async () => {
  const consultas: string[] = [];
  const paginas = [
    [
      { id: "p1", tags: ["qa"], variants: { nodes: [] } },
      { id: "p2", tags: ["qa-test"], variants: { nodes: [] } },
    ],
    [
      { id: "p3", tags: ["discountflow-qa", "otra"], variants: { nodes: [] } },
      { id: "p4", tags: ["QA", "qa-test"], variants: { nodes: [] } },
    ],
  ];
  const admin = {
    graphql: async (_q: string, o?: { variables: unknown }) => {
      const v = o?.variables as { q: string; cursor: string | null };
      consultas.push(v.q);
      const i = v.cursor ? Number(v.cursor) : 0;
      return Response.json({
        data: {
          products: {
            nodes: paginas[i],
            pageInfo: { hasNextPage: i < paginas.length - 1, endCursor: String(i + 1) },
          },
        },
      });
    },
  };
  const r = await getProductsByTags(admin, ["qa"]);
  assert.deepEqual(r.map((p) => p.productId), ["p1", "p4"]);
  assert.equal(consultas[0], 'tag:"qa"');
  assert.equal(consultas.length, 2);
});
