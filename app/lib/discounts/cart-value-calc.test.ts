// Tests del cálculo de descuentos por valor de carrito.
//
// Los niveles de referencia son los que puso Jonas en el brief:
//   $50 → $10 off · $100 → $25 off · $200 → $70 off

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCartValue,
  normalizeCartValueTiers,
  resolveCartValueTier,
  resolveNextCartValueTier,
  cartValueDiscount,
  validateCartValue,
  MAX_CART_VALUE_TIERS,
  type CartValueOutcome,
  type CartValueTier,
} from "./cart-value-calc.ts";

const MONTOS: CartValueTier[] = [
  { minSubtotal: 50, amount: 10 },
  { minSubtotal: 100, amount: 25 },
  { minSubtotal: 200, amount: 70 },
];

const PORCENTAJES: CartValueTier[] = [
  { minSubtotal: 50, percent: 5 },
  { minSubtotal: 100, percent: 10 },
  { minSubtotal: 200, percent: 20 },
];

function aplica(o: CartValueOutcome): asserts o is Extract<CartValueOutcome, { applies: true }> {
  assert.equal(o.applies, true, `esperaba que aplicara: ${JSON.stringify(o)}`);
}
function noAplica(o: CartValueOutcome): asserts o is Extract<CartValueOutcome, { applies: false }> {
  assert.equal(o.applies, false, `esperaba que NO aplicara: ${JSON.stringify(o)}`);
}

// ─── Los niveles del brief ───────────────────────────────────────────────────

test("monto fijo: los tres niveles del brief", () => {
  const a = computeCartValue("AMOUNT", MONTOS, 60);
  aplica(a);
  assert.equal(a.emit, "FIXED_AMOUNT");
  assert.equal(a.amount, 10);

  const b = computeCartValue("AMOUNT", MONTOS, 120);
  aplica(b);
  assert.equal(b.amount, 25);

  const c = computeCartValue("AMOUNT", MONTOS, 250);
  aplica(c);
  assert.equal(c.amount, 70);
});

test("por debajo del primer umbral no descuenta, y dice cuánto falta", () => {
  const o = computeCartValue("AMOUNT", MONTOS, 40);
  noAplica(o);
  assert.equal(o.reason, "BELOW_FIRST_TIER");
  assert.deepEqual(o.nextTier, {
    faltante: 10,
    minSubtotal: 50,
    percent: undefined,
    amount: 10,
  });
});

test("justo en el umbral SÍ califica", () => {
  const o = computeCartValue("AMOUNT", MONTOS, 50);
  aplica(o);
  assert.equal(o.amount, 10, "«gastá $50» se cumple con exactamente $50");
});

test("por encima del último nivel se mantiene el último", () => {
  const o = computeCartValue("AMOUNT", MONTOS, 5000);
  aplica(o);
  assert.equal(o.amount, 70);
  assert.equal(o.nextTier, null, "ya no hay siguiente");
});

test("porcentaje: se calcula sobre el subtotal", () => {
  const o = computeCartValue("PERCENT", PORCENTAJES, 120);
  aplica(o);
  assert.equal(o.emit, "PERCENTAGE");
  assert.equal(o.percent, 10);
});

// ─── 🔴 La decisión de producto: el umbral se mide sobre lo ya rebajado ──────

test("🔴 el umbral se mide sobre el subtotal YA REBAJADO (opción B)", () => {
  // El caso exacto del brief: carrito de $110 con $15 de descuento de producto.
  // Esta función recibe el subtotal, no lo calcula — quien lo elige es la
  // Function, que toma `cart.cost.subtotalAmount`. El test fija la consecuencia.
  const conListaDePrecios = computeCartValue("AMOUNT", MONTOS, 110);
  aplica(conListaDePrecios);
  assert.equal(conListaDePrecios.amount, 25, "con $110 sí llegaría a $100");

  const yaRebajado = computeCartValue("AMOUNT", MONTOS, 95);
  aplica(yaRebajado);
  assert.equal(
    yaRebajado.amount,
    10,
    "con $95 cae al nivel de $50, NO al de $100 — es la opción B"
  );
  assert.equal(yaRebajado.nextTier!.faltante, 5, "y le faltan $5 para el de $100");
});

// ─── Dinero ──────────────────────────────────────────────────────────────────

test("el porcentaje no pierde el medio centavo", () => {
  // 45,50 al 15% da 38,674999999999997 en float64.
  assert.equal(cartValueDiscount({ minSubtotal: 0, percent: 15 }, "PERCENT", 45.5), 6.83);
  assert.equal(cartValueDiscount({ minSubtotal: 0, percent: 10 }, "PERCENT", 100), 10);
  assert.equal(cartValueDiscount({ minSubtotal: 0, percent: 20 }, "PERCENT", 270.2), 54.04);
});

