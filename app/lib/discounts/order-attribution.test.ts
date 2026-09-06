// Tests de la atribución de BXGY, CUPÓN SOBRE PRECIO ORIGINAL y MONTO DE COMPRA.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 ESTOS TESTS SON LA ÚNICA VERIFICACIÓN POSIBLE ANTES DE PRODUCCIÓN.
//
// El webhook `orders/create` está sin suscribir en la app Dev por falta de
// Protected Customer Data. En dev el pedido se completa, el descuento se aplica
// y el webhook **no llega nunca**. La primera vez que este código corre de
// verdad es en producción.
//
// Los payloads reproducen los dos pedidos que Jonas verificó el 2026-09-06 en
// su tienda de pruebas, que tiene instalada la app de PRODUCCIÓN:
//
//   #1013  cupón "PRODUCCION" −$26,00   → dashboard decía 0 pedidos
//   #1015  BXGY  "test xy"    −$48,00   → dashboard decía 0 pedidos
//
// Lo que estos tests NO pueden cubrir, y hay que decirlo: que Shopify entregue
// el webhook, y que los campos del payload sean los que suponemos —el `title`
// de una Function y el `code` de un cupón—. Eso solo lo confirma un pedido
// real. Para que ese día sea diagnosticable en un minuto, el resultado trae
// `ambiguas` y `sinReconocer`, y la ruta los registra en `[attribution-miss]`.
// ═══════════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  atribuirPorSenal,
  senalPorTituloAutomatico,
  senalPorCodigo,
  senalesReclamadasMasDeUnaVez,
  type AplicacionDeDescuento,
  type LineaDePedido,
} from "./order-attribution.ts";
import { bxgyDiscountTitle } from "./bxgy-client.ts";

