// Las reglas de los cupones de viaje. Módulo puro: corre sin base ni Shopify.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATRIBUTO_CODIGO,
  ATRIBUTO_CUPON,
  clasificarVariantes,
  cuponesAMostrar,
  cuponesPublicados,
  decidirConsumos,
  generarCodigo,
  leerDatosDelFormulario,
  limiteDeUsoEnShopify,
  repartirPasajeros,
  precioPagoTotalMasBarato,
  cuponesQueSuperanElPrecio,
  parseMontoEntero,
  rellenarMensaje,
  sugerirModalidades,
  validarFormulario,
  type CampanaParaPedido,
  type PedidoParaCupones,
} from "./cupones-viaje.ts";

const cupon = (position: number, stock: number, used: number) => ({
  id: `c${position}`,
  position,
  label: `Cupón ${position}`,
  amount: 100_000,
  stock,
  used,
  code: `DFVCODE${position}`,
});

// ─── Liberación en orden ─────────────────────────────────────────────────────

test("se publica el primero no agotado, y al agotarse aparece el siguiente solo", () => {
  const antes = [cupon(1, 5, 4), cupon(2, 5, 0), cupon(3, 5, 0)];
  assert.deepEqual(cuponesPublicados(antes, 1).map((c) => c.id), ["c1"]);

  const despues = [cupon(1, 5, 5), cupon(2, 5, 0), cupon(3, 5, 0)];
  assert.deepEqual(cuponesPublicados(despues, 1).map((c) => c.id), ["c2"]);
});

test("con 2 a la vez se publican los dos primeros disponibles", () => {
  const cs = [cupon(1, 5, 5), cupon(2, 5, 1), cupon(3, 5, 0), cupon(4, 5, 0)];
  assert.deepEqual(cuponesPublicados(cs, 2).map((c) => c.id), ["c2", "c3"]);
});

test("el orden manda la POSICIÓN, no el orden en que vienen", () => {
  const cs = [cupon(3, 5, 0), cupon(1, 5, 0), cupon(2, 5, 0)];
  assert.deepEqual(cuponesPublicados(cs, 1).map((c) => c.id), ["c1"]);
});

test("en la tienda se ven los agotados (apagados) y los publicados, NO los que esperan turno", () => {
  const cs = [cupon(1, 5, 5), cupon(2, 5, 5), cupon(3, 5, 1), cupon(4, 5, 0)];
  const vistos = cuponesAMostrar(cs, 1);
  assert.deepEqual(
    vistos.map((c) => [c.id, c.agotado]),
    [
      ["c1", true],
      ["c2", true],
      ["c3", false],
    ]
  );
});

test("todos agotados: no hay nada publicado, pero se siguen viendo", () => {
  const cs = [cupon(1, 2, 2), cupon(2, 2, 2)];
  assert.equal(cuponesPublicados(cs, 1).length, 0);
  assert.equal(cuponesAMostrar(cs, 1).length, 2);
});

test("🔴 el límite de Shopify cuenta PEDIDOS: los de Pago total ya hechos + los cupos que quedan", () => {
  // Stock 5 pasajeros, sin usos: caben hasta 5 pedidos más.
  assert.equal(limiteDeUsoEnShopify(5, 0, 0), 5);
  // Un Pago total de 2 pasajeros (1 pedido para Shopify, 2 cupos): quedan 3
  // cupos → hasta 3 pedidos más, sobre el 1 que Shopify ya contó.
  assert.equal(limiteDeUsoEnShopify(5, 2, 1), 4);
  // Una Reserva de 3 pasajeros no pasa por el código: 0 pedidos de Shopify y
  // 2 cupos → 2.
  assert.equal(limiteDeUsoEnShopify(5, 3, 0), 2);
  // Nunca 0: Shopify no acepta un límite 0, y un cupón sin cupos ya no está
  // publicado (su código se desactiva).
  assert.equal(limiteDeUsoEnShopify(5, 5, 0), 1);
});

