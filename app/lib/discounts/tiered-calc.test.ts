// Tests de la calculadora de descuentos escalonados.
// Runner nativo de Node, sin dependencias nuevas:  npm test
//
// Los primeros casos son literalmente los ejemplos del brief de la feature.

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeTiered,
  normalizeTiers,
  resolveTier,
  validateTiers,
  buildPreviewRows,
  type TieredOutcome,
} from "./tiered-calc.ts";

const TIERS = [
  { minQty: 1, percent: 10 },
  { minQty: 2, percent: 15 },
  { minQty: 3, percent: 20 },
];

const line = (lineId: string, unitPrice: number, quantity: number) => ({
  lineId,
  unitPrice,
  quantity,
});

// Helpers de aserción que además estrechan el tipo de la unión discriminada.
function asUniform(out: TieredOutcome) {
  if (!out.applies || out.mode !== "UNIFORM")
    throw new Error(`esperaba UNIFORM, llegó ${JSON.stringify(out)}`);
  return out;
}

function asIncremental(out: TieredOutcome) {
  if (!out.applies || out.mode !== "INCREMENTAL")
    throw new Error(`esperaba INCREMENTAL, llegó ${JSON.stringify(out)}`);
  return out;
}

function asNoDiscount(out: TieredOutcome) {
  if (out.applies)
    throw new Error(`esperaba SIN descuento, llegó ${JSON.stringify(out)}`);
  return out;
}

function amountFor(out: TieredOutcome, lineId: string): number {
  const found = asIncremental(out).lines.find((l) => l.lineId === lineId);
  if (!found) throw new Error(`la línea "${lineId}" no recibió descuento`);
  return found.discountAmount;
}

// ─── MODO A — UNIFORME ────────────────────────────────────────────────────────

test("UNIFORME: 3 productos de $100 → los 3 al 20% → paga $240", () => {
  const out = asUniform(computeTiered("UNIFORM", TIERS, [line("l1", 100, 3)]));
  assert.equal(out.tier.percent, 20);
  assert.deepEqual(out.lines, [{ lineId: "l1", percent: 20 }]);
  assert.equal(300 - (300 * out.tier.percent) / 100, 240);
});

test("UNIFORME: 1 producto → 10% → paga $90; 2 productos → 15% → paga $170", () => {
  const uno = asUniform(computeTiered("UNIFORM", TIERS, [line("l1", 100, 1)]));
  assert.equal(uno.tier.percent, 10);
  assert.equal(100 - (100 * uno.tier.percent) / 100, 90);

  const dos = asUniform(computeTiered("UNIFORM", TIERS, [line("l1", 100, 2)]));
  assert.equal(dos.tier.percent, 15);
  assert.equal(200 - (200 * dos.tier.percent) / 100, 170);
});

test("UNIFORME: todas las líneas aplicables reciben el mismo %", () => {
  const out = asUniform(
    computeTiered("UNIFORM", TIERS, [line("a", 100, 1), line("b", 50, 2)])
  );
  assert.equal(out.totalQuantity, 3);
  assert.deepEqual(out.lines, [
    { lineId: "a", percent: 20 },
    { lineId: "b", percent: 20 },
  ]);
});

// ─── MODO B — INCREMENTAL ─────────────────────────────────────────────────────

test("INCREMENTAL: 3 productos de $100 → 10%+15%+20% → paga $255", () => {
  const out = asIncremental(
    computeTiered("INCREMENTAL", TIERS, [line("l1", 100, 3)])
  );
  assert.equal(out.totalDiscount, 45); // 10 + 15 + 20
  assert.deepEqual(out.lines, [{ lineId: "l1", discountAmount: 45 }]);
  assert.equal(300 - out.totalDiscount, 255);
});

test("INCREMENTAL: 2 productos de $100 → 10%+15% → paga $175", () => {
  const out = asIncremental(
    computeTiered("INCREMENTAL", TIERS, [line("l1", 100, 2)])
  );
  assert.equal(out.totalDiscount, 25);
  assert.equal(200 - out.totalDiscount, 175);
});

