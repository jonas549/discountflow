// La exclusión entre campañas, y las reglas de combinación que la hacen posible.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 EL FALLO QUE ORIGINÓ TODO ESTO
//
// 2026-09-05, tienda de dev. Carrito con un pack de 4 productos, $278 de lista.
// El pack aplicó su 30% y dejó el carrito en $194,60. El descuento por monto de
// compra, que a $194,60 tenía que dar $25, NO APARECIÓ. Ni en el carrito, ni en
// un log, ni en ningún sitio.
//
// La causa se leyó de la propia tienda:
//
//   [DiscountFlow] Pack prueba       PRODUCT  order:false  product:false
//   [DiscountFlow · PRUEBA F1] ...   ORDER    order:false  product:true
//
// `combinesWith` es BILATERAL. Con que UNO diga que no, Shopify descarta al
// otro — y no se lo dice a nadie.
//
// Estos tests fijan las dos mitades del arreglo: que las reglas de combinación
// dejen pasar, y que la decisión de quién gana viaje al metafield para que la
// tome la Function con un motivo registrado.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  toCartValueFunctionConfig,
  cartValueDiscountMessage,
  cartValueLabel,
  cartValueMinimum,
  CART_VALUE_DEFAULT_MESSAGE,
  type CartValueCampaignConfig,
} from "./cart-value-client.ts";
import {
  parseCartValueForm,
  validateCartValueForm,
  buildCartValueConfig,
} from "./cart-value-form.ts";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const leer = (p: string) => fs.readFileSync(path.join(RAIZ, p), "utf8");

const BASE: CartValueCampaignConfig = {
  valueType: "AMOUNT",
  tiers: [
    { minSubtotal: 50, amount: 10 },
    { minSubtotal: 100, amount: 25 },
    { minSubtotal: 200, amount: 70 },
  ],
};

// ─── Lo que viaja al metafield ───────────────────────────────────────────────

test("🔴 la lista de exclusiones llega al metafield de la Function", () => {
  const cfg = toCartValueFunctionConfig({
    ...BASE,
    excludedPackCampaignIds: ["camp_pack_a", "camp_pack_b"],
  });
  assert.deepEqual(cfg.excludeIfPackIds, ["camp_pack_a", "camp_pack_b"]);
});

test("sin exclusiones viaja una lista vacía, no `undefined`", () => {
  // La Function comprueba `Array.isArray`. Un `undefined` funcionaría igual hoy,
  // pero un campo que a veces está y a veces no es una fuente de bugs futuros.
  const cfg = toCartValueFunctionConfig(BASE);
  assert.deepEqual(cfg.excludeIfPackIds, []);
});

test("al metafield NO viaja nada de presentación", () => {
  const cfg = toCartValueFunctionConfig({ ...BASE, shopifyDiscountId: "gid://x" });
  assert.deepEqual(
    Object.keys(cfg).sort(),
    ["excludeIfPackIds", "message", "tiers", "valueType"]
  );
});

test("los niveles llegan normalizados y ordenados", () => {
  const cfg = toCartValueFunctionConfig({
    valueType: "PERCENT",
    tiers: [
      { minSubtotal: 200, percent: 20 },
      { minSubtotal: 50, percent: 5 },
      // Sin `percent` en modo PERCENT: basura, se descarta.
      { minSubtotal: 999, amount: 10 },
    ],
  });
  assert.deepEqual(cfg.tiers, [
    { minSubtotal: 50, percent: 5 },
    { minSubtotal: 200, percent: 20 },
  ]);
});

test("el mensaje por defecto es el mismo que el de la Function", () => {
  assert.equal(cartValueDiscountMessage(BASE), CART_VALUE_DEFAULT_MESSAGE);
  assert.equal(cartValueDiscountMessage({ ...BASE, message: "  " }), CART_VALUE_DEFAULT_MESSAGE);
  assert.equal(cartValueDiscountMessage({ ...BASE, message: "Ahorro" }), "Ahorro");

  const fn = leer("extensions/order-discount/src/cart_lines_discounts_generate_run.ts");
  assert.ok(
    fn.includes(`'${CART_VALUE_DEFAULT_MESSAGE}'`),
    "🔴 el texto por defecto tiene que coincidir con el de la Function: es el que " +
      "ve el comprador si el merchant no escribe ninguno"
  );
});

test("el resumen del listado y el mínimo salen de los niveles", () => {
  assert.equal(cartValueMinimum(BASE), 50);
  assert.equal(cartValueMinimum({ ...BASE, tiers: [] }), 0);
  assert.match(cartValueLabel(BASE), /50\+ → −10/);
  assert.equal(cartValueLabel({ ...BASE, tiers: [] }), "Sin niveles");
});

// ─── El formulario ───────────────────────────────────────────────────────────

function formulario(campos: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return parseCartValueForm(fd);
}

test("🔴 quitar todas las exclusiones se puede guardar", () => {
  // Va como JSON y no como checkboxes sueltos a propósito: con `getAll`, una
  // lista vacía y un campo ausente son indistinguibles, y "el merchant
  // desmarcó todo" tiene que poder guardarse.
  const f = formulario({
    name: "Ahorro",
    valueType: "AMOUNT",
    tiersJson: JSON.stringify([{ minSubtotal: 50, amount: 10 }]),
    excludedPacksJson: "[]",
  });
  assert.deepEqual(f.excludedPackCampaignIds, []);
  assert.deepEqual(buildCartValueConfig(f).excludedPackCampaignIds, []);
});

