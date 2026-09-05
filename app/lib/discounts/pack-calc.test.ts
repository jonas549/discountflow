// Tests de la calculadora de packs armables.
// Runner nativo de Node, sin dependencias nuevas:  npm test
//
// Los primeros casos son los ejemplos del wireframe que curó Jonas, con los
// precios reales de ese diseño, para que el número que valida el test sea el
// mismo que se vio en la maqueta.

import test from "node:test";
import assert from "node:assert/strict";

import {
  computePack,
  buildPackPreview,
  normalizePackCatalog,
  normalizePackTiers,
  resolvePackTier,
  resolveNextPackTier,
  packMinimumProducts,
  savingsCents,
  MIN_PACK_PRODUCTS,
  type PackOutcome,
  type PackApplicableLine,
} from "./pack-calc.ts";
import { validatePack, MAX_PACK_CATALOG } from "./pack-validate.ts";

// Catálogo del wireframe (modo A: cada producto con su %).
const CATALOGO_A = [
  { productId: "gid://shopify/Product/serum", percent: 10 },
  { productId: "gid://shopify/Product/crema", percent: 15 },
  { productId: "gid://shopify/Product/tonico", percent: 20 },
  { productId: "gid://shopify/Product/spf", percent: 12 },
];

// Catálogo del wireframe (modo B: los % salen de los niveles).
const CATALOGO_B = CATALOGO_A.map((p) => ({ productId: p.productId }));

const TIERS_B = [
  { minProducts: 2, percent: 10 },
  { minProducts: 3, percent: 20 },
  { minProducts: 4, percent: 30 },
];

const PRECIOS: Record<string, number> = {
  "gid://shopify/Product/serum": 18990,
  "gid://shopify/Product/crema": 15490,
  "gid://shopify/Product/tonico": 9990,
  "gid://shopify/Product/spf": 13990,
};

/** Arma líneas de carrito a partir de los ids cortos del wireframe. */
function lineas(...claves: string[]): PackApplicableLine[] {
  return claves.map((c, i) => {
    const productId = `gid://shopify/Product/${c}`;
    return {
      lineId: `gid://shopify/CartLine/${i}`,
      productId,
      unitPrice: PRECIOS[productId],
      quantity: 1,
    };
  });
}

function assertAplica(
  o: PackOutcome
): asserts o is Extract<PackOutcome, { applies: true }> {
  assert.equal(o.applies, true, `esperaba que aplicara, dio ${JSON.stringify(o)}`);
}

function assertNoAplica(
  o: PackOutcome
): asserts o is Extract<PackOutcome, { applies: false }> {
  assert.equal(o.applies, false, `esperaba que NO aplicara, dio ${JSON.stringify(o)}`);
}

// ─── Modo A · descuento por producto ─────────────────────────────────────────

test("modo A: cada producto lleva su propio porcentaje", () => {
  const o = computePack("PER_PRODUCT", CATALOGO_A, [], lineas("serum", "crema", "tonico"));
  assertAplica(o);
  assert.deepEqual(
    o.lines.map((l) => l.percent),
    [10, 15, 20]
  );
  assert.equal(o.distinctProducts, 3);
  assert.equal(o.appliedPercent, null, "en modo A no hay un % único del pack");
  assert.equal(o.nextTier, null, "en modo A no hay niveles siguientes");
});

test("modo A: el ahorro del wireframe con 3 productos", () => {
  const p = buildPackPreview("PER_PRODUCT", CATALOGO_A, [], lineas("serum", "crema", "tonico"));
  // 18990×10% + 15490×15% + 9990×20% = 1899 + 2323,5 + 1998 = 6220,5
  assert.equal(p.subtotal, 44470);
  assert.equal(p.savings, 6220.5);
  assert.equal(p.total, 38249.5);
});

test("modo A: con 1 solo producto el pack NO aplica", () => {
  const o = computePack("PER_PRODUCT", CATALOGO_A, [], lineas("serum"));
  assertNoAplica(o);
  assert.equal(o.reason, "BELOW_MINIMUM");
  assert.equal(o.distinctProducts, 1);
  assert.deepEqual(o.nextTier, { productsNeeded: 1, percent: 0 });
});

