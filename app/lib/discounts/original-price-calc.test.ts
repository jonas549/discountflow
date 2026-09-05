// Tests del cálculo del cupón sobre el precio original.
//
// El caso que hay que proteger es el del brief, y está el primero: producto de
// $100 rebajado a $85, cupón del 10%, tiene que dar $10 y no $8,50.

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeOriginalPriceDiscount,
  resolveBasePrice,
  validateOriginalPrice,
  MAX_ORIGINAL_PRICE_PERCENT,
  type OriginalPriceLine,
} from "./original-price-calc.ts";

const linea = (
  unitPrice: number,
  compareAtUnitPrice: number | null,
  quantity = 1,
  lineId = "gid://shopify/CartLine/0"
): OriginalPriceLine => ({ lineId, unitPrice, compareAtUnitPrice, quantity });

// ─── El caso del brief ───────────────────────────────────────────────────────

test("🔴 $100 rebajado a $85, cupón del 10% → descuenta $10, no $8,50", () => {
  const r = computeOriginalPriceDiscount(10, [linea(85, 100)]);
  assert.ok(r.applies);
  if (!r.applies) return;

  assert.equal(r.lines[0].discountPerUnit, 10);
  assert.equal(r.lines[0].basePrice, 100);
  assert.equal(r.lines[0].usedCompareAt, true);
  // El comprador termina pagando 85 − 10 = 75, que es lo que pidió el merchant.
  assert.equal(r.totalSavings, 10);
  // Un cupón normal habría dado 8,50. La diferencia es lo que aporta el tipo.
  assert.equal(r.extraVsPercent, 1.5);
});

test("$100 rebajado a $50 (50% off), cupón del 10% → $10", () => {
  // El ejemplo que dio Jonas al cerrar F0.
  const r = computeOriginalPriceDiscount(10, [linea(50, 100)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].discountPerUnit, 10);
  assert.equal(r.extraVsPercent, 5); // 10 contra los 5 de un cupón normal
});

// ─── Sin precio comparativo ──────────────────────────────────────────────────

test("sin precio comparativo se usa el precio actual", () => {
  // Decisión de producto: ese caso no hay que protegerlo. Si el merchant no
  // puso comparativo, el precio actual ES el precio.
  const r = computeOriginalPriceDiscount(10, [linea(85, null)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].discountPerUnit, 8.5);
  assert.equal(r.lines[0].usedCompareAt, false);
  assert.equal(r.extraVsPercent, 0, "sin comparativo no hay nada extra que aportar");
});

test("🔴 un comparativo que no describe una rebaja se ignora", () => {
  // Igual o menor que el precio actual es dato viejo o mal cargado. Usarlo
  // daría MENOS descuento que un cupón normal, que es lo contrario de lo que
  // el merchant pidió.
  for (const compareAt of [85, 80, 0]) {
    const r = computeOriginalPriceDiscount(10, [linea(85, compareAt)]);
    assert.ok(r.applies);
    if (!r.applies) return;
    assert.equal(r.lines[0].usedCompareAt, false, `compareAt=${compareAt}`);
    assert.equal(r.lines[0].discountPerUnit, 8.5);
  }
});

// ─── El recorte ──────────────────────────────────────────────────────────────

test("🔴 el descuento nunca deja la línea en negativo", () => {
  // $100 de lista rebajado a $10 (90% off) con un cupón del 20%: 20 sobre una
  // línea de 10. Se recorta a 10 y se marca, para que el preview lo diga.
  const r = computeOriginalPriceDiscount(20, [linea(10, 100)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].discountPerUnit, 10);
  assert.equal(r.lines[0].clamped, true);
});

test("sin recorte, `clamped` es false", () => {
  const r = computeOriginalPriceDiscount(10, [linea(85, 100)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].clamped, false);
});

// ─── Cantidades y varias líneas ──────────────────────────────────────────────