test("🔴 los pasajeros que no entran en el stock quedan como excedentes", () => {
  assert.deepEqual(repartirPasajeros(5, 3), { cubiertos: 3, excedentes: 0 });
  assert.deepEqual(repartirPasajeros(2, 3), { cubiertos: 2, excedentes: 1 });
  assert.deepEqual(repartirPasajeros(0, 2), { cubiertos: 0, excedentes: 2 });
});

test("el aviso de precio compara contra el Pago total más barato, no contra la Reserva", () => {
  const variantes = [
    { id: "t1", price: "4550.00", selectedOptions: [] },
    { id: "t2", price: "3990.00", selectedOptions: [] },
    { id: "r1", price: "500.00", selectedOptions: [] },
  ];
  const minimo = precioPagoTotalMasBarato(variantes, ["t1", "t2"]);
  assert.equal(minimo, 3990);
  const cupones = [
    { label: "Chico", amount: 1_000 },
    { label: "Justo", amount: 3_990 },
    { label: "Grande", amount: 500_000 },
  ];
  // Un cupón de $1.000 NO se avisa aunque supere la Reserva de $500: en Reserva
  // se descuenta del saldo, no del carrito.
  assert.deepEqual(
    cuponesQueSuperanElPrecio(cupones, minimo).map((c) => c.label),
    ["Justo", "Grande"]
  );
  assert.deepEqual(cuponesQueSuperanElPrecio(cupones, null), []);
  assert.equal(precioPagoTotalMasBarato(variantes, []), null);
});

// ─── Montos en CLP ───────────────────────────────────────────────────────────

test("🔴 «100.000» son cien mil pesos, no cien", () => {
  assert.equal(parseMontoEntero("100.000"), 100_000);
  assert.equal(parseMontoEntero("$ 125.000"), 125_000);
  assert.equal(parseMontoEntero("4.550.000"), 4_550_000);
  assert.equal(parseMontoEntero("100000"), 100_000);
  assert.equal(parseMontoEntero(" 5 "), 5);
});

test("la coma se rechaza en vez de adivinarse", () => {
  assert.equal(parseMontoEntero("100,5"), null);
  assert.equal(parseMontoEntero(""), null);
  assert.equal(parseMontoEntero("abc"), null);
  assert.equal(parseMontoEntero("-5"), null);
});

test("el mensaje rellena {monto} y {cupon}, y deja intacto lo desconocido", () => {
  assert.equal(
    rellenarMensaje("Se descuentan {monto} ({cupon}) {otra}", { monto: "$100.000", cupon: "Cupón 1" }),
    "Se descuentan $100.000 (Cupón 1) {otra}"
  );
});

// ─── Variantes ───────────────────────────────────────────────────────────────

const variantes = [
  { id: "v1", selectedOptions: [{ name: "Tipo de Reserva", value: "Pago Total" }, { name: "Fecha", value: "24 Nov" }] },
  { id: "v2", selectedOptions: [{ name: "Tipo de Reserva", value: "Reserva" }, { name: "Fecha", value: "24 Nov" }] },
  { id: "v3", selectedOptions: [{ name: "Tipo de Reserva", value: "Pago Total" }, { name: "Fecha", value: "09 Mar" }] },
  { id: "v4", selectedOptions: [{ name: "Tipo de Reserva", value: "Reserva" }, { name: "Fecha", value: "09 Mar" }] },
  { id: "v5", selectedOptions: [{ name: "Tipo de Reserva", value: "Otra cosa" }, { name: "Fecha", value: "09 Mar" }] },
];

test("sugiere la opción de modalidad como está armada la tienda de GeoTerra", () => {
  assert.deepEqual(
    sugerirModalidades([
      { name: "Tipo de Reserva", values: ["Pago Total", "Reserva"] },
      { name: "Selecciona tu fecha de viaje", values: ["24 Nov", "09 Mar"] },
    ]),
    { optionName: "Tipo de Reserva", fullPaymentValue: "Pago Total", reservationValue: "Reserva" }
  );
  assert.equal(sugerirModalidades([{ name: "Talla", values: ["S", "M"] }]), null);
});

test("🔴 separa Pago total de Reserva; lo que no encaja queda FUERA del descuento", () => {
  const r = clasificarVariantes(variantes, "Tipo de Reserva", "Pago Total", "Reserva");
  assert.deepEqual(r.fullPayment, ["v1", "v3"]);
  assert.deepEqual(r.reservation, ["v2", "v4"]);
  assert.deepEqual(r.sinClasificar, ["v5"]);
});

