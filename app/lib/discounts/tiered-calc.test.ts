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
//
// Estrechan por `emit`, no por `mode`: desde que UNIFORM puede producir importes
// (campañas de monto fijo), el modo ya no determina qué trae el resultado. `emit`
// sí, y es el mismo campo por el que ramifica la Function.
function asUniform(out: TieredOutcome) {
  if (!out.applies || out.emit !== "PERCENTAGE")
    throw new Error(`esperaba UNIFORM en %, llegó ${JSON.stringify(out)}`);
  return out;
}

/** Cualquier resultado que se emita como importe: INCREMENTAL, o UNIFORM en monto. */
function asIncremental(out: TieredOutcome) {
  if (!out.applies || out.emit !== "FIXED_AMOUNT")
    throw new Error(`esperaba importes, llegó ${JSON.stringify(out)}`);
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
    { minQty: 4, percent: -5 }, // inválido: porcentaje negativo
    { minQty: 1, percent: 12 }, // duplicado: gana el último
  ]);
  assert.deepEqual(out, [
    { minQty: 1, percent: 12 },
    { minQty: 3, percent: 20 },
  ]);
});

test("normalizeTiers CONSERVA los niveles al 0% (son 'sin descuento', no basura)", () => {
  // Si el 0 se descartara, sus unidades heredarían el % del nivel anterior y
  // el "precio normal" que pidió el merchant se convertiría en un descuento.
  const out = normalizeTiers([
    { minQty: 1, percent: 0 },
    { minQty: 2, percent: 10 },
    { minQty: 3, percent: 15 },
  ]);
  assert.deepEqual(out, [
    { minQty: 1, percent: 0 },
    { minQty: 2, percent: 10 },
    { minQty: 3, percent: 15 },
  ]);
});

test("resolveTier devuelve el nivel de mayor minQty alcanzado", () => {
  assert.equal(resolveTier(TIERS, 0), null);
  assert.equal(resolveTier(TIERS, 1)?.percent, 10);
  assert.equal(resolveTier(TIERS, 2)?.percent, 15);
  assert.equal(resolveTier(TIERS, 99)?.percent, 20);
});

// ─── Niveles al 0% — "desde esta cantidad, precio normal" ─────────────────────

const TIERS_PRIMERA_GRATIS = [
  { minQty: 1, percent: 0 }, // 1ª unidad a precio normal
  { minQty: 2, percent: 10 },
  { minQty: 3, percent: 15 },
  { minQty: 4, percent: 20 },
];

test("0% en el PRIMER nivel: la 1ª unidad va a precio normal", () => {
  // 4 × $100 → 0% + 10% + 15% + 20% = $45 de descuento
  const out = asIncremental(
    computeTiered("INCREMENTAL", TIERS_PRIMERA_GRATIS, [line("a", 100, 4)])
  );
  assert.equal(out.totalDiscount, 45);
});

test("0% en el PRIMER nivel: comprar 1 sola unidad no genera descuento", () => {
  const out = asNoDiscount(
    computeTiered("INCREMENTAL", TIERS_PRIMERA_GRATIS, [line("a", 100, 1)])
  );
  assert.equal(out.reason, "zero-discount");
});

test("0% en un nivel INTERMEDIO: esa unidad no hereda el % del nivel anterior", () => {
  // Es el caso que el descarte silencioso rompía: sin conservar el 0, la 2ª
  // unidad heredaba el 10% del nivel de 1.
  // 3 × $100 → 10% + 0% + 20% = $30
  const tiers = [
    { minQty: 1, percent: 10 },
    { minQty: 2, percent: 0 },
    { minQty: 3, percent: 20 },
  ];
  const out = asIncremental(computeTiered("INCREMENTAL", tiers, [line("a", 100, 3)]));
  assert.equal(out.totalDiscount, 30);
});

test("0% en el ÚLTIMO nivel: corta el descuento a partir de esa cantidad", () => {
  // 5 × $100 → 10% + 15% + 0% + 0% + 0% = $25
  const tiers = [
    { minQty: 1, percent: 10 },
    { minQty: 2, percent: 15 },
    { minQty: 3, percent: 0 },
  ];
  const out = asIncremental(computeTiered("INCREMENTAL", tiers, [line("a", 100, 5)]));
  assert.equal(out.totalDiscount, 25);
});