test("la lista de exclusiones se limpia de basura", () => {
  const f = formulario({
    name: "Ahorro",
    valueType: "AMOUNT",
    tiersJson: JSON.stringify([{ minSubtotal: 50, amount: 10 }]),
    excludedPacksJson: JSON.stringify(["camp_a", "", null, 7, "camp_b"]),
  });
  assert.deepEqual(f.excludedPackCampaignIds, ["camp_a", "camp_b"]);
});

test("un JSON roto no revienta el guardado", () => {
  const f = formulario({
    name: "Ahorro",
    valueType: "AMOUNT",
    tiersJson: "{{{roto",
    excludedPacksJson: "{{{roto",
  });
  assert.deepEqual(f.tiers, []);
  assert.deepEqual(f.excludedPackCampaignIds, []);
  // Y la validación lo cuenta como "sin niveles", que es lo que es.
  assert.ok(validateCartValueForm(f).tiers);
});

test("el formulario exige nombre y al menos un nivel", () => {
  const vacio = formulario({ valueType: "PERCENT", tiersJson: "[]" });
  const e = validateCartValueForm(vacio);
  assert.ok(e.name);
  assert.ok(e.tiers);

  const bueno = formulario({
    name: "Ahorro",
    valueType: "PERCENT",
    tiersJson: JSON.stringify([{ minSubtotal: 50, percent: 5 }]),
  });
  assert.deepEqual(validateCartValueForm(bueno), {});
});

test("la fecha de fin tiene que ser posterior a la de inicio", () => {
  const f = formulario({
    name: "Ahorro",
    valueType: "PERCENT",
    tiersJson: JSON.stringify([{ minSubtotal: 50, percent: 5 }]),
    startsAt: "2026-10-01T10:00",
    endsAt: "2026-09-01T10:00",
  });
  assert.ok(validateCartValueForm(f).dates);
});

// ─── Las reglas de combinación ───────────────────────────────────────────────

test("🔴 el pack acepta descuentos de ORDEN, y también al actualizar", () => {
  // El `orderDiscounts: false` del pack es lo que hacía desaparecer el
  // descuento por monto. Y el update tiene que reescribirlo: sin eso, un
  // descuento creado antes del arreglo se quedaría con la combinación vieja
  // para siempre y el fallo seguiría vivo en las campañas existentes.
  const pack = leer("app/lib/discounts/pack.ts");
  assert.match(pack, /const COMBINACION_DEL_PACK = \{\s*orderDiscounts: true/);
  const usos = pack.match(/combinesWith: COMBINACION_DEL_PACK/g) ?? [];
  assert.equal(usos.length, 2, "tiene que aplicarse al crear Y al actualizar");
});

test("🔴 el descuento por monto acepta descuentos de PRODUCTO", () => {
  const cv = leer("app/lib/discounts/cart-value.ts");
  assert.match(
    cv,
    /const COMBINACION_DEL_VALOR_DE_CARRITO = \{[^}]*productDiscounts: true/,
    "sin esto Shopify descarta el descuento antes de que la Function opine"
  );
  // Dos descuentos de orden a la vez sí serían descuento sobre descuento.
  assert.match(cv, /const COMBINACION_DEL_VALOR_DE_CARRITO = \{\s*orderDiscounts: false/);
  const usos = cv.match(/combinesWith: COMBINACION_DEL_VALOR_DE_CARRITO/g) ?? [];
  assert.equal(usos.length, 2, "al crear Y al actualizar");
});

test("🔴 la Function corta ANTES de calcular, y deja dicho por qué", () => {
  // La otra mitad del requisito: que nunca se pierda un descuento sin que nadie
  // se entere. Si la exclusión no dejara log, habríamos cambiado un fallo mudo
  // de Shopify por un fallo mudo nuestro.
  const fn = leer("extensions/order-discount/src/cart_lines_discounts_generate_run.ts");
  assert.match(fn, /motivo=excluido-por-campana/);

  const iExcl = fn.indexOf("excluidos.indexOf(packId)");
  const iCalc = fn.indexOf("computeCartValue(");
  assert.ok(iExcl > 0 && iCalc > 0);
  assert.ok(iExcl < iCalc, "la exclusión se evalúa antes de calcular nada");
});

test("🔴 la Function lee la marca de pack que escribe el widget", () => {
  // La cadena entera: el widget escribe `_df_pack` en la línea, `pack-discount`
  // la lee para saber qué líneas participan, y `order-discount` la lee para
  // saber si tiene que apartarse. Si alguien renombra la clave en un sitio y no
  // en los otros, la exclusión deja de funcionar en silencio.
  const query = leer(
    "extensions/order-discount/src/cart_lines_discounts_generate_run.graphql"
  );
  assert.match(query, /packId: attribute\(key: "_df_pack"\)/);

  const cliente = leer("app/lib/discounts/pack-client.ts");
  assert.ok(cliente.includes('PACK_LINE_ATTRIBUTE = "_df_pack"'));
});