test("la clasificación no distingue mayúsculas ni espacios de más", () => {
  const r = clasificarVariantes(variantes, " tipo de reserva ", "PAGO TOTAL", "reserva");
  assert.deepEqual(r.fullPayment, ["v1", "v3"]);
});

// ─── El formulario ───────────────────────────────────────────────────────────

const formularioValido = {
  name: "Kenia",
  productId: "gid://shopify/Product/1",
  productTitle: "Kenia",
  optionName: "Tipo de Reserva",
  fullPaymentValue: "Pago Total",
  reservationValue: "Reserva",
  visibleCount: 1,
  heading: "Cupones",
  messageFullPayment: "a",
  messageReservation: "b",
  coupons: [
    { label: "Cupón 1", amount: "100.000", stock: "5" },
    { label: "Cupón 2", amount: "125.000", stock: "5" },
  ],
};

test("un formulario válido devuelve los cupones ya leídos a números", () => {
  const { errores, cupones } = validarFormulario(leerDatosDelFormulario(formularioValido));
  assert.deepEqual(errores, {});
  assert.deepEqual(
    cupones.map((c) => [c.label, c.amount, c.stock]),
    [
      ["Cupón 1", 100_000, 5],
      ["Cupón 2", 125_000, 5],
    ]
  );
});

test("el stock no puede bajar por debajo de lo ya usado", () => {
  const d = leerDatosDelFormulario({
    ...formularioValido,
    coupons: [{ id: "c1", label: "Cupón 1", amount: "100.000", stock: "2" }],
  });
  const { errores } = validarFormulario(d, { c1: 3 });
  assert.match(errores.coupons ?? "", /ya se usó 3 veces/);
});

test("Pago total y Reserva no pueden ser el mismo valor", () => {
  const d = leerDatosDelFormulario({ ...formularioValido, reservationValue: "pago total" });
  assert.ok(validarFormulario(d).errores.modalidades);
});

test("un JSON roto no inventa valores: se rechaza con errores", () => {
  const { errores } = validarFormulario(leerDatosDelFormulario("no soy un objeto"));
  assert.ok(errores.name && errores.product && errores.coupons && errores.messages);
});

test("los códigos son aleatorios y empiezan con el prefijo que reconoce el widget", () => {
  const a = generarCodigo();
  const b = generarCodigo();
  assert.match(a, /^DFV[A-Z2-9]{10}$/);
  assert.notEqual(a, b);
  // Sin letras ni números que se confunden al leerlos.
  assert.doesNotMatch(a.slice(3), /[01IOL]/);
});

// ─── Qué consume un pedido ───────────────────────────────────────────────────

const campana: CampanaParaPedido = {
  id: "camp",
  fullPaymentVariantIds: ["gid://shopify/ProductVariant/11"],
  reservationVariantIds: ["gid://shopify/ProductVariant/22"],
  visibleCount: 1,
  // Hoy está a la venta el Cupón 1; el Cupón 2 todavía no salió.
  coupons: [
    { id: "c1", code: "DFVAAA", amount: 100_000, label: "Cupón 1", position: 1, used: 0, stock: 5 },
    { id: "c2", code: "DFVBBB", amount: 125_000, label: "Cupón 2", position: 2, used: 0, stock: 5 },
  ],
};

const pedido = (p: Partial<PedidoParaCupones>): PedidoParaCupones => ({
  admin_graphql_api_id: "gid://shopify/Order/1",
  name: "#1001",
  line_items: [],
  ...p,
});

test("PAGO TOTAL: el código aplicado + una línea de pago total consumen el cupón", () => {
  const r = decidirConsumos(
    pedido({
      line_items: [{ variant_id: 11, quantity: 1 }],
      discount_codes: [{ code: "dfvaaa" }],
    }),
    [campana]
  );
  assert.deepEqual(r, [
    { campaignId: "camp", couponId: "c1", mode: "FULL_PAYMENT", passengers: 1, amount: 100_000 },
  ]);
});

