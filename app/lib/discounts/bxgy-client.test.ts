import test from "node:test";
import assert from "node:assert/strict";

import {
  bxgyItemsInput,
  quitarExcluidos,
  targetDeProductos,
  variantesParciales,
} from "./bxgy-client.ts";

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

// ─── H7: variantes sueltas ────────────────────────────────────────────────────

test("🔴 H7: solo es parcial quien tiene ALGUNAS variantes elegidas, no todas ni ninguna", () => {
  const totales = new Map([["p1", 3], ["p2", 2], ["p3", 4]]);
  assert.deepEqual(
    variantesParciales(
      [
        { id: "p1", variants: [{ id: "v1" }] }, // 1 de 3 → parcial
        { id: "p2", variants: [{ id: "v4" }, { id: "v5" }] }, // todas → entero
        { id: "p3", variants: [] }, // el selector no mandó variantes → entero
        { id: "p4", variants: [{ id: "v9" }] }, // Shopify no dijo cuántas tiene → entero
      ],
      totales
    ),
    { p1: ["v1"] }
  );
});

test("H7: una variante repetida no hace pasar por completa una selección parcial", () => {
  assert.deepEqual(
    variantesParciales([{ id: "p", variants: [{ id: "a" }, { id: "a" }] }], new Map([["p", 2]])),
    { p: ["a"] }
  );
});

test("H7: sin parciales el objetivo es el de siempre, sin la clave de variantes", () => {
  assert.deepEqual(targetDeProductos(["a", "b"], undefined), { kind: "products", productIds: ["a", "b"] });
  assert.deepEqual(targetDeProductos(["a", "b"], {}), { kind: "products", productIds: ["a", "b"] });
  // Una entrada de un producto que ya no está en la lista no cuenta.
  assert.deepEqual(targetDeProductos(["a"], { z: ["v"] }), { kind: "products", productIds: ["a"] });
});

test("🔴 H7: el producto parcial viaja como variantes y NO como producto", () => {
  assert.deepEqual(targetDeProductos(["a", "b"], { b: ["b1", "b2"] }), {
    kind: "products",
    productIds: ["a"],
    variantIds: ["b1", "b2"],
  });
  assert.deepEqual(
    bxgyItemsInput({ kind: "products", productIds: ["a"], variantIds: ["b1"] }),
    { products: { productsToAdd: ["a"], productVariantsToAdd: ["b1"] } }
  );
});

test("🔴 H7 al ACTUALIZAR: de producto entero a una variante, se quita el producto", () => {
  assert.deepEqual(
    bxgyItemsInput(
      { kind: "products", productIds: [], variantIds: ["b1"] },
      { productIds: ["b"], collectionIds: [], variantIds: [] }
    ),
    { products: { productsToAdd: [], productsToRemove: ["b"], productVariantsToAdd: ["b1"] } }
  );
});

test("H7 al ACTUALIZAR: variantes que ya no van se quitan; a colección se quitan todas", () => {
  assert.deepEqual(
    bxgyItemsInput(
      { kind: "products", productIds: ["a"], variantIds: ["b1"] },
      { productIds: ["a"], collectionIds: [], variantIds: ["b1", "b2"] }
    ),
    { products: { productsToAdd: ["a"], productVariantsToAdd: ["b1"], productVariantsToRemove: ["b2"] } }
  );
  assert.deepEqual(
    bxgyItemsInput(
      { kind: "products", productIds: ["a"] },
      { productIds: ["a"], collectionIds: [], variantIds: ["b1"] }
    ),
    { products: { productsToAdd: ["a"], productVariantsToRemove: ["b1"] } }
  );
  assert.deepEqual(
    bxgyItemsInput(
      { kind: "collections", collectionIds: ["c1"] },
      { productIds: [], collectionIds: [], variantIds: ["b1"] }
    ),
    { collections: { add: ["c1"] }, products: { productVariantsToRemove: ["b1"] } }
  );
});
