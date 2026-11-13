import test from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  missingCount,
  productIdsToSave,
  savedCollectionIds,
  savedProductIds,
} from "./saved-selection.ts";

test("productos guardados: manda la config; las filas son el respaldo", () => {
  assert.deepEqual(savedProductIds({ selectionMode: "products", selectedProductIds: ["a", "b"] }, ["x"]), ["a", "b"]);
  // Campaña anterior al cambio: sin ids en la config → salen de las filas.
  assert.deepEqual(savedProductIds({ selectionMode: "products" }, ["x", "x", "y"]), ["x", "y"]);
  assert.deepEqual(savedProductIds({}, ["x"]), ["x"]); // sin modo = products (forma más antigua)
});

test("productos guardados: un BORRADOR sin filas conserva su selección", () => {
  assert.deepEqual(savedProductIds({ selectionMode: "products", selectedProductIds: ["a"] }, []), ["a"]);
});

test("productos guardados: en otros modos no se hidrata nada", () => {
  assert.deepEqual(savedProductIds({ selectionMode: "collections", selectedProductIds: ["a"] }, ["x"]), []);
  assert.deepEqual(savedProductIds({ selectionMode: "all" }, ["x"]), []);
});

test("colecciones guardadas: forma nueva y forma antigua", () => {
  assert.deepEqual(savedCollectionIds({ collectionIds: ["c1", "c2"] }), ["c1", "c2"]);
  assert.deepEqual(savedCollectionIds({ collectionIds: [], collectionId: "viejo" }), ["viejo"]);
  assert.deepEqual(savedCollectionIds({}), []);
});

test("qué ids guardar: los elegidos, o los anteriores si el formulario llegó vacío", () => {
  assert.deepEqual(productIdsToSave("products", [{ id: "a" }, { id: "a" }, { id: "b" }], ["z"]), ["a", "b"]);
  assert.deepEqual(productIdsToSave("products", [], ["z"]), ["z"]);
  assert.deepEqual(productIdsToSave("products", [], undefined), []);
  assert.deepEqual(productIdsToSave("collections", [{ id: "a" }], ["z"]), []);
});

test("tandas y faltantes", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 250), []);
  assert.equal(missingCount(["a", "b", "c"], [{ id: "a" }]), 2);
  assert.equal(missingCount(["a"], [{ id: "a" }]), 0);
});
