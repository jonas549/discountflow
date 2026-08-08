import { strict as assert } from "node:assert";
import { test } from "node:test";

import { formatDecimalInput, parseDecimalInput } from "./decimal-input.ts";

/**
 * Simula teclear carácter a carácter en el input CON BUFFER.
 *
 * Es la prueba que importa: el bug original no se veía con un valor completo,
 * solo al escribir el separador. Reproduce el ciclo real —cada pulsación
 * actualiza el buffer, y el número solo cambia cuando el texto ya es parseable—
 * y devuelve el valor con el que se quedaría el formulario.
 */
function teclear(secuencia: string): number {
  let texto = "";
  let valor = 0;
  for (const tecla of secuencia) {
    texto += tecla;
    const parsed = parseDecimalInput(texto);
    if (parsed !== null) valor = parsed;
  }
  return valor;
}

// ─── Los tres casos que reportó QA ───────────────────────────────────────────

test("los decimales que se perdian ahora entran enteros", () => {
  assert.equal(teclear("10.50"), 10.5);
  assert.equal(teclear("5.5"), 5.5);
  assert.equal(teclear("12.34"), 12.34);
});

test("con coma, que es como se escribe en espanol", () => {
  assert.equal(teclear("10,50"), 10.5);
  assert.equal(teclear("5,5"), 5.5);
  assert.equal(teclear("12,34"), 12.34);
});

test("los enteros siguen entrando igual que antes", () => {
  for (const n of [10, 20, 50, 150]) {
    assert.equal(teclear(String(n)), n);
  }
});

// ─── El estado intermedio, que es donde estaba el fallo ──────────────────────

test("el separador a medio escribir no borra lo ya tecleado", () => {
  assert.equal(parseDecimalInput("10."), 10);
  assert.equal(parseDecimalInput("10,"), 10);
  // Y el buffer conserva el separador, asi que el siguiente digito lo completa.
  assert.equal(parseDecimalInput("10.5"), 10.5);
});

test("null significa 'sigue escribiendo', no error", () => {
  assert.equal(parseDecimalInput("."), null);
  assert.equal(parseDecimalInput(","), null);
  assert.equal(parseDecimalInput("abc"), null);
  assert.equal(parseDecimalInput("1,2,3"), null);
  assert.equal(parseDecimalInput("1.2.3"), null);
  assert.equal(parseDecimalInput("-5"), null);
  assert.equal(parseDecimalInput("5-"), null);
});

test("el campo vacio vale 0, no null", () => {
  // 0 es un valor legitimo en un nivel: "desde aqui, precio normal".
  assert.equal(parseDecimalInput(""), 0);
  assert.equal(parseDecimalInput("   "), 0);
});

test("teclear un separador suelto no rompe ni cambia el valor", () => {
  assert.equal(teclear("."), 0);
  assert.equal(teclear(","), 0);
});

test("borrar hasta vaciar deja 0", () => {
  let texto = "12,34";
  let valor = 12.34;
  while (texto.length > 0) {
    texto = texto.slice(0, -1);
    const parsed = parseDecimalInput(texto);
    if (parsed !== null) valor = parsed;
  }
  assert.equal(valor, 0);
});

// ─── Detalles de importe ─────────────────────────────────────────────────────

test("admite mas de dos decimales sin inventarse un redondeo", () => {
  // El recorte a centavos es cosa del calculo (toCents), no del input.
  assert.equal(parseDecimalInput("10.999"), 10.999);
});

test("espacios alrededor no molestan", () => {
  assert.equal(parseDecimalInput("  10,50  "), 10.5);
});

test("cero y decimales por debajo de uno", () => {
  assert.equal(teclear("0,99"), 0.99);
  assert.equal(teclear("0.05"), 0.05);
  assert.equal(parseDecimalInput("0"), 0);
});

test("sin el cero de delante, que es como mucha gente escribe medio peso", () => {
  assert.equal(teclear(".5"), 0.5);
  assert.equal(teclear(",50"), 0.5);
  assert.equal(parseDecimalInput(".99"), 0.99);
});

// ─── Ida y vuelta ────────────────────────────────────────────────────────────

test("formatDecimalInput y parseDecimalInput son inversos", () => {
  for (const n of [0, 5, 10.5, 12.34, 0.99, 150]) {
    assert.equal(parseDecimalInput(formatDecimalInput(n)), n);
  }
});

test("formatDecimalInput sale con punto, que el parser vuelve a aceptar", () => {
  assert.equal(formatDecimalInput(10.5), "10.5");
  assert.equal(formatDecimalInput(0), "0");
});