const RAIZ = path.resolve(import.meta.dirname, "../../..");
const leer = (p: string) => fs.readFileSync(path.join(RAIZ, p), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// El pedido #1015: BXGY "test xy" junto a OTRO descuento del merchant.
//
// Es el pedido con el que se comprueba la condición que puso Jonas: que un
// pedido con varios descuentos no le atribuya de más a ninguna campaña.
// ─────────────────────────────────────────────────────────────────────────────

const APPS_1015: AplicacionDeDescuento[] = [
  // 0 — el nuestro
  { type: "automatic", title: "[DiscountFlow] test xy" },
  // 1 — uno del merchant, hecho a mano en el panel nativo
  { type: "automatic", title: "Envío gratis primavera" },
];

const LINEAS_1015: LineaDePedido[] = [
  // La gorra regalada: recibe NUESTRA asignación (índice 0).
  {
    product_id: 111,
    quantity: 5,
    price: "9.60",
    discount_allocations: [{ amount: "48.00", discount_application_index: 0 }],
  },
  // Un producto que descontó el merchant, no nosotros (índice 1).
  {
    product_id: 222,
    quantity: 1,
    price: "80.00",
    discount_allocations: [{ amount: "20.00", discount_application_index: 1 }],
  },
  // Un producto sin descuento ninguno.
  {
    product_id: 333,
    quantity: 2,
    price: "15.00",
    discount_allocations: [],
  },
];

const CAMPANA_1015 = [{ id: "camp-bxgy", senal: bxgyDiscountTitle("test xy") }];

test("BXGY: el título lleva el prefijo, y con él SÍ cruza", () => {
  const r = atribuirPorSenal(
    LINEAS_1015,
    APPS_1015,
    CAMPANA_1015,
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones.length, 1);
  assert.equal(r.atribuciones[0].campaignId, "camp-bxgy");
});

test("BXGY: el bug histórico — comparar contra el nombre pelado NO cruza", () => {
  // Esto es exactamente lo que hacía el webhook desde el commit 9ad7798:
  // `name: { in: automaticTitles }`, con `campaign.name` sin prefijo.
  const r = atribuirPorSenal(
    LINEAS_1015,
    APPS_1015,
    [{ id: "camp-bxgy", senal: "test xy" }],
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones.length, 0, "sin prefijo no puede cruzar");
  assert.ok(
    r.sinReconocer.includes("[DiscountFlow] test xy"),
    "y el título real queda registrado para poder diagnosticarlo"
  );
});

test("BXGY: 🔴 el importe sale de las asignaciones, NO del pedido entero", () => {
  const r = atribuirPorSenal(
    LINEAS_1015,
    APPS_1015,
    CAMPANA_1015,
    senalPorTituloAutomatico
  );
  const a = r.atribuciones[0];

  // Solo la línea que recibió NUESTRA asignación: 9.60 × 5.
  assert.equal(a.orderAmount, 48);
  assert.equal(a.lineas, 1);

  // Solo NUESTRO ahorro. El bloque viejo habría cobrado 48 + 20 = 68, que es
  // `total_discounts`, y habría contado como recaudación el pedido completo.
  assert.equal(a.discountAmount, 48);
});

test("un pedido con varios descuentos: cada campaña reclama solo lo suyo", () => {
  // El descuento del merchant no pertenece a ninguna campaña nuestra, así que
  // no hay forma de que su importe entre en ninguna atribución.
  const r = atribuirPorSenal(
    LINEAS_1015,
    APPS_1015,
    CAMPANA_1015,
    senalPorTituloAutomatico
  );

  const totalAtribuido = r.atribuciones.reduce(
    (s, a) => s + a.discountAmount,
    0
  );
  assert.equal(totalAtribuido, 48);
  assert.ok(totalAtribuido < 68, "68 sería el total del pedido");
});

test("BXGY: dos campañas con el MISMO nombre no se atribuyen a ninguna", () => {
  const r = atribuirPorSenal(
    LINEAS_1015,
    APPS_1015,
    [
      { id: "camp-a", senal: bxgyDiscountTitle("test xy") },
      { id: "camp-b", senal: bxgyDiscountTitle("test xy") },
    ],
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones.length, 0, "mejor un cero honesto");
  assert.deepEqual(r.ambiguas, ["[DiscountFlow] test xy"]);
});

test("una línea con dos asignaciones del mismo descuento cuenta su precio UNA vez", () => {
  const lineas: LineaDePedido[] = [
    {
      product_id: 1,
      quantity: 2,
      price: "50.00",
      discount_allocations: [
        { amount: "5.00", discount_application_index: 0 },
        { amount: "3.00", discount_application_index: 0 },
      ],
    },
  ];
  const r = atribuirPorSenal(
    lineas,
    [{ type: "automatic", title: "[DiscountFlow] x" }],
    [{ id: "c", senal: bxgyDiscountTitle("x") }],
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones[0].orderAmount, 100, "50 × 2, no el doble");
  assert.equal(r.atribuciones[0].discountAmount, 8, "los dos importes sí suman");
  assert.equal(r.atribuciones[0].lineas, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// El pedido #1013: cupón con CÓDIGO.
// ─────────────────────────────────────────────────────────────────────────────

const LINEAS_1013: LineaDePedido[] = [
  {
    product_id: 900,
    quantity: 1,
    price: "80.00",
    discount_allocations: [{ amount: "26.00", discount_application_index: 0 }],
  },
];

test("CUPÓN código: cruza por el campo `code`", () => {
  const r = atribuirPorSenal(
    LINEAS_1013,
    [{ type: "discount_code", code: "PRODUCCION" }],
    [{ id: "camp-cupon", senal: "PRODUCCION" }],
    senalPorCodigo
  );

  assert.equal(r.atribuciones.length, 1);
  assert.equal(r.atribuciones[0].orderAmount, 80);
  assert.equal(r.atribuciones[0].discountAmount, 26);
});

test("CUPÓN código: cruza también si el código llega en `title`", () => {
  // No está confirmado con un payload real en qué campo lo manda Shopify para
  // un descuento de APP con código. Aceptar los dos no puede dar un falso
  // positivo: el código es único en la tienda por obligación de Shopify.
  const r = atribuirPorSenal(
    LINEAS_1013,
    [{ type: "discount_code", title: "PRODUCCION" }],
    [{ id: "camp-cupon", senal: "PRODUCCION" }],
    senalPorCodigo
  );

  assert.equal(r.atribuciones.length, 1);
});

test("CUPÓN código: la normalización es la misma que al guardar", () => {
  // `normalizeDiscountCode` existe desde el 2026-09-05 con este comentario:
  // «si guardáramos "influ 10" y Shopify "INFLU10", la atribución no cruzaría».
  // Ahora hay alguien que lo comprueba.
  const r = atribuirPorSenal(
    LINEAS_1013,
    [{ type: "discount_code", code: "influ 10" }],
    [{ id: "camp-cupon", senal: "INFLU10" }],
    senalPorCodigo
  );

  assert.equal(r.atribuciones.length, 1);
});

test("CUPÓN código: otro código no se atribuye", () => {
  const r = atribuirPorSenal(
    LINEAS_1013,
    [{ type: "discount_code", code: "OTRACOSA" }],
    [{ id: "camp-cupon", senal: "PRODUCCION" }],
    senalPorCodigo
  );

  assert.equal(r.atribuciones.length, 0);
  assert.deepEqual(r.sinReconocer, ["OTRACOSA"]);
});

test("CUPÓN automático: cruza por el mensaje de la Function", () => {
  const r = atribuirPorSenal(
    LINEAS_1013,
    [{ type: "automatic", title: "Descuento sobre el precio original" }],
    [{ id: "camp-cupon", senal: "Descuento sobre el precio original" }],
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones.length, 1);
  assert.equal(r.atribuciones[0].discountAmount, 26);
});

// ─────────────────────────────────────────────────────────────────────────────
// MONTO DE COMPRA, y la salvaguarda de los mensajes compartidos.
// ─────────────────────────────────────────────────────────────────────────────

const LINEAS_MONTO: LineaDePedido[] = [
  {
    product_id: 1,
    quantity: 1,
    price: "100.00",
    discount_allocations: [{ amount: "6.00", discount_application_index: 0 }],
  },
  {
    product_id: 2,
    quantity: 1,
    price: "50.00",
    discount_allocations: [{ amount: "3.00", discount_application_index: 0 }],
  },
];

test("MONTO: descuento de orden — suma todas las líneas que tocó", () => {
  const r = atribuirPorSenal(
    LINEAS_MONTO,
    [{ type: "automatic", title: "Descuento por monto de compra" }],
    [{ id: "camp-monto", senal: "Descuento por monto de compra" }],
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones[0].orderAmount, 150);
  assert.equal(r.atribuciones[0].discountAmount, 9);
  assert.equal(r.atribuciones[0].lineas, 2);
});

test("MONTO: 🔴 dos campañas con el mensaje por defecto → NINGUNA atribuye", () => {
  // Decisión explícita de Jonas: «mejor un cero honesto que un número
  // inventado». Es la misma regla que ya aplicaba escalonados.
  const r = atribuirPorSenal(
    LINEAS_MONTO,
    [{ type: "automatic", title: "Descuento por monto de compra" }],
    [
      { id: "camp-a", senal: "Descuento por monto de compra" },
      { id: "camp-b", senal: "Descuento por monto de compra" },
    ],
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones.length, 0);
  assert.deepEqual(r.ambiguas, ["Descuento por monto de compra"]);
});

test("un mensaje compartido entre DOS TIPOS no se atribuye a ninguno", () => {
  // El merchant escribe el `message`. Si pone el mismo en una campaña de monto
  // y en un cupón automático, una sola aplicación encajaría en los dos bloques
  // y el ahorro se contaría dos veces.
  const compartido = "Promo de septiembre";
  const ajenas = senalesReclamadasMasDeUnaVez([[compartido], [compartido]]);

  const r = atribuirPorSenal(
    LINEAS_MONTO,
    [{ type: "automatic", title: compartido }],
    [{ id: "camp-monto", senal: compartido }],
    senalPorTituloAutomatico,
    ajenas
  );

  assert.equal(r.atribuciones.length, 0);
  assert.deepEqual(r.ambiguas, [compartido]);
});

test("senalesReclamadasMasDeUnaVez: solo marca las repetidas", () => {
  const s = senalesReclamadasMasDeUnaVez([
    ["Descuento por cantidad", "Descuento por cantidad"],
    ["Descuento por pack"],
    ["Descuento por monto de compra"],
  ]);

  assert.ok(s.has("Descuento por cantidad"));
  assert.ok(!s.has("Descuento por pack"));
  assert.ok(!s.has("Descuento por monto de compra"));
});

test("senalesReclamadasMasDeUnaVez: ignora vacíos y espacios", () => {
  const s = senalesReclamadasMasDeUnaVez([["", "  "], ["", "  "]]);
  assert.equal(s.size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Casos hostiles: lo que llega cuando el payload no es el del folleto.
// ─────────────────────────────────────────────────────────────────────────────

test("no atribuye cuando no hay descuentos, líneas ni campañas", () => {
  assert.equal(
    atribuirPorSenal([], [], [], senalPorTituloAutomatico).atribuciones.length,
    0
  );
  assert.equal(
    atribuirPorSenal(LINEAS_1015, [], CAMPANA_1015, senalPorTituloAutomatico)
      .atribuciones.length,
    0
  );
  assert.equal(
    atribuirPorSenal(LINEAS_1015, APPS_1015, [], senalPorTituloAutomatico)
      .atribuciones.length,
    0
  );
});

test("una aplicación que NO es automática no cuenta como título", () => {
  assert.equal(senalPorTituloAutomatico({ type: "manual", title: "x" }), null);
  assert.equal(senalPorTituloAutomatico({ type: "automatic" }), null);
  assert.equal(senalPorTituloAutomatico({ type: "automatic", title: "  " }), null);
});

test("importes y cantidades basura no producen NaN", () => {
  const lineas: LineaDePedido[] = [
    {
      product_id: 1,
      quantity: 1,
      price: "no-es-un-numero",
      discount_allocations: [{ amount: "5.00", discount_application_index: 0 }],
    },
    {
      product_id: 2,
      quantity: 1,
      price: "40.00",
      discount_allocations: [{ amount: "tampoco", discount_application_index: 0 }],
    },
  ];
  const r = atribuirPorSenal(
    lineas,
    [{ type: "automatic", title: "[DiscountFlow] x" }],
    [{ id: "c", senal: bxgyDiscountTitle("x") }],
    senalPorTituloAutomatico
  );

  assert.equal(r.atribuciones.length, 1);
  assert.equal(r.atribuciones[0].orderAmount, 40);
  assert.equal(r.atribuciones[0].discountAmount, 0);
  assert.ok(Number.isFinite(r.atribuciones[0].orderAmount));
});

test("un índice de aplicación que no existe se ignora", () => {
  const lineas: LineaDePedido[] = [
    {
      product_id: 1,
      quantity: 1,
      price: "10.00",
      discount_allocations: [{ amount: "1.00", discount_application_index: 99 }],
    },
  ];
  const r = atribuirPorSenal(
    lineas,
    [{ type: "automatic", title: "[DiscountFlow] x" }],
    [{ id: "c", senal: bxgyDiscountTitle("x") }],
    senalPorTituloAutomatico
  );
  assert.equal(r.atribuciones.length, 0);
});

test("una línea sin `discount_allocations` no rompe ni suma", () => {
  const lineas = [{ product_id: 1, quantity: 1, price: "10.00" }] as LineaDePedido[];
  const r = atribuirPorSenal(
    lineas,
    [{ type: "automatic", title: "[DiscountFlow] x" }],
    [{ id: "c", senal: bxgyDiscountTitle("x") }],
    senalPorTituloAutomatico
  );
  assert.equal(r.atribuciones.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Las dos puntas del prefijo de BXGY, que es lo que estuvo roto todo este
// tiempo. Si alguien vuelve a escribir el literal en un solo lado, esto se cae.
// ─────────────────────────────────────────────────────────────────────────────

test("bxgyDiscountTitle produce el título EXACTO que se ve en el pedido", () => {
  assert.equal(bxgyDiscountTitle("test xy"), "[DiscountFlow] test xy");
});

test("quien crea el descuento BXGY usa el helper, no el literal", () => {
  const fuente = leer("app/lib/discounts/bxgy.ts");

  assert.ok(
    !fuente.includes("`[DiscountFlow] ${campaignName}`"),
    "el prefijo escrito a mano es lo que causó el bug: tiene que salir del helper"
  );
  assert.equal(
    fuente.split("bxgyDiscountTitle(campaignName)").length - 1,
    2,
    "las dos mutaciones —crear y actualizar— tienen que usarlo"
  );
});

test("el webhook reconoce BXGY por el título, y ya no por el nombre pelado", () => {
  const fuente = leer("app/routes/webhooks.orders.create.tsx");

  assert.ok(
    !fuente.includes("name: { in: automaticTitles }"),
    "el cruce roto no puede volver"
  );
  assert.ok(fuente.includes("bxgyDiscountTitle(c.name)"));
});

test("el webhook ya no atribuye BXGY con los totales del pedido", () => {
  const fuente = leer("app/routes/webhooks.orders.create.tsx");

  assert.ok(
    !fuente.includes("orderAmount: Number(order.total_price)"),
    "atribuir el pedido entero es el segundo bug de BXGY"
  );
  assert.ok(!fuente.includes("discountAmount: Number(order.total_discounts)"));
});

test("el log temporal de escalonados ya no corre en producción", () => {
  const fuente = leer("app/routes/webhooks.orders.create.tsx");
  assert.ok(!fuente.includes('console.log(\n        "[tiered-attribution]"'));
  assert.ok(!fuente.includes('"[tiered-attribution]"'));
});

test("los bloques que YA atribuyen quedan intactos", () => {
  // No es un test de estilo: Greta tiene 902 pedidos atribuidos por el bloque
  // de precio y SkinUp 10 por el de escalonados. Estas cuatro señas son las que
  // hacen que esos números existan.
  const fuente = leer("app/routes/webhooks.orders.create.tsx");

  assert.ok(
    fuente.includes('type: { in: ["PERCENTAGE", "RANGE"] }'),
    "Porcentaje y Rango cruzan por variante"
  );
  assert.ok(
    fuente.includes("tieredAppliesToProduct(configOf(c), productGid)"),
    "escalonados eligen campaña por productos"
  );
  assert.ok(
    fuente.includes("app.title === tieredDiscountMessage(configOf(c))"),
    "y descartan por el mensaje de la Function"
  );
  assert.ok(
    fuente.includes("atribuirPacks("),
    "packs siguen en su módulo puro"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// RANGO DE PRECIO: no había que construir nada, había que VERIFICAR.
//
// Rango comparte el bloque de atribución con Porcentaje, que sí funciona —902
// pedidos en Greta—. El bloque cruza `variant_id` del pedido contra
// `CampaignProduct.shopifyVariantId` y calcula el ahorro con `originalPrice`.
// Así que Rango atribuye si, y solo si, escribe esas dos columnas igual que
// Porcentaje. Eso es lo que comprueban estos tests: la premisa del cruce, en
// los dos caminos que crean filas (el síncrono y el motor de jobs).
// ─────────────────────────────────────────────────────────────────────────────

test("RANGO escribe las mismas dos columnas que PORCENTAJE", () => {
  for (const archivo of [
    "app/lib/discounts/percentage.ts",
    "app/lib/discounts/range.ts",
  ]) {
    const fuente = leer(archivo);
    assert.ok(
      fuente.includes("shopifyVariantId: variant.id"),
      `${archivo}: sin variante no hay cruce posible`
    );
    assert.ok(
      fuente.includes("originalPrice: new Prisma.Decimal(originalPrice)"),
      `${archivo}: sin precio original el ahorro sale 0`
    );
  }
});

test("el motor de jobs escribe lo mismo para los dos tipos de precio", () => {
  // Las campañas grandes no pasan por `percentage.ts` / `range.ts`: las crea
  // `campaign-ops.ts` por lotes. Si ese camino olvidara una columna, Greta
  // dejaría de atribuir sin que nada fallara.
  const fuente = leer("app/lib/jobs/operations/campaign-ops.ts");
  assert.ok(fuente.includes("shopifyVariantId: v.id"));
  assert.ok(fuente.includes("originalPrice: new Prisma.Decimal(orig)"));
});

test("el bloque de precio sigue cubriendo PORCENTAJE y RANGO", () => {
  const fuente = leer("app/routes/webhooks.orders.create.tsx");
  assert.ok(fuente.includes('type: { in: ["PERCENTAGE", "RANGE"] }'));
  assert.ok(fuente.includes("originalPrice: true"));
});

// ─────────────────────────────────────────────────────────────────────────────
// PACK: la verificación posible sin un pedido real.
//
// Packs identifica la CAMPAÑA por la marca de la línea (`_df_pack`), que es
// exacta. Del título solo depende el IMPORTE: si el `title` no fuera el
// `message` de la Function, el pedido se atribuiría con ahorro 0 — visible como
// "pedidos sí, ROI N/A", no como un cero total.
//
// Y esa suposición no es una corazonada: es el mismo mecanismo de escalonados,
// que está CONFIRMADO en producción con un pedido real desde el 2026-07-25.
// Lo que se comprueba acá es que las dos Functions emiten el campo igual, que
// es lo que hace válida la extrapolación.
// ─────────────────────────────────────────────────────────────────────────────

test("pack y escalonado emiten el `message` con el mismo mecanismo", () => {
  for (const ext of [
    "tiered-discount",
    "pack-discount",
    "order-discount",
    "code-original-price",
  ]) {
    const fuente = leer(
      `extensions/${ext}/src/cart_lines_discounts_generate_run.ts`
    );
    assert.ok(
      fuente.includes("const message = config.message ||"),
      `${ext}: el mensaje sale de la config con un default`
    );
    assert.ok(
      fuente.includes("    message,"),
      `${ext}: y viaja en el candidato, que es lo que Shopify publica como title`
    );
  }
});

test("el lector del título de packs sigue comparando contra el message", () => {
  const fuente = leer("app/lib/discounts/pack-attribution.ts");
  assert.ok(fuente.includes("app.title !== campana.message"));
  assert.ok(
    fuente.includes("titulosNoReconocidos"),
    "y si la suposición fuera falsa, el valor real queda registrado"
  );
});
