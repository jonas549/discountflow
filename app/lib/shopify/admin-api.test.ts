import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getExistingVariantIds, isMissingInShopify } from "./admin-api.ts";

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