test("modo A: un producto al 0% entra al pack pero no se emite candidate", () => {
  const catalogo = [
    { productId: "gid://shopify/Product/serum", percent: 0 },
    { productId: "gid://shopify/Product/crema", percent: 15 },
  ];
  const o = computePack("PER_PRODUCT", catalogo, [], lineas("serum", "crema"));
  assertAplica(o);
  assert.equal(o.distinctProducts, 2, "el 0% SÍ cuenta para el mínimo");
  assert.equal(o.lines.length, 1, "pero no genera descuento");
  assert.equal(o.lines[0].percent, 15);
});

test("modo A: si todos están al 0% no aplica en vez de emitir -$0.00", () => {
  const catalogo = [
    { productId: "gid://shopify/Product/serum", percent: 0 },
    { productId: "gid://shopify/Product/crema", percent: 0 },
  ];
  const o = computePack("PER_PRODUCT", catalogo, [], lineas("serum", "crema"));
  assertNoAplica(o);
  assert.equal(o.reason, "NOTHING_TO_DISCOUNT");
});

// ─── Modo B · descuento por tamaño del pack ──────────────────────────────────

test("modo B: los tres niveles del wireframe", () => {
  const dos = computePack("PACK_SIZE", CATALOGO_B, TIERS_B, lineas("serum", "crema"));
  assertAplica(dos);
  assert.equal(dos.appliedPercent, 10);
  assert.deepEqual(dos.lines.map((l) => l.percent), [10, 10]);

  const tres = computePack("PACK_SIZE", CATALOGO_B, TIERS_B, lineas("serum", "crema", "tonico"));
  assertAplica(tres);
  assert.equal(tres.appliedPercent, 20);

  const cuatro = computePack(
    "PACK_SIZE",
    CATALOGO_B,
    TIERS_B,
    lineas("serum", "crema", "tonico", "spf")
  );
  assertAplica(cuatro);
  assert.equal(cuatro.appliedPercent, 30);
});

test("modo B: el nivel se mantiene por encima del último tramo", () => {
  const catalogo = [...CATALOGO_B, { productId: "gid://shopify/Product/extra" }];
  const lines = [
    ...lineas("serum", "crema", "tonico", "spf"),
    {
      lineId: "gid://shopify/CartLine/4",
      productId: "gid://shopify/Product/extra",
      unitPrice: 5000,
      quantity: 1,
    },
  ];
  const o = computePack("PACK_SIZE", catalogo, TIERS_B, lines);
  assertAplica(o);
  assert.equal(o.appliedPercent, 30, "5 productos siguen en el tramo de '4 o más'");
  assert.equal(o.nextTier, null, "ya no hay siguiente nivel");
});

test("modo B: el aviso dice cuántos productos faltan y qué se gana", () => {
  const dos = computePack("PACK_SIZE", CATALOGO_B, TIERS_B, lineas("serum", "crema"));
  assertAplica(dos);
  assert.deepEqual(dos.nextTier, { productsNeeded: 1, percent: 20 });

  const cero = computePack("PACK_SIZE", CATALOGO_B, TIERS_B, []);
  assertNoAplica(cero);
  assert.equal(cero.reason, "BELOW_MINIMUM");
  assert.deepEqual(cero.nextTier, { productsNeeded: 2, percent: 10 });
});

test("modo B: el ahorro del wireframe con 2 productos al 10%", () => {
  const p = buildPackPreview("PACK_SIZE", CATALOGO_B, TIERS_B, lineas("serum", "crema"));
  // (18990 + 15490) × 10% = 3448
  assert.equal(p.subtotal, 34480);
  assert.equal(p.savings, 3448);
  assert.equal(p.total, 31032);
  assert.equal(p.appliedPercent, 10);
});

// ─── 🔴 La decisión de producto que define el tipo ───────────────────────────

test("modo B cuenta PRODUCTOS DISTINTOS, no unidades", () => {
  // Dos unidades del MISMO producto. Si contara unidades esto sería un nivel de
  // 2 y el pack aplicaría. Decisión del 2026-09-05: NO alcanza.
  const dosUnidades: PackApplicableLine[] = [
    {
      lineId: "gid://shopify/CartLine/0",
      productId: "gid://shopify/Product/serum",
      unitPrice: 18990,
      quantity: 2,
    },
  ];
  const o = computePack("PACK_SIZE", CATALOGO_B, TIERS_B, dosUnidades);
  assertNoAplica(o);
  assert.equal(o.reason, "BELOW_MINIMUM");
  assert.equal(o.distinctProducts, 1, "2 unidades de 1 producto son 1 producto distinto");
});