test("INCREMENTAL: el % MÁS ALTO va a la unidad MÁS BARATA", () => {
  // $200, $100, $50 → de cara a barata reciben 10%, 15% y 20%
  //   200 × 10% = 20   |   100 × 15% = 15   |   50 × 20% = 10
  const out = computeTiered("INCREMENTAL", TIERS, [
    line("cara", 200, 1),
    line("media", 100, 1),
    line("barata", 50, 1),
  ]);
  assert.deepEqual(asIncremental(out).lines, [
    { lineId: "cara", discountAmount: 20 },
    { lineId: "media", discountAmount: 15 },
    { lineId: "barata", discountAmount: 10 },
  ]);
  assert.equal(asIncremental(out).totalDiscount, 45);

  // La más barata se llevó el 20%, el nivel más alto.
  assert.equal(amountFor(out, "barata"), 50 * 0.2);
});

test("INCREMENTAL: reparte el descuento entre líneas distintas", () => {
  // 3 unidades a $100 en 2 líneas. Empate de precio → desempate por lineId:
  // "a" toma las posiciones 1 y 2, "b" la 3.
  const out = asIncremental(
    computeTiered("INCREMENTAL", TIERS, [line("a", 100, 2), line("b", 100, 1)])
  );
  assert.deepEqual(out.lines, [
    { lineId: "a", discountAmount: 25 }, // 10 + 15
    { lineId: "b", discountAmount: 20 }, // 20
  ]);
  assert.equal(out.totalDiscount, 45);
});

test("INCREMENTAL: el resultado no depende del orden de entrada de las líneas", () => {
  const ab = computeTiered("INCREMENTAL", TIERS, [
    line("a", 100, 1),
    line("b", 100, 1),
  ]);
  const ba = computeTiered("INCREMENTAL", TIERS, [
    line("b", 100, 1),
    line("a", 100, 1),
  ]);
  assert.equal(amountFor(ab, "a"), amountFor(ba, "a"));
  assert.equal(amountFor(ab, "b"), amountFor(ba, "b"));
  assert.equal(asIncremental(ab).totalDiscount, asIncremental(ba).totalDiscount);
});

// ─── Tope: unidades más allá del último nivel ─────────────────────────────────

test("las unidades por encima del último nivel conservan el último %", () => {
  const uniforme = asUniform(
    computeTiered("UNIFORM", TIERS, [line("l1", 100, 5)])
  );
  assert.equal(uniforme.tier.percent, 20);

  // 10 + 15 + 20 + 20 + 20 = 85
  const incremental = asIncremental(
    computeTiered("INCREMENTAL", TIERS, [line("l1", 100, 5)])
  );
  assert.equal(incremental.totalDiscount, 85);
});

// ─── Casos borde ──────────────────────────────────────────────────────────────

test("carrito vacío → sin descuento", () => {
  for (const modo of ["UNIFORM", "INCREMENTAL"] as const) {
    assert.equal(asNoDiscount(computeTiered(modo, TIERS, [])).reason, "no-lines");
  }
});

test("sin niveles configurados → sin descuento", () => {
  const out = asNoDiscount(computeTiered("UNIFORM", [], [line("l1", 100, 3)]));
  assert.equal(out.reason, "no-tiers");
});

test("cantidad por debajo del primer nivel → sin descuento", () => {
  const tiers = [{ minQty: 3, percent: 20 }];
  for (const modo of ["UNIFORM", "INCREMENTAL"] as const) {
    const out = asNoDiscount(computeTiered(modo, tiers, [line("l1", 100, 2)]));
    assert.equal(out.reason, "below-first-tier");
  }
});

test("líneas inválidas (cantidad 0, precio negativo) se descartan", () => {
  const out = asUniform(
    computeTiered("UNIFORM", TIERS, [
      line("malo", 100, 0),
      line("peor", -5, 2),
      line("bueno", 100, 3),
    ])
  );
  assert.equal(out.totalQuantity, 3);
  assert.deepEqual(out.lines, [{ lineId: "bueno", percent: 20 }]);
});

