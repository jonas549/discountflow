import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyPercentCents, centsToString, toCents } from "./money.ts";

/** Atajo: pesos + porcentaje → el string que se le manda a Shopify. */
const precio = (base: number, pct: number) =>
  centsToString(applyPercentCents(toCents(base), pct));

test("el medio centavo redondea al alza — el caso que se cobraba de menos", () => {
  // 45,50 al 15 % son exactamente 38,675. En coma flotante el valor más cercano
  // es 38,674999999999997158 y toFixed(2) daba 38,67.
  assert.equal(precio(45.5, 15), "38.68");
});

test("los precios que ya salían bien no cambian", () => {
  // Regresión de la campaña real que se usó para diagnosticar el fallo: si el
  // arreglo del medio centavo moviera estos, estaría rompiendo lo que funcionaba.
  assert.equal(precio(98, 15), "83.30");
  assert.equal(precio(79.99, 15), "67.99");
  assert.equal(precio(120, 15), "102.00");
  assert.equal(precio(69.99, 15), "59.49");
  assert.equal(precio(99.99, 15), "84.99");
});

test("porcentajes con decimales", () => {
  assert.equal(precio(45.5, 12.5), "39.81");
  assert.equal(precio(100, 33.33), "66.67");
});

test("los extremos del porcentaje", () => {
  assert.equal(precio(45.5, 0), "45.50");
  assert.equal(precio(45.5, 100), "0.00");
});

test("centsToString no pierde el cero de los céntimos", () => {
  assert.equal(centsToString(4550), "45.50");
  assert.equal(centsToString(4505), "45.05");
  assert.equal(centsToString(4500), "45.00");
  assert.equal(centsToString(5), "0.05");
  assert.equal(centsToString(0), "0.00");
});

test("toCents absorbe el ruido binario en vez de truncarlo", () => {
  // 45.5 * 100 da 4550.000000000001 en coma flotante: truncar daría 4550 por
  // suerte, pero 8.115 * 100 da 811.4999999999999 y truncar daría 811.
  assert.equal(toCents(45.5), 4550);
  assert.equal(toCents(8.115), 812);
  assert.equal(toCents(0.07), 7);
});