test("dos líneas del mismo producto (variantes distintas) cuentan como uno", () => {
  const dosVariantes: PackApplicableLine[] = [
    {
      lineId: "gid://shopify/CartLine/0",
      productId: "gid://shopify/Product/serum",
      unitPrice: 18990,
      quantity: 1,
    },
    {
      lineId: "gid://shopify/CartLine/1",
      productId: "gid://shopify/Product/serum",
      unitPrice: 20990,
      quantity: 1,
    },
  ];
  const o = computePack("PACK_SIZE", CATALOGO_B, TIERS_B, dosVariantes);
  assertNoAplica(o);
  assert.equal(o.distinctProducts, 1);
});

test("la cantidad NO mueve el nivel pero SÍ el ahorro de la línea", () => {
  const lines: PackApplicableLine[] = [
    {
      lineId: "gid://shopify/CartLine/0",
      productId: "gid://shopify/Product/serum",
      unitPrice: 10000,
      quantity: 3,
    },
    {
      lineId: "gid://shopify/CartLine/1",
      productId: "gid://shopify/Product/crema",
      unitPrice: 10000,
      quantity: 1,
    },
  ];
  const p = buildPackPreview("PACK_SIZE", CATALOGO_B, TIERS_B, lines);
  assert.equal(p.appliedPercent, 10, "2 productos distintos = nivel 1, da igual la cantidad");
  assert.equal(p.subtotal, 40000);
  assert.equal(p.savings, 4000, "el % se aplica a la línea completa, 3 unidades incluidas");
});

// ─── Dinero ──────────────────────────────────────────────────────────────────

test("el medio centavo no se pierde (regresión del 2026-08-08)", () => {
  // 45,50 al 15% da 38,674999999999997 en float64. En centavos enteros es exacto.
  assert.equal(savingsCents(45.5, 1, 15), 683); // 4550 × 15 / 100 = 682,5 → 683
  assert.equal(savingsCents(100, 1, 10), 1000);
  assert.equal(savingsCents(9990, 1, 20), 199800);
});

test("savingsCents es defensivo con entradas basura", () => {
  assert.equal(savingsCents(NaN, 1, 10), 0);
  assert.equal(savingsCents(100, 0, 10), 0);
  assert.equal(savingsCents(100, 1, 0), 0);
  assert.equal(savingsCents(100, 1, -5), 0);
  assert.equal(savingsCents(-100, 1, 10), 0);
});

// ─── Normalización ───────────────────────────────────────────────────────────

test("normalizePackCatalog descarta basura y deduplica", () => {
  const out = normalizePackCatalog([
    { productId: "a", percent: 10 },
    { productId: "a", percent: 99 }, // duplicado: gana el primero
    { productId: "", percent: 10 },
    { percent: 10 },
    null,
    "no soy un objeto",
    { productId: "b" },
    { productId: "c", percent: -5 }, // negativo → sin percent
    { productId: "d", percent: 150 }, // por encima del tope → recortado
  ]);
  assert.deepEqual(out, [
    { productId: "a", percent: 10 },
    { productId: "b" },
    { productId: "c" },
    { productId: "d", percent: 99 },
  ]);
});

test("normalizePackTiers ordena, recorta y respeta el mínimo duro", () => {
  const out = normalizePackTiers([
    { minProducts: 4, percent: 30 },
    { minProducts: 2, percent: 10 },
    { minProducts: 1, percent: 5 }, // por debajo del mínimo duro → fuera
    { minProducts: 3, percent: 20 },
    { minProducts: 3, percent: 25 }, // duplicado: gana el último
    { minProducts: NaN, percent: 10 },
    { minProducts: 5, percent: -1 },
  ]);
  assert.deepEqual(out, [
    { minProducts: 2, percent: 10 },
    { minProducts: 3, percent: 25 },
    { minProducts: 4, percent: 30 },
  ]);
});