test("el descuento es POR UNIDAD y el ahorro total multiplica por cantidad", () => {
  const r = computeOriginalPriceDiscount(10, [linea(85, 100, 3)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].discountPerUnit, 10, "por unidad, no por línea");
  assert.equal(r.totalSavings, 30);
});

test("varias líneas, cada una con su propia base", () => {
  const r = computeOriginalPriceDiscount(10, [
    linea(85, 100, 1, "l1"), // rebajado → base 100
    linea(40, null, 2, "l2"), // sin rebaja → base 40
  ]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].discountPerUnit, 10);
  assert.equal(r.lines[1].discountPerUnit, 4);
  assert.equal(r.totalSavings, 10 + 4 * 2);
});

// ─── Dinero exacto ───────────────────────────────────────────────────────────

test("el cálculo va en centavos enteros: sin deriva de coma flotante", () => {
  // 85,50 × 10% da 8,549999… en float64. Tiene que dar 8,55 exacto.
  const r = computeOriginalPriceDiscount(10, [linea(70, 85.5)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].discountPerUnit, 8.55);
});

test("los porcentajes con decimales redondean al centavo", () => {
  const r = computeOriginalPriceDiscount(12.5, [linea(70, 100)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].discountPerUnit, 12.5);
});

// ─── Fail-closed ─────────────────────────────────────────────────────────────

test("un porcentaje ilegible o en cero no descuenta nada", () => {
  for (const malo of [NaN, Infinity, undefined as unknown as number]) {
    const r = computeOriginalPriceDiscount(malo, [linea(85, 100)]);
    assert.equal(r.applies, false);
    if (!r.applies) assert.equal(r.reason, "NO_CONFIG");
  }
  const cero = computeOriginalPriceDiscount(0, [linea(85, 100)]);
  assert.equal(cero.applies, false);
  if (!cero.applies) assert.equal(cero.reason, "ZERO_PERCENT");
});

test("las líneas con datos imposibles se descartan sin romper el resto", () => {
  const r = computeOriginalPriceDiscount(10, [
    { lineId: "", unitPrice: 100, compareAtUnitPrice: null, quantity: 1 },
    { lineId: "l2", unitPrice: NaN, compareAtUnitPrice: null, quantity: 1 },
    { lineId: "l3", unitPrice: 0, compareAtUnitPrice: null, quantity: 1 },
    linea(85, 100, 1, "l4"),
  ]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.deepEqual(
    r.lines.map((l) => l.lineId),
    ["l4"]
  );
});

test("un carrito sin ninguna línea válida no emite nada", () => {
  const r = computeOriginalPriceDiscount(10, []);
  assert.equal(r.applies, false);
  if (!r.applies) assert.equal(r.reason, "NOTHING_TO_DISCOUNT");
});

test("el porcentaje se topa en el máximo", () => {
  const r = computeOriginalPriceDiscount(500, [linea(1000, 1000)]);
  assert.ok(r.applies);
  if (!r.applies) return;
  assert.equal(r.lines[0].discountPerUnit, (1000 * MAX_ORIGINAL_PRICE_PERCENT) / 100);
});

// ─── resolveBasePrice ────────────────────────────────────────────────────────

test("resolveBasePrice tolera un comparativo no finito", () => {
  assert.deepEqual(resolveBasePrice(linea(85, NaN)), {
    basePrice: 85,
    usedCompareAt: false,
  });
});

// ─── Validación ──────────────────────────────────────────────────────────────

test("la validación exige un porcentaje usable", () => {
  assert.ok(validateOriginalPrice(0).errors.length > 0);
  assert.ok(validateOriginalPrice(-5).errors.length > 0);
  assert.ok(validateOriginalPrice(120).errors.length > 0);
  assert.deepEqual(validateOriginalPrice(10).errors, []);
});

test("la validación avisa de porcentajes que pueden dejar la línea en cero", () => {
  assert.deepEqual(validateOriginalPrice(10).warnings, []);
  assert.ok(validateOriginalPrice(60).warnings.length > 0);
});
