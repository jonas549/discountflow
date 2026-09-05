// Tests de la atribución de pedidos a campañas PACK.
//
// 🔴 ESTOS TESTS SON LA ÚNICA VERIFICACIÓN POSIBLE ANTES DE PRODUCCIÓN.
//
// El webhook `orders/create` está deliberadamente sin suscribir en la app Dev
// por falta de aprobación de Protected Customer Data (comentado en
// `shopify.app.dev.toml` desde el 2026-07-24). En dev el pedido se completa, el
// descuento se aplica y el webhook **no llega nunca**. Así que la primera vez
// que este código corre de verdad es en producción, sobre el pedido de un
// cliente real.
//
// El payload de referencia reproduce el pedido real que hizo Jonas en la tienda
// de dev el 2026-09-05: 5 productos, 30% aplicado, $278 → $194,60.
//
// Lo que estos tests NO pueden cubrir, y hay que decirlo: que Shopify entregue
// el webhook, y que el `title` de la aplicación de descuento sea el `message` de
// la Function. Eso solo lo confirma un pedido real. Para que ese día sea
// diagnosticable, el resultado incluye `titulosNoReconocidos`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  atribuirPacks,
  leerPropiedadDeLinea,
  type LineaDePedido,
  type AplicacionDeDescuento,
} from "./pack-attribution.ts";

const CLAVE = "_df_pack";
const CAMPANA = "cmtogmcem0007ujjwwzlci3rb";
const MENSAJE = "Descuento por pack";

const CAMPANAS = [{ id: CAMPANA, name: "Pack prueba", message: MENSAJE }];

/** El descuento automático de nuestro pack, como llega en el payload. */
const APPS: AplicacionDeDescuento[] = [{ type: "automatic", title: MENSAJE }];

/**
 * Una línea con la propiedad en la forma REAL del payload REST: un ARRAY de
 * `{name, value}`. NO el objeto de la Ajax Cart API.
 */
function linea(
  productId: number,
  precio: number,
  descuento: number,
  opciones: { campana?: string | null; indice?: number } = {}
): LineaDePedido {
  const campana = opciones.campana === undefined ? CAMPANA : opciones.campana;
  return {
    product_id: productId,
    quantity: 1,
    price: precio.toFixed(2),
    properties: campana ? [{ name: CLAVE, value: campana }] : [],
    discount_allocations: descuento
      ? [
          {
            amount: descuento.toFixed(2),
            discount_application_index: opciones.indice ?? 0,
          },
        ]
      : [],
  };
}

/** El pedido real: 5 productos, 30%, $278 → ahorro $83,40 → total $194,60. */
const PEDIDO_REAL: LineaDePedido[] = [
  linea(8923218772104, 98, 29.4),
  linea(8923218903176, 70, 21),
  linea(8923218346120, 40, 12),
  linea(8923218411656, 30, 9),
  linea(8923218477192, 40, 12),
];

// ─── El caso que importa ─────────────────────────────────────────────────────

test("atribuye el pedido real de 5 productos al 30%", () => {
  const r = atribuirPacks(PEDIDO_REAL, APPS, CAMPANAS, CLAVE);

  assert.equal(r.lineasConMarca, 5);
  assert.equal(r.lineasHuerfanas, 0);
  assert.deepEqual(r.titulosNoReconocidos, []);
  assert.equal(r.atribuciones.length, 1);

  const a = r.atribuciones[0];
  assert.equal(a.campaignId, CAMPANA);
  assert.equal(a.lineas, 5);
  assert.equal(a.orderAmount, 278, "la suma de los precios de línea");
  assert.equal(a.discountAmount, 83.4, "la suma de las asignaciones");
  // 278 − 83,40 = 194,60, que es lo que pagó de verdad.
  assert.equal(Number((a.orderAmount - a.discountAmount).toFixed(2)), 194.6);
});

// ─── La forma del dato, que es donde estaba la trampa ────────────────────────