test("RESERVA: el atributo del carrito + una línea de reserva consumen el cupón", () => {
  const r = decidirConsumos(
    pedido({
      line_items: [{ variant_id: 22, quantity: 1 }],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: "DFVBBB" }],
    }),
    [campana]
  );
  assert.deepEqual(r, [
    { campaignId: "camp", couponId: "c2", mode: "RESERVATION", passengers: 1, amount: 125_000 },
  ]);
});

test("🔴 un atributo SIN reserva de ese viaje no consume nada", () => {
  // El atributo lo escribe el navegador: solo vale si el pedido tiene de
  // verdad una reserva del viaje del cupón.
  const r = decidirConsumos(
    pedido({
      line_items: [{ variant_id: 99, quantity: 1 }],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: "DFVAAA" }],
    }),
    [campana]
  );
  assert.deepEqual(r, []);
});

test("🔴 un código inventado en el atributo no consume nada", () => {
  const r = decidirConsumos(
    pedido({
      line_items: [{ variant_id: 22, quantity: 1 }],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: "DFVINVENTADO" }],
    }),
    [campana]
  );
  assert.deepEqual(r, []);
});

test("un código de pago total sin línea de pago total no consume (Shopify no lo aplicó)", () => {
  const r = decidirConsumos(
    pedido({ line_items: [{ variant_id: 22, quantity: 1 }], discount_codes: [{ code: "DFVAAA" }] }),
    [campana]
  );
  assert.deepEqual(r, []);
});

test("pago total y reserva del mismo viaje con el cupón: consume UNA vez, como pago total", () => {
  const r = decidirConsumos(
    pedido({
      line_items: [
        { variant_id: 11, quantity: 1 },
        { variant_id: 22, quantity: 1 },
      ],
      discount_codes: [{ code: "DFVAAA" }],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: "DFVAAA" }],
    }),
    [campana]
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].mode, "FULL_PAYMENT");
});

test("sin cupones en el pedido no se consume nada, y no revienta con campos nulos", () => {
  assert.deepEqual(
    decidirConsumos(
      pedido({ line_items: [{ variant_id: null, quantity: 1 }], discount_codes: null, note_attributes: null }),
      [campana]
    ),
    []
  );
});

test("🔴 POR PASAJERO en Reserva: 3 reservas con un cupón de $100.000 anotan $300.000", () => {
  const r = decidirConsumos(
    pedido({
      line_items: [{ variant_id: 22, quantity: 3 }],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: "DFVAAA" }],
    }),
    [campana]
  );
  assert.deepEqual(r, [
    { campaignId: "camp", couponId: "c1", mode: "RESERVATION", passengers: 3, amount: 300_000 },
  ]);
});

test("🔴 POR PASAJERO en Pago total: 2 unidades con el cupón suman el descuento de las 2", () => {
  const r = decidirConsumos(
    pedido({
      line_items: [{ variant_id: 11, quantity: 2 }],
      discount_codes: [{ code: "DFVAAA" }],
    }),
    [campana]
  );
  assert.equal(r[0].passengers, 2);
  assert.equal(r[0].amount, 200_000);
});

test("los pasajeros de dos líneas de la misma modalidad (dos fechas) se suman", () => {
  const conDosFechas: CampanaParaPedido = {
    ...campana,
    reservationVariantIds: ["gid://shopify/ProductVariant/22", "gid://shopify/ProductVariant/23"],
  };
  const r = decidirConsumos(
    pedido({
      line_items: [
        { variant_id: 22, quantity: 2 },
        { variant_id: 23, quantity: 1 },
      ],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: "DFVAAA" }],
    }),
    [conDosFechas]
  );
  assert.equal(r[0].passengers, 3);
  assert.equal(r[0].amount, 300_000);
});

// ─── Pedido limpio: la Reserva se reconoce por el NOMBRE (2026-09-25) ─────────

const reservaCon = (valor: string, cantidad = 1) =>
  pedido({
    line_items: [{ variant_id: 22, quantity: cantidad }],
    note_attributes: [{ name: ATRIBUTO_CUPON, value: valor }],
  });