test("0% con el reparto multilínea: la unidad sin descuento es la MÁS CARA", () => {
  // 2 × $100 y 2 × $50 → orden desc 100,100,50,50 → percents [0,10,15,20]
  //   línea cara:   0% + 10%  → $10.00
  //   línea barata: 15% + 20% → $17.50
  const out = computeTiered("INCREMENTAL", TIERS_PRIMERA_GRATIS, [
    line("cara", 100, 2),
    line("barata", 50, 2),
  ]);
  assert.equal(amountFor(out, "cara"), 10);
  assert.equal(amountFor(out, "barata"), 17.5);
});

test("UNIFORME con el nivel vigente al 0% → sin descuento (no emite un 0%)", () => {
  // Sin este corte se emitiría un descuento de valor 0 y el comprador vería
  // una línea de "-$0.00" en el carrito.
  const tiers = [
    { minQty: 1, percent: 0 },
    { minQty: 3, percent: 20 },
  ];
  const out = asNoDiscount(computeTiered("UNIFORM", tiers, [line("a", 100, 2)]));
  assert.equal(out.reason, "zero-discount");
});

test("UNIFORME por encima del nivel al 0% sí descuenta", () => {
  const tiers = [
    { minQty: 1, percent: 0 },
    { minQty: 3, percent: 20 },
  ];
  const out = asUniform(computeTiered("UNIFORM", tiers, [line("a", 100, 3)]));
  assert.equal(out.tier.percent, 20);
});

test("todos los niveles al 0% → sin descuento", () => {
  const tiers = [
    { minQty: 1, percent: 0 },
    { minQty: 2, percent: 0 },
  ];
  assert.equal(
    asNoDiscount(computeTiered("INCREMENTAL", tiers, [line("a", 100, 5)])).reason,
    "zero-discount"
  );
  assert.equal(
    asNoDiscount(computeTiered("UNIFORM", tiers, [line("a", 100, 5)])).reason,
    "zero-discount"
  );
});

test("campaña existente sin ceros: el comportamiento no cambia", () => {
  // Regresión explícita por Mudrad 2 (SkinUp), 3 niveles INCREMENTAL sin ceros.
  const out = asIncremental(computeTiered("INCREMENTAL", TIERS, [line("a", 100, 3)]));
  assert.equal(out.totalDiscount, 45);
  assert.deepEqual(normalizeTiers(TIERS), TIERS);
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
  assert.ok(v.errors.some((e) => e.includes("entre 0% y 99%")));
});

test("validateTiers ACEPTA un nivel al 0% junto a niveles con descuento", () => {
  const v = validateTiers([
    { minQty: 1, percent: 0 },
    { minQty: 2, percent: 10 },
    { minQty: 3, percent: 15 },
  ]);
  assert.equal(v.errors.length, 0);
});

test("validateTiers rechaza una campaña con TODOS los niveles al 0%", () => {
  const v = validateTiers([
    { minQty: 1, percent: 0 },
    { minQty: 2, percent: 0 },
  ]);
  assert.ok(v.errors.some((e) => e.includes("mayor que 0%")));
});