test("🔴 el monto nunca supera el subtotal", () => {
  // Un metafield viejo o mal configurado no puede dejar el pedido en negativo.
  // La Function no puede confiar en que su config venga bien.
  const o = computeCartValue("AMOUNT", [{ minSubtotal: 10, amount: 999 }], 40);
  aplica(o);
  assert.equal(o.amount, 40, "recortado al subtotal, ni un centavo más");
});

test("un nivel en cero no emite descuento, y se distingue de no llegar", () => {
  const o = computeCartValue("AMOUNT", [{ minSubtotal: 50, amount: 0 }], 80);
  noAplica(o);
  assert.equal(
    o.reason,
    "TIER_AT_ZERO",
    "alcanzó el nivel pero descuenta 0 — no es lo mismo que no llegar"
  );
});

// ─── Normalización ───────────────────────────────────────────────────────────

test("normalizeCartValueTiers ordena, deduplica y descarta basura", () => {
  const out = normalizeCartValueTiers(
    [
      { minSubtotal: 200, amount: 70 },
      { minSubtotal: 50, amount: 10 },
      { minSubtotal: 100, amount: 20 },
      { minSubtotal: 100, amount: 25 }, // duplicado: gana el último
      { minSubtotal: NaN, amount: 5 },
      { minSubtotal: -10, amount: 5 },
      { minSubtotal: 300 }, // sin el campo de su tipo → fuera
      null,
      "basura",
    ],
    "AMOUNT"
  );
  assert.deepEqual(out, [
    { minSubtotal: 50, amount: 10 },
    { minSubtotal: 100, amount: 25 },
    { minSubtotal: 200, amount: 70 },
  ]);
});

test("los niveles del tipo equivocado se descartan", () => {
  // Un nivel en porcentaje leído como monto es basura, no un cero.
  assert.deepEqual(normalizeCartValueTiers(PORCENTAJES, "AMOUNT"), []);
  assert.deepEqual(normalizeCartValueTiers(MONTOS, "PERCENT"), []);
});

test("un nivel en CERO se conserva (es un interruptor, no basura)", () => {
  const out = normalizeCartValueTiers(
    [
      { minSubtotal: 50, amount: 10 },
      { minSubtotal: 500, amount: 0 },
    ],
    "AMOUNT"
  );
  assert.equal(out.length, 2);
  assert.equal(out[1].amount, 0);
});

test("resolveCartValueTier y resolveNextCartValueTier", () => {
  assert.equal(resolveCartValueTier(MONTOS, 20), null);
  assert.deepEqual(resolveCartValueTier(MONTOS, 150), { minSubtotal: 100, amount: 25 });
  assert.equal(resolveNextCartValueTier(MONTOS, 250), null);
  assert.equal(resolveNextCartValueTier(MONTOS, 60)!.faltante, 40);
});

// ─── Robustez de la Function ─────────────────────────────────────────────────

test("sin niveles no aplica en vez de reventar", () => {
  const o = computeCartValue("AMOUNT", [], 500);
  noAplica(o);
  assert.equal(o.reason, "NO_CONFIG");
});

test("subtotales imposibles no revientan", () => {
  for (const s of [0, -100, NaN, Infinity]) {
    const o = computeCartValue("AMOUNT", MONTOS, s);
    noAplica(o);
  }
});

// ─── Validación del formulario ───────────────────────────────────────────────

test("validateCartValue exige al menos un nivel con valor", () => {
  assert.ok(validateCartValue("AMOUNT", []).errors.length > 0);
  assert.ok(
    validateCartValue("AMOUNT", [{ minSubtotal: 50, amount: 0 }]).errors.length > 0
  );
});

test("🔴 un monto que iguala o supera su umbral es un error", () => {
  // "Gastá $50 y ahorrá $70" no es una oferta: el carrito quedaría en cero.
  const v = validateCartValue("AMOUNT", [{ minSubtotal: 50, amount: 70 }]);
  assert.ok(v.errors.some((e) => e.includes("umbral")));

  const igual = validateCartValue("AMOUNT", [{ minSubtotal: 50, amount: 50 }]);
  assert.ok(igual.errors.length > 0);

  const sano = validateCartValue("AMOUNT", MONTOS);
  assert.deepEqual(sano.errors, []);
});

test("avisa de un primer nivel en 0 y de curvas que bajan", () => {
  const desdeCero = validateCartValue("AMOUNT", [{ minSubtotal: 0, amount: 10 }]);
  assert.ok(desdeCero.warnings.some((w) => w.includes("cualquier carrito")));

  const baja = validateCartValue("PERCENT", [
    { minSubtotal: 50, percent: 20 },
    { minSubtotal: 100, percent: 10 },
  ]);
  assert.equal(baja.errors.length, 0);
  assert.ok(baja.warnings.some((w) => w.includes("menos que el anterior")));
});

test("más niveles del tope es un error", () => {
  const muchos = Array.from({ length: MAX_CART_VALUE_TIERS + 1 }, (_, i) => ({
    minSubtotal: (i + 1) * 10,
    amount: 1,
  }));
  assert.ok(validateCartValue("AMOUNT", muchos).errors.some((e) => e.includes("Máximo")));
});