test("🔴 RESERVA por nombre: «Cupón de viaje» + una reserva del viaje consumen el cupón", () => {
  const r = decidirConsumos(reservaCon("Cupón 1 · $100.000 por pasajero", 2), [campana]);
  assert.deepEqual(r, [
    { campaignId: "camp", couponId: "c1", mode: "RESERVATION", passengers: 2, amount: 200_000 },
  ]);
});

test("el nombre se compara sin mayúsculas ni espacios de más", () => {
  const r = decidirConsumos(reservaCon("  cupón   1 · $100.000 por pasajero"), [campana]);
  assert.equal(r[0]?.couponId, "c1");
});

test("🔴 un cupón que la tienda TODAVÍA NO publicó no se puede reclamar por nombre", () => {
  // El nombre se adivina («Cupón 2»); el código no. Por nombre solo vale uno
  // que ya salió a la venta.
  assert.deepEqual(decidirConsumos(reservaCon("Cupón 2 · $125.000 por pasajero"), [campana]), []);
});

test("un cupón ya AGOTADO que se publicó antes sí se reconoce (el consumo lo marca como excedente)", () => {
  const conElPrimeroAgotado: CampanaParaPedido = {
    ...campana,
    coupons: [
      { ...campana.coupons[0], used: 5 },
      campana.coupons[1],
    ],
  };
  const r = decidirConsumos(reservaCon("Cupón 1 · $100.000 por pasajero"), [conElPrimeroAgotado]);
  assert.equal(r[0]?.couponId, "c1");
});

test("un nombre inventado no consume nada", () => {
  assert.deepEqual(decidirConsumos(reservaCon("Cupón 9 · $900.000 por pasajero"), [campana]), []);
});

test("sin reserva del viaje, el nombre solo no consume nada", () => {
  const r = decidirConsumos(
    pedido({
      line_items: [{ variant_id: 99, quantity: 1 }],
      note_attributes: [{ name: ATRIBUTO_CUPON, value: "Cupón 1 · $100.000 por pasajero" }],
    }),
    [campana]
  );
  assert.deepEqual(r, []);
});

// ─── Cupos en 0 y nombres únicos (formulario) ────────────────────────────────

test("🔴 cupos en 0 se aceptan: el cupón queda agotado y se publica el siguiente", () => {
  const d = leerDatosDelFormulario({
    ...formularioValido,
    coupons: [
      { id: "c1", label: "Cupón 1", amount: "100.000", stock: "0" },
      { id: "c2", label: "Cupón 2", amount: "125.000", stock: "5" },
    ],
  });
  const { errores, cupones } = validarFormulario(d, {});
  assert.deepEqual(errores, {});
  assert.equal(cupones[0].stock, 0);
  const guardados = cupones.map((c, i) => ({ ...c, position: i + 1, used: 0 }));
  assert.deepEqual(cuponesPublicados(guardados, 1).map((c) => c.label), ["Cupón 2"]);
});

test("con usos, los cupos no bajan de lo usado y el error dice cómo agotarlo", () => {
  const d = leerDatosDelFormulario({
    ...formularioValido,
    coupons: [{ id: "c1", label: "Cupón 1", amount: "100.000", stock: "0" }],
  });
  assert.match(validarFormulario(d, { c1: 2 }).errores.coupons ?? "", /Para agotarlo, poné 2/);
});

test("dos cupones con el mismo nombre se rechazan", () => {
  const d = leerDatosDelFormulario({
    ...formularioValido,
    coupons: [
      { label: "Cupón 1", amount: "100.000", stock: "5" },
      { label: " cupón 1 ", amount: "125.000", stock: "5" },
    ],
  });
  assert.match(validarFormulario(d).errores.coupons ?? "", /mismo nombre|llamados/);
});

test("autoApply solo se enciende con un `true` explícito: lo que falte deja el comportamiento de siempre", () => {
  assert.equal(leerDatosDelFormulario({ ...formularioValido, autoApply: true }).autoApply, true);
  assert.equal(leerDatosDelFormulario({ ...formularioValido, autoApply: "true" }).autoApply, false);
  assert.equal(leerDatosDelFormulario(formularioValido).autoApply, false);
});