test("normalizePackTiers conserva los 0% (son un interruptor, no basura)", () => {
  const out = normalizePackTiers([
    { minProducts: 2, percent: 0 },
    { minProducts: 3, percent: 20 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].percent, 0);
});

test("resolvePackTier y resolveNextPackTier", () => {
  assert.equal(resolvePackTier(TIERS_B, 1), null);
  assert.deepEqual(resolvePackTier(TIERS_B, 2), { minProducts: 2, percent: 10 });
  assert.deepEqual(resolvePackTier(TIERS_B, 9), { minProducts: 4, percent: 30 });
  assert.deepEqual(resolveNextPackTier(TIERS_B, 1), { productsNeeded: 1, percent: 10 });
  assert.equal(resolveNextPackTier(TIERS_B, 4), null);
});

test("packMinimumProducts", () => {
  assert.equal(packMinimumProducts("PER_PRODUCT", []), MIN_PACK_PRODUCTS);
  assert.equal(packMinimumProducts("PACK_SIZE", TIERS_B), 2);
  assert.equal(packMinimumProducts("PACK_SIZE", [{ minProducts: 3, percent: 20 }]), 3);
  assert.equal(packMinimumProducts("PACK_SIZE", []), MIN_PACK_PRODUCTS);
});

// ─── Robustez de la Function ─────────────────────────────────────────────────

test("modo B sin niveles no aplica en vez de reventar", () => {
  const o = computePack("PACK_SIZE", CATALOGO_B, [], lineas("serum", "crema"));
  assertNoAplica(o);
  assert.equal(o.reason, "NO_CONFIG");
});

test("carrito vacío no aplica", () => {
  const a = computePack("PER_PRODUCT", CATALOGO_A, [], []);
  assertNoAplica(a);
  assert.equal(a.distinctProducts, 0);
});

test("una línea cuyo producto no está en el catálogo recibe 0% en modo A", () => {
  // El filtro de pertenencia vive en el llamador, pero si algo se cuela, el
  // producto sin % configurado no genera descuento.
  const lines = [
    ...lineas("serum"),
    {
      lineId: "gid://shopify/CartLine/9",
      productId: "gid://shopify/Product/intruso",
      unitPrice: 99999,
      quantity: 1,
    },
  ];
  const o = computePack("PER_PRODUCT", CATALOGO_A, [], lines);
  assertAplica(o);
  assert.equal(o.lines.length, 1);
  assert.equal(o.lines[0].lineId, "gid://shopify/CartLine/0");
});

// ─── Validación del formulario ───────────────────────────────────────────────

test("validatePack exige productos suficientes", () => {
  assert.ok(validatePack("PER_PRODUCT", [], []).errors.length > 0);
  assert.ok(
    validatePack("PER_PRODUCT", [{ productId: "a", percent: 10 }], []).errors.length > 0,
    "un pack de 1 producto no es un pack"
  );
  const muchos = Array.from({ length: MAX_PACK_CATALOG + 1 }, (_, i) => ({
    productId: `p${i}`,
    percent: 10,
  }));
  assert.ok(validatePack("PER_PRODUCT", muchos, []).errors.some((e) => e.includes("hasta")));
});

test("validatePack: modo A sin ningún descuento es un error", () => {
  const v = validatePack(
    "PER_PRODUCT",
    [
      { productId: "a", percent: 0 },
      { productId: "b", percent: 0 },
    ],
    []
  );
  assert.ok(v.errors.length > 0);
});

test("validatePack: modo A con algunos al 0% avisa pero no bloquea", () => {
  const v = validatePack(
    "PER_PRODUCT",
    [
      { productId: "a", percent: 0 },
      { productId: "b", percent: 10 },
    ],
    []
  );
  assert.deepEqual(v.errors, []);
  assert.equal(v.warnings.length, 1);
});

test("validatePack: modo B avisa de niveles inalcanzables y de curvas que bajan", () => {
  const catalogo = [{ productId: "a" }, { productId: "b" }];
  const v = validatePack("PACK_SIZE", catalogo, [
    { minProducts: 2, percent: 20 },
    { minProducts: 5, percent: 10 },
  ]);
  assert.deepEqual(v.errors, []);
  assert.equal(v.warnings.length, 2, "inalcanzable + descuento que baja");
});

test("validatePack: modo B sin niveles es un error", () => {
  const v = validatePack("PACK_SIZE", [{ productId: "a" }, { productId: "b" }], []);
  assert.ok(v.errors.length > 0);
});