test("🔴 lee la propiedad en forma de ARRAY (payload REST del pedido)", () => {
  // Ésta es la forma REAL del webhook, y confundirla con la otra da cero
  // atribuciones sin ningún error.
  assert.equal(
    leerPropiedadDeLinea([{ name: CLAVE, value: CAMPANA }], CLAVE),
    CAMPANA
  );
});

test("lee la propiedad en forma de OBJETO (Ajax Cart API)", () => {
  // El webhook no la manda así, pero tolerarlo cuesta tres líneas y evita que un
  // cambio de forma vuelva a producir un cero silencioso.
  assert.equal(leerPropiedadDeLinea({ [CLAVE]: CAMPANA }, CLAVE), CAMPANA);
});

test("leerPropiedadDeLinea es defensiva", () => {
  assert.equal(leerPropiedadDeLinea(null, CLAVE), null);
  assert.equal(leerPropiedadDeLinea(undefined, CLAVE), null);
  assert.equal(leerPropiedadDeLinea([], CLAVE), null);
  assert.equal(leerPropiedadDeLinea({}, CLAVE), null);
  assert.equal(leerPropiedadDeLinea([{ name: "otra", value: "x" }], CLAVE), null);
  assert.equal(leerPropiedadDeLinea({ [CLAVE]: "" }, CLAVE), null);
});

// ─── Carrito mixto y casos hostiles ──────────────────────────────────────────

test("las líneas sin la marca del pack no participan", () => {
  const conCompraSuelta = [
    ...PEDIDO_REAL,
    linea(99999, 500, 0, { campana: null }),
  ];
  const r = atribuirPacks(conCompraSuelta, APPS, CAMPANAS, CLAVE);

  assert.equal(r.lineasConMarca, 5);
  assert.equal(r.atribuciones[0].orderAmount, 278, "los $500 sueltos NO entran");
});

test("una línea de un pack borrado se cuenta como huérfana, no revienta", () => {
  const r = atribuirPacks(
    [linea(1, 50, 15, { campana: "campana_borrada" })],
    APPS,
    CAMPANAS,
    CLAVE
  );
  assert.equal(r.lineasConMarca, 1);
  assert.equal(r.lineasHuerfanas, 1);
  assert.deepEqual(r.atribuciones, []);
});

test("🔴 el descuento de OTRA app no se suma, y su título queda registrado", () => {
  // Una línea puede llevar encima descuentos de otras apps o del merchant.
  // Sumarlos inflaría el ahorro atribuido a nuestra campaña.
  const apps: AplicacionDeDescuento[] = [
    { type: "automatic", title: MENSAJE },
    { type: "automatic", title: "Pack 2 Flo" }, // la otra app de SkinUp
  ];
  const lineas: LineaDePedido[] = [
    {
      product_id: 1,
      quantity: 1,
      price: "100.00",
      properties: [{ name: CLAVE, value: CAMPANA }],
      discount_allocations: [
        { amount: "30.00", discount_application_index: 0 },
        { amount: "10.00", discount_application_index: 1 },
      ],
    },
  ];

  const r = atribuirPacks(lineas, apps, CAMPANAS, CLAVE);
  assert.equal(r.atribuciones[0].discountAmount, 30, "solo los $30 nuestros");
  assert.deepEqual(r.titulosNoReconocidos, ["Pack 2 Flo"]);
});

test("🔴 si NINGÚN título casa, el importe es 0 y los títulos quedan a la vista", () => {
  // Éste es el escenario que solo un pedido real puede confirmar: que Shopify
  // publique el `message` de la Function como `title`. Si no lo hiciera, esto es
  // lo que pasaría — y `titulosNoReconocidos` convierte un cero mudo en un
  // arreglo de una línea.
  const apps: AplicacionDeDescuento[] = [
    { type: "automatic", title: "Otro texto inesperado" },
  ];
  const r = atribuirPacks(PEDIDO_REAL, apps, CAMPANAS, CLAVE);

  assert.equal(r.atribuciones.length, 1, "el PEDIDO sí se atribuye");
  assert.equal(r.atribuciones[0].orderAmount, 278);
  assert.equal(r.atribuciones[0].discountAmount, 0, "pero el ahorro sale 0");
  assert.deepEqual(r.titulosNoReconocidos, ["Otro texto inesperado"]);
});