test("productos gratis ($0) no generan descuento fantasma", () => {
  const out = asNoDiscount(
    computeTiered("INCREMENTAL", TIERS, [line("gratis", 0, 3)])
  );
  assert.equal(out.reason, "zero-discount");
});

test("redondeo a centavos: $33.33 al 15% → $5.00", () => {
  // 3333 centavos × 15% = 499.95 → 500 centavos
  const out = asIncremental(
    computeTiered("INCREMENTAL", [{ minQty: 1, percent: 15 }], [
      line("l1", 33.33, 1),
    ])
  );
  assert.equal(out.totalDiscount, 5);
});

// ─── normalizeTiers / resolveTier ─────────────────────────────────────────────

test("normalizeTiers ordena, limpia y colapsa duplicados", () => {
  const out = normalizeTiers([
    { minQty: 3, percent: 20 },
    { minQty: 1, percent: 10 },
    { minQty: 0, percent: 50 }, // inválido: minQty < 1
    { minQty: 2, percent: 0 }, // inválido: percent = 0
    { minQty: 1, percent: 12 }, // duplicado: gana el último
  ]);
  assert.deepEqual(out, [
    { minQty: 1, percent: 12 },
    { minQty: 3, percent: 20 },
  ]);
});

test("resolveTier devuelve el nivel de mayor minQty alcanzado", () => {
  assert.equal(resolveTier(TIERS, 0), null);
  assert.equal(resolveTier(TIERS, 1)?.percent, 10);
  assert.equal(resolveTier(TIERS, 2)?.percent, 15);
  assert.equal(resolveTier(TIERS, 99)?.percent, 20);
});

// ─── validateTiers ────────────────────────────────────────────────────────────

test("validateTiers exige al menos un nivel", () => {
  assert.equal(validateTiers([]).errors.length, 1);
});

test("validateTiers detecta cantidades duplicadas y % fuera de rango", () => {
  const v = validateTiers([
    { minQty: 1, percent: 10 },
    { minQty: 1, percent: 20 },
    { minQty: 2, percent: 150 },
  ]);
  assert.ok(v.errors.some((e) => e.includes("misma cantidad")));
  assert.ok(v.errors.some((e) => e.includes("entre 1% y 99%")));
});

test("validateTiers avisa (sin bloquear) si un nivel posterior descuenta menos", () => {
  const v = validateTiers([
    { minQty: 1, percent: 20 },
    { minQty: 2, percent: 10 },
  ]);
  assert.equal(v.errors.length, 0);
  assert.equal(v.warnings.length, 1);
});

test("validateTiers acepta la configuración del brief", () => {
  assert.deepEqual(validateTiers(TIERS), { errors: [], warnings: [] });
});

// ─── Preview ──────────────────────────────────────────────────────────────────

test("preview UNIFORME reproduce la tabla del brief", () => {
  const rows = buildPreviewRows("UNIFORM", TIERS, 100);
  assert.equal(rows.length, 4); // 3 niveles + la fila "4+"
  assert.deepEqual(
    rows.map((r) => [r.quantity, r.percent, r.total]),
    [
      [1, 10, 90],
      [2, 15, 170],
      [3, 20, 240],
      [4, 20, 320], // el último nivel se mantiene
    ]
  );
  assert.equal(rows[3].isBeyondLastTier, true);
});

test("preview INCREMENTAL muestra totales distintos con los mismos niveles", () => {
  const rows = buildPreviewRows("INCREMENTAL", TIERS, 100);
  assert.deepEqual(
    rows.map((r) => [r.quantity, r.total]),
    [
      [1, 90], // 10
      [2, 175], // 10 + 15
      [3, 255], // 10 + 15 + 20
      [4, 335], // 10 + 15 + 20 + 20
    ]
  );
});

test("preview sin niveles no revienta", () => {
  assert.deepEqual(buildPreviewRows("UNIFORM", [], 100), []);
});
