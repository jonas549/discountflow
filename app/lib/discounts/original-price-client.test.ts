// El código del cupón, lo que viaja al metafield, y el formulario.
//
// El cálculo está en `original-price-calc.test.ts` y las fixtures contra el
// Wasm real en `extensions/code-original-price/tests/`. Acá va todo lo que
// rodea al cálculo y que puede romperse sin que ninguno de esos dos se entere.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  toOriginalPriceFunctionConfig,
  originalPriceDiscountMessage,
  originalPriceLabel,
  normalizeDiscountCode,
  ORIGINAL_PRICE_DEFAULT_MESSAGE,
  type OriginalPriceCampaignConfig,
} from "./original-price-client.ts";
import {
  parseOriginalPriceForm,
  validateOriginalPriceForm,
  buildOriginalPriceConfig,
} from "./original-price-form.ts";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const leer = (p: string) => fs.readFileSync(path.join(RAIZ, p), "utf8");

const BASE: OriginalPriceCampaignConfig = { percent: 10, code: "MARIA10" };

// ─── El código ───────────────────────────────────────────────────────────────

test("🔴 el código se normaliza a una sola forma", () => {
  // Si guardáramos "maria 10" y Shopify "MARIA10", la atribución del pedido no
  // cruzaría y el merchant vería cero ventas de ese influencer — sin ningún
  // error a la vista. Es el mismo tipo de fallo mudo que ya mordió con las
  // propiedades de línea del pack.
  assert.equal(normalizeDiscountCode("  maria 10 "), "MARIA10");
  assert.equal(normalizeDiscountCode("Influ_Ana"), "INFLU_ANA");
  assert.equal(normalizeDiscountCode(""), "");
  assert.equal(normalizeDiscountCode(undefined as unknown as string), "");
});

test("el formulario normaliza el código una sola vez, al parsear", () => {
  const f = formulario({ name: "Cupón", code: " maria 10 ", percent: "10" });
  assert.equal(f.code, "MARIA10");
  assert.equal(buildOriginalPriceConfig(f).code, "MARIA10");
});

// ─── Lo que viaja al metafield ───────────────────────────────────────────────

test("🔴 el CÓDIGO no viaja al metafield", () => {
  // Shopify ya sabe cuál es el código: se lo damos al crear el descuento y solo
  // llama a la Function cuando el comprador lo escribe. Mandarlo otra vez sería
  // un segundo sitio donde puede quedar desincronizado.
  const cfg = toOriginalPriceFunctionConfig({ ...BASE, shopifyDiscountId: "gid://x" });
  assert.deepEqual(
    Object.keys(cfg).sort(),
    ["excludeIfPackIds", "message", "percent"]
  );
});

test("la lista de exclusiones llega al metafield, y vacía si no hay", () => {
  assert.deepEqual(
    toOriginalPriceFunctionConfig({ ...BASE, excludedPackCampaignIds: ["p1", "p2"] })
      .excludeIfPackIds,
    ["p1", "p2"]
  );
  assert.deepEqual(toOriginalPriceFunctionConfig(BASE).excludeIfPackIds, []);
});

test("el mensaje por defecto es el mismo que el de la Function", () => {
  assert.equal(originalPriceDiscountMessage(BASE), ORIGINAL_PRICE_DEFAULT_MESSAGE);
  assert.equal(
    originalPriceDiscountMessage({ ...BASE, message: "  " }),
    ORIGINAL_PRICE_DEFAULT_MESSAGE
  );

  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  assert.ok(
    fn.includes(`'${ORIGINAL_PRICE_DEFAULT_MESSAGE}'`),
    "🔴 el texto por defecto tiene que coincidir con el de la Function: es el que " +
      "ve el comprador si el merchant no escribe ninguno"
  );
});

test("el resumen del listado dice sobre qué se calcula", () => {
  assert.equal(originalPriceLabel(BASE), "10% sobre el precio original");
});

// ─── El formulario ───────────────────────────────────────────────────────────

function formulario(campos: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return parseOriginalPriceForm(fd);
}

test("el formulario exige nombre, código y porcentaje", () => {
  const vacio = formulario({});
  const e = validateOriginalPriceForm(vacio);
  assert.ok(e.name);
  assert.ok(e.code);
  assert.ok(e.percent);

  const bueno = formulario({ name: "Cupón de María", code: "MARIA10", percent: "10" });
  assert.deepEqual(validateOriginalPriceForm(bueno), {});
});