test("validateTiers acepta un porcentaje negativo como fuera de rango", () => {
  const v = validateTiers([{ minQty: 1, percent: -1 }]);
  assert.ok(v.errors.some((e) => e.includes("entre 0% y 99%")));
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

// ─── Montos fijos (valueType AMOUNT) ─────────────────────────────────────────
//
// Los dos primeros casos son literalmente el ejemplo que fijó la decisión de
// producto: un producto de $10 con niveles 1→$1, 2→$2, 3→$5 y 3 unidades.

const MONTOS = [
  { minQty: 1, amount: 1 },
  { minQty: 2, amount: 2 },
  { minQty: 3, amount: 5 },
];

test("AMOUNT INCREMENTAL — cada unidad paga según su nivel: 9 + 8 + 5", () => {
  const out = computeTiered("INCREMENTAL", MONTOS, [line("a", 10, 3)], "AMOUNT");
  assert.equal(out.applies, true);
  if (!out.applies) return;
  assert.equal(out.emit, "FIXED_AMOUNT");
  assert.equal(out.totalDiscount, 8); // 1 + 2 + 5
  assert.deepEqual(out.lines, [{ lineId: "a", discountAmount: 8 }]);
  // Subtotal 30 − 8 = 22, que es 9 + 8 + 5.
  assert.equal(30 - out.totalDiscount, 22);
});

test("AMOUNT UNIFORM — el mejor nivel se aplica a todas: 5 + 5 + 5", () => {
  const out = computeTiered("UNIFORM", MONTOS, [line("a", 10, 3)], "AMOUNT");
  assert.equal(out.applies, true);
  if (!out.applies) return;
  assert.equal(out.emit, "FIXED_AMOUNT");
  assert.equal(out.totalDiscount, 15); // 5 × 3 unidades
  assert.equal(30 - out.totalDiscount, 15);
});

test("AMOUNT UNIFORM emite importe, no porcentaje", () => {
  const out = computeTiered("UNIFORM", MONTOS, [line("a", 10, 3)], "AMOUNT");
  assert.equal(out.applies && out.emit, "FIXED_AMOUNT");
  // Y el porcentaje sigue emitiendo porcentaje, como siempre.
  const pct = computeTiered("UNIFORM", TIERS, [line("a", 10, 3)]);
  assert.equal(pct.applies && pct.emit, "PERCENTAGE");
});

test("el monto POR UNIDAD se multiplica por la cantidad de la linea", () => {
  const out = asIncremental(
    computeTiered("UNIFORM", [{ minQty: 2, amount: 3 }], [line("a", 20, 4)], "AMOUNT")
  );
  assert.equal(out.totalDiscount, 12); // 3 × 4 unidades
});

// ── La regla del monto que se pasa de precio ────────────────────────────────

test("monto MAYOR que el precio: ese producto no descuenta nada", () => {
  const out = computeTiered("UNIFORM", [{ minQty: 1, amount: 5 }], [line("a", 3, 2)], "AMOUNT");
  assert.equal(out.applies, false);
  if (out.applies) return;
  assert.equal(out.reason, "zero-discount");
});

test("monto IGUAL al precio: tampoco descuenta — nunca deja el precio en cero", () => {
  const out = computeTiered("UNIFORM", [{ minQty: 1, amount: 5 }], [line("a", 5, 1)], "AMOUNT");
  assert.equal(out.applies, false);
});

test("el precio nunca queda en cero ni en negativo", () => {
  for (const precio of [0.5, 1, 3, 4.99, 5]) {
    const out = computeTiered("UNIFORM", [{ minQty: 1, amount: 5 }], [line("a", precio, 1)], "AMOUNT");
    if (out.applies && out.emit === "FIXED_AMOUNT") {
      const restante = precio * out.totalQuantity - out.totalDiscount;
      assert.ok(restante > 0, `precio ${precio} quedo en ${restante}`);
    }
  }
});

test("UNIFORM: la linea que no aguanta el monto queda fuera, las demas descuentan", () => {
  const out = asIncremental(
    computeTiered(
      "UNIFORM",
      [{ minQty: 2, amount: 5 }],
      [line("barata", 3, 1), line("cara", 20, 1)],
      "AMOUNT"
    )
  );
  assert.deepEqual(out.lines, [{ lineId: "cara", discountAmount: 5 }]);
  assert.equal(out.totalDiscount, 5);
});

test("INCREMENTAL: la unidad cuyo nivel se pasa de precio se salta, las otras siguen", () => {
  // $10 con niveles 1→$1, 2→$2, 3→$50: la 3ª unidad no puede descontar $50.
  const out = asIncremental(
    computeTiered(
      "INCREMENTAL",
      [{ minQty: 1, amount: 1 }, { minQty: 2, amount: 2 }, { minQty: 3, amount: 50 }],
      [line("a", 10, 3)],
      "AMOUNT"
    )
  );
  assert.equal(out.totalDiscount, 3); // 1 + 2 + (la tercera no aplica)
});

// ── Retrocompatibilidad ─────────────────────────────────────────────────────

test("sin valueType se comporta como PERCENT — las campanas ya creadas no cambian", () => {
  const conDefecto = computeTiered("UNIFORM", TIERS, [line("a", 100, 3)]);
  const explicito = computeTiered("UNIFORM", TIERS, [line("a", 100, 3)], "PERCENT");
  assert.deepEqual(conDefecto, explicito);
});

test("niveles en monto leidos como PERCENT no descuentan (fail-closed)", () => {
  // Es lo que hara la Function VIEJA si le llega una campana de montos: no
  // encuentra `percent`, descarta todos los niveles y no aplica nada.
  const out = computeTiered("UNIFORM", MONTOS, [line("a", 10, 3)]);
  assert.equal(out.applies, false);
  if (out.applies) return;
  assert.equal(out.reason, "no-tiers");
});

// ── normalizeTiers y el 0 ───────────────────────────────────────────────────

test("normalizeTiers conserva el monto 0 y descarta negativos", () => {
  const out = normalizeTiers(
    [{ minQty: 1, amount: 0 }, { minQty: 2, amount: -3 }, { minQty: 3, amount: 4 }],
    "AMOUNT"
  );
  assert.deepEqual(out, [{ minQty: 1, amount: 0 }, { minQty: 3, amount: 4 }]);
});

test("un monto 0 intermedio no hereda el nivel anterior", () => {
  const out = asIncremental(
    computeTiered(
      "INCREMENTAL",
      [{ minQty: 1, amount: 1 }, { minQty: 2, amount: 0 }, { minQty: 3, amount: 2 }],
      [line("a", 10, 3)],
      "AMOUNT"
    )
  );
  assert.equal(out.totalDiscount, 3); // 1 + 0 + 2
});

// ── Validacion ──────────────────────────────────────────────────────────────

test("validateTiers en AMOUNT rechaza montos negativos", () => {
  const v = validateTiers([{ minQty: 1, amount: -1 }], { valueType: "AMOUNT" });
  assert.ok(v.errors.length > 0);
});

test("validateTiers en AMOUNT no aplica el tope del 99%", () => {
  const v = validateTiers([{ minQty: 1, amount: 500 }], { valueType: "AMOUNT" });
  assert.deepEqual(v.errors, []);
});

test("validateTiers rechaza todos los montos a 0", () => {
  const v = validateTiers([{ minQty: 1, amount: 0 }, { minQty: 2, amount: 0 }], {
    valueType: "AMOUNT",
  });
  assert.ok(v.errors.some((e) => e.includes("mayor que 0")));
});

test("validateTiers avisa de los montos que se pasan del precio de referencia", () => {
  const v = validateTiers([{ minQty: 1, amount: 2 }, { minQty: 2, amount: 50 }], {
    valueType: "AMOUNT",
    unitPrice: 10,
  });
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => w.includes("2 unidades")));
});

test("validateTiers da ERROR si NINGUN nivel cabe en el precio", () => {
  const v = validateTiers([{ minQty: 1, amount: 50 }], { valueType: "AMOUNT", unitPrice: 10 });
  assert.ok(v.errors.some((e) => e.includes("Ningún nivel")));
});

test("sin precio de referencia no se inventa ningun aviso", () => {
  const v = validateTiers([{ minQty: 1, amount: 999 }], { valueType: "AMOUNT" });
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(v.errors, []);
});

// ── Preview ─────────────────────────────────────────────────────────────────

test("preview en AMOUNT usa el mismo calculo que el checkout", () => {
  const rows = buildPreviewRows("INCREMENTAL", MONTOS, 10, "AMOUNT");
  assert.deepEqual(
    rows.map((r) => [r.quantity, r.saved, r.total]),
    [
      [1, 1, 9], // 1
      [2, 3, 17], // 1 + 2
      [3, 8, 22], // 1 + 2 + 5
      [4, 13, 27], // 1 + 2 + 5 + 5  (el ultimo nivel se mantiene)
    ]
  );
});
