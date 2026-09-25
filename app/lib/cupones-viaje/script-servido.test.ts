// El script servido nunca puede lanzar (riesgo A del plan de despliegue).

import test from "node:test";
import assert from "node:assert/strict";

import { armarScript, MARCA_ATRIBUTOS } from "./script-servido.ts";

test("con la marca: escribe los nombres de los atributos dentro del script", () => {
  const s = armarScript(`var ATRIBUTOS = ${MARCA_ATRIBUTOS};`);
  assert.match(s, /^var ATRIBUTOS = \{"cupon":"Cupón de viaje","saldo":"Descontar del saldo"/);
});

test("🔴 SIN la marca: NO lanza y sirve el widget tal cual (se degrada al proxy)", () => {
  const fuente = "var ATRIBUTOS = null;";
  const errores: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errores.push(a);
  try {
    assert.equal(armarScript(fuente), fuente);
  } finally {
    console.error = original;
  }
  assert.equal(errores.length, 1); // queda registrado para enterarse
});

test("con algo que no es texto: no lanza, devuelve vacío", () => {
  assert.equal(armarScript(undefined), "");
  assert.equal(armarScript(null), "");
  assert.equal(armarScript(42), "");
});