test("los descuentos de CÓDIGO no se suman", () => {
  const apps: AplicacionDeDescuento[] = [{ type: "code", title: MENSAJE }];
  const r = atribuirPacks(PEDIDO_REAL, apps, CAMPANAS, CLAVE);
  assert.equal(r.atribuciones[0].discountAmount, 0);
});

test("el precio de línea entra UNA vez aunque haya varias asignaciones nuestras", () => {
  const lineas: LineaDePedido[] = [
    {
      product_id: 1,
      quantity: 1,
      price: "100.00",
      properties: [{ name: CLAVE, value: CAMPANA }],
      discount_allocations: [
        { amount: "20.00", discount_application_index: 0 },
        { amount: "10.00", discount_application_index: 0 },
      ],
    },
  ];
  const r = atribuirPacks(lineas, APPS, CAMPANAS, CLAVE);
  assert.equal(r.atribuciones[0].orderAmount, 100, "no 200");
  assert.equal(r.atribuciones[0].discountAmount, 30, "las dos se suman");
});

test("la cantidad multiplica el importe de la línea", () => {
  const lineas = [
    { ...linea(1, 50, 15), quantity: 3 },
  ];
  const r = atribuirPacks(lineas, APPS, CAMPANAS, CLAVE);
  assert.equal(r.atribuciones[0].orderAmount, 150);
});

test("dos packs distintos en el mismo pedido se atribuyen por separado", () => {
  // El widget lo impide (un pack por carrito), pero el webhook tiene que ser
  // robusto: la restricción vive en el navegador del comprador.
  const otra = "otra_campana";
  const campanas = [...CAMPANAS, { id: otra, name: "Pack 2", message: MENSAJE }];
  const lineas = [
    linea(1, 100, 30),
    linea(2, 200, 60, { campana: otra }),
  ];
  const r = atribuirPacks(lineas, APPS, campanas, CLAVE);

  assert.equal(r.atribuciones.length, 2);
  const porId = new Map(r.atribuciones.map((a) => [a.campaignId, a]));
  assert.equal(porId.get(CAMPANA)!.orderAmount, 100);
  assert.equal(porId.get(otra)!.orderAmount, 200);
});

// ─── Que no reviente ─────────────────────────────────────────────────────────

test("un índice de aplicación fuera de rango no revienta", () => {
  const lineas = [linea(1, 100, 30, { indice: 99 })];
  const r = atribuirPacks(lineas, APPS, CAMPANAS, CLAVE);
  assert.equal(r.atribuciones[0].discountAmount, 0);
});

test("entradas vacías o basura devuelven un resultado vacío", () => {
  assert.deepEqual(atribuirPacks([], [], [], CLAVE).atribuciones, []);
  assert.deepEqual(atribuirPacks(PEDIDO_REAL, [], [], CLAVE).atribuciones, []);

  const basura: LineaDePedido[] = [
    {
      product_id: null,
      quantity: 0,
      price: "no-es-un-numero",
      properties: [{ name: CLAVE, value: CAMPANA }],
    },
  ];
  const r = atribuirPacks(basura, APPS, CAMPANAS, CLAVE);
  assert.equal(r.lineasConMarca, 1);
  assert.deepEqual(r.atribuciones, [], "sin importe no se atribuye");
});

test("una línea sin discount_allocations no revienta", () => {
  const lineas: LineaDePedido[] = [
    {
      product_id: 1,
      quantity: 1,
      price: "100.00",
      properties: [{ name: CLAVE, value: CAMPANA }],
    },
  ];
  const r = atribuirPacks(lineas, APPS, CAMPANAS, CLAVE);
  assert.equal(r.atribuciones[0].orderAmount, 100);
  assert.equal(r.atribuciones[0].discountAmount, 0);
});