test("🔴 un código que no se puede dictar por teléfono se rechaza", () => {
  // Shopify acepta más, pero un código con acentos o símbolos raros es un
  // código que el influencer va a dictar mal y el comprador va a escribir mal.
  for (const malo of ["AB", "MARÍA10", "MARIA#10", "MARIA/10"]) {
    const f = formulario({ name: "Cupón", code: malo, percent: "10" });
    assert.ok(validateOriginalPriceForm(f).code, `debería rechazar "${malo}"`);
  }
  for (const bueno of ["ABC", "MARIA-10", "MARIA_10", "MARIA.10", "INFLU10"]) {
    const f = formulario({ name: "Cupón", code: bueno, percent: "10" });
    assert.equal(validateOriginalPriceForm(f).code, undefined, `debería aceptar "${bueno}"`);
  }
});

test("quitar todas las exclusiones se puede guardar", () => {
  const f = formulario({
    name: "Cupón",
    code: "MARIA10",
    percent: "10",
    excludedPacksJson: "[]",
  });
  assert.deepEqual(buildOriginalPriceConfig(f).excludedPackCampaignIds, []);
});

test("un JSON roto no revienta el guardado", () => {
  const f = formulario({
    name: "Cupón",
    code: "MARIA10",
    percent: "10",
    excludedPacksJson: "{{{roto",
  });
  assert.deepEqual(f.excludedPackCampaignIds, []);
  assert.deepEqual(validateOriginalPriceForm(f), {});
});

test("la fecha de fin tiene que ser posterior a la de inicio", () => {
  const f = formulario({
    name: "Cupón",
    code: "MARIA10",
    percent: "10",
    startsAt: "2026-10-01T10:00",
    endsAt: "2026-09-01T10:00",
  });
  assert.ok(validateOriginalPriceForm(f).dates);
});

// ─── Las mutaciones ──────────────────────────────────────────────────────────

test("🔴 el cupón usa las mutaciones de CÓDIGO, no las de automático", () => {
  // Es el primer descuento de código de la app. `discountAutomaticAppCreate` y
  // `discountCodeAppCreate` se parecen lo suficiente como para copiar el
  // equivocado, y el resultado sería un descuento que aplica solo sin que nadie
  // escriba nada.
  const src = leer("app/lib/discounts/original-price.ts");
  for (const m of [
    "discountCodeAppCreate",
    "discountCodeAppUpdate",
    "discountCodeActivate",
    "discountCodeDeactivate",
    "discountCodeDelete",
  ]) {
    assert.match(src, new RegExp(m), `falta ${m}`);
  }
  // Sin los comentarios: ahí `discountAutomatic*` aparece justamente para
  // advertir de no confundirlas.
  const codigo = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(codigo, /discountAutomatic/, "no puede usar mutaciones de automático");
});

test("🔴 el cupón acepta convivir, para que Shopify no descarte nada solo", () => {
  // La lección del carrito mixto: `combinesWith` en false hace que Shopify elija
  // un ganador en silencio. Quién gana lo decide el merchant con la exclusión.
  const src = leer("app/lib/discounts/original-price.ts");
  assert.match(src, /const COMBINACION_DEL_CUPON = \{\s*orderDiscounts: true/);
  assert.match(src, /const COMBINACION_DEL_CUPON = \{[^}]*productDiscounts: true/);
  const usos = src.match(/combinesWith: COMBINACION_DEL_CUPON/g) ?? [];
  assert.equal(usos.length, 2, "al crear Y al actualizar");
});

test("el código se reescribe al actualizar", () => {
  // El merchant puede cambiarlo. Si no lo mandáramos en el update, quedaría el
  // viejo funcionando y el nuevo sin existir — y el influencer repartiendo un
  // código muerto.
  const src = leer("app/lib/discounts/original-price.ts");
  const update = src.slice(src.indexOf("export async function updateOriginalPriceDiscount"));
  assert.match(update, /^\s*code,$/m, "el update tiene que mandar el código");
});

test("🔴 la Function corta ANTES de calcular, y deja dicho por qué", () => {
  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  assert.match(fn, /motivo=excluido-por-campana/);

  const iExcl = fn.indexOf("excluidos.indexOf(packId)");
  const iCalc = fn.indexOf("computeOriginalPriceDiscount(");
  assert.ok(iExcl > 0 && iCalc > 0);
  assert.ok(iExcl < iCalc, "la exclusión se evalúa antes de calcular nada");
});

test("🔴 la Function emite MONTO FIJO por unidad, nunca un porcentaje", () => {
  // Es todo el tipo de campaña: un porcentaje lo calcularía Shopify sobre el
  // precio ya rebajado y estaríamos donde empezamos. Y sin `appliesToEachItem`
  // el monto se aplicaría una vez por línea en vez de por unidad.
  const fn = leer("extensions/code-original-price/src/cart_lines_discounts_generate_run.ts");
  assert.match(fn, /fixedAmount: \{amount: l\.discountPerUnit, appliesToEachItem: true\}/);
  assert.doesNotMatch(fn, /percentage:/, "un porcentaje anularía el propósito del tipo");
});
