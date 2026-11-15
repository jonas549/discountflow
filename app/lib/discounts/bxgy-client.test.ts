import test from "node:test";
import assert from "node:assert/strict";

import { bxgyItemsInput, quitarExcluidos } from "./bxgy-client.ts";

test("quitarExcluidos saca solo los excluidos y respeta el orden", () => {
  assert.deepEqual(quitarExcluidos(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(quitarExcluidos(["a", "b"], []), ["a", "b"]);
  assert.deepEqual(quitarExcluidos(["a"], ["z"]), ["a"]);
  assert.deepEqual(quitarExcluidos(["a"], ["a"]), []);
});

test("al CREAR: se manda solo lo que hay que poner", () => {
  assert.deepEqual(bxgyItemsInput({ kind: "products", productIds: ["a", "b"] }), {
    products: { productsToAdd: ["a", "b"] },
  });
  assert.deepEqual(bxgyItemsInput({ kind: "collections", collectionIds: ["c1"] }), {
    collections: { add: ["c1"] },
  });
});

test("🔴 al ACTUALIZAR: lo que la oferta lleva hoy y ya no va, se quita", () => {
  // El merchant sacó «c» de la lista (o lo excluyó): antes seguía en Shopify.
  assert.deepEqual(
    bxgyItemsInput({ kind: "products", productIds: ["a", "b"] }, { productIds: ["a", "b", "c"], collectionIds: [] }),
    { products: { productsToAdd: ["a", "b"], productsToRemove: ["c"] } }
  );
  assert.deepEqual(
    bxgyItemsInput({ kind: "collections", collectionIds: ["c1"] }, { productIds: [], collectionIds: ["c1", "c2"] }),
    { collections: { add: ["c1"], remove: ["c2"] } }
  );
});

test("🔴 H3: pasar de colección a lista de productos retira la colección (si no, Shopify lo rechaza)", () => {
  assert.deepEqual(
    bxgyItemsInput({ kind: "products", productIds: ["a"] }, { productIds: [], collectionIds: ["c1"] }),
    { products: { productsToAdd: ["a"] }, collections: { remove: ["c1"] } }
  );
});

test("pasar de lista de productos a colección retira los productos", () => {
  assert.deepEqual(
    bxgyItemsInput({ kind: "collections", collectionIds: ["c1"] }, { productIds: ["a", "b"], collectionIds: [] }),
    { collections: { add: ["c1"] }, products: { productsToRemove: ["a", "b"] } }
  );
});

test("sin cambios respecto de lo que hay: no se manda ningún «quitar»", () => {
  assert.deepEqual(
    bxgyItemsInput({ kind: "products", productIds: ["a"] }, { productIds: ["a"], collectionIds: [] }),
    { products: { productsToAdd: ["a"] } }
  );
});
