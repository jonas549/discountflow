// El consumo de stock de los cupones de viaje, contra Postgres REAL (la base de
// dev de Neon). Lo que no se puede probar con un módulo puro: que dos pedidos
// simultáneos sobre el último uso no se pasen del stock.
//
// Uso:
//   node --experimental-strip-types --env-file=.env --test-concurrency=1 \
//     --test app/lib/cupones-viaje/consumo.dbtest.ts
//
// 🔴 Crea una tienda TEMPORAL con dominio `.invalid` y la borra al terminar (el
// cascade se lleva campañas, cupones y canjes). Aborta si la base tiene más de
// una tienda real: es la señal de que apunta a producción.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import prisma from "../../db.server.ts";
import {
  consumirCupon,
  payloadDeLaTienda,
  registrarPedido,
} from "./cupones-viaje.server.ts";
import { ATRIBUTO_CODIGO } from "./cupones-viaje.ts";

const DOMINIO = `dbtest-cupones-viaje-${process.pid}.invalid`;
let shopId = "";
let campaignId = "";
let cupon1 = "";
let cupon2 = "";

before(async () => {
  const reales = await prisma.shop.count({ where: { NOT: { domain: { endsWith: ".invalid" } } } });
  if (reales > 1) throw new Error(`La base tiene ${reales} tiendas: parece PRODUCCIÓN. Abortado.`);

  const shop = await prisma.shop.create({
    data: { domain: DOMINIO, accessToken: "x", features: { "cupones:viaje": true } },
  });
  shopId = shop.id;
  const campana = await prisma.travelCouponCampaign.create({
    data: {
      shopId,
      name: "Kenia (test)",
      status: "ACTIVE",
      productId: "gid://shopify/Product/555",
      productTitle: "Kenia",
      optionName: "Tipo de Reserva",
      fullPaymentValue: "Pago Total",
      reservationValue: "Reserva",
      fullPaymentVariantIds: ["gid://shopify/ProductVariant/11"],
      reservationVariantIds: ["gid://shopify/ProductVariant/22"],
      visibleCount: 1,
      heading: "Cupones",
      messageFullPayment: "a",
      messageReservation: "b",
      coupons: {
        create: [
          { position: 1, label: "Cupón 1", amount: 100000, stock: 3, code: `DFVUNO${process.pid}` },
          { position: 2, label: "Cupón 2", amount: 125000, stock: 2, code: `DFVDOS${process.pid}` },
        ],
      },
    },
    include: { coupons: { orderBy: { position: "asc" } } },
  });
  campaignId = campana.id;
  cupon1 = campana.coupons[0].id;
  cupon2 = campana.coupons[1].id;
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMINIO } });
  await prisma.$disconnect();
});

test("🔴 diez pedidos simultáneos sobre un cupón con stock 3: exactamente 3 válidos", async () => {
  const resultados = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      consumirCupon(
        { campaignId, couponId: cupon1, mode: "RESERVATION", passengers: 1, amount: 100000 },
        { id: `gid://shopify/Order/9${i}`, name: `#9${i}` },
        "simulado"
      )
    )
  );
  assert.equal(resultados.filter((r) => r === "registrado").length, 3);
  assert.equal(resultados.filter((r) => r === "excedente").length, 7);

  const c = await prisma.travelCoupon.findUniqueOrThrow({ where: { id: cupon1 } });
  assert.equal(c.used, 3, "el contador no puede pasarse del stock");

  // Los excedentes quedan registrados: el pedido existe y la agencia decide.
  const canjes = await prisma.travelCouponRedemption.findMany({ where: { couponId: cupon1 } });
  assert.equal(canjes.length, 10);
  assert.equal(canjes.filter((x) => x.excess).length, 7);
});

test("el mismo pedido dos veces (Shopify reintenta) no consume dos veces", async () => {
  const pedido = { id: "gid://shopify/Order/9000", name: "#9000" };
  const consumo = { campaignId, couponId: cupon2, mode: "RESERVATION" as const, passengers: 1, amount: 125000 };
  assert.equal(await consumirCupon(consumo, pedido, "simulado"), "registrado");
  assert.equal(await consumirCupon(consumo, pedido, "simulado"), "repetido");
  const c = await prisma.travelCoupon.findUniqueOrThrow({ where: { id: cupon2 } });
  assert.equal(c.used, 1);
});

test("🔴 con el primer cupón agotado, la tienda muestra el siguiente sin que nadie toque nada", async () => {
  const p = await payloadDeLaTienda(shopId, "555");
  assert.ok(p);
  assert.deepEqual(
    p.coupons.map((c) => [c.label, c.agotado, c.restantes, c.code !== null]),
    [
      ["Cupón 1", true, 0, false], // agotado: apagado y SIN código
      ["Cupón 2", false, 1, true],
    ]
  );
});

test("registrarPedido (el camino del webhook) consume por el atributo de la reserva", async () => {
  const c2 = await prisma.travelCoupon.findUniqueOrThrow({ where: { id: cupon2 } });
  const out = await registrarPedido(
    shopId,
    {
      admin_graphql_api_id: "gid://shopify/Order/9100",
      name: "#9100",
      line_items: [{ variant_id: 22, quantity: 1 }],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: c2.code }],
    },
    null,
    "simulado"
  );
  assert.deepEqual(
    out.map((o) => [o.mode, o.resultado]),
    [["RESERVATION", "registrado"]]
  );

  // Cupón 2 también quedó agotado: ya no hay nada publicado.
  const p = await payloadDeLaTienda(shopId, "555");
  assert.ok(p);
  assert.equal(p.coupons.filter((c) => !c.agotado).length, 0);
});

test("🔴 POR PASAJERO: 3 pasajeros sobre 2 cupos consumen 2 y dejan 1 como excedente", async () => {
  const c = await prisma.travelCoupon.create({
    data: { campaignId, position: 3, label: "Cupón 3", amount: 1000, stock: 2, code: `DFVTRES${process.pid}` },
  });
  const r = await consumirCupon(
    { campaignId, couponId: c.id, mode: "RESERVATION", passengers: 3, amount: 3000 },
    { id: "gid://shopify/Order/9200", name: "#9200" },
    "simulado"
  );
  assert.equal(r, "excedente");
  const despues = await prisma.travelCoupon.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(despues.used, 2, "el stock no puede pasarse: entran 2 de los 3");
  const canje = await prisma.travelCouponRedemption.findFirstOrThrow({
    where: { couponId: c.id, shopifyOrderId: "gid://shopify/Order/9200" },
  });
  assert.equal(canje.passengers, 3);
  assert.equal(canje.excessPassengers, 1);
  assert.equal(Number(canje.amount), 3000, "el comprobante guarda el total de los 3 pasajeros");
});

test("registrarPedido con 2 reservas anota el total de los 2 pasajeros (el bug del #1020)", async () => {
  const c = await prisma.travelCoupon.create({
    data: { campaignId, position: 4, label: "Test 1", amount: 1000, stock: 10, code: `DFVCUATRO${process.pid}` },
  });
  const out = await registrarPedido(
    shopId,
    {
      admin_graphql_api_id: "gid://shopify/Order/9300",
      name: "#9300",
      line_items: [{ variant_id: 22, quantity: 2 }],
      note_attributes: [{ name: ATRIBUTO_CODIGO, value: c.code }],
    },
    null,
    "simulado"
  );
  assert.deepEqual(
    out.map((o) => [o.mode, o.passengers, o.amount, o.resultado]),
    [["RESERVATION", 2, 2000, "registrado"]]
  );
  assert.equal((await prisma.travelCoupon.findUniqueOrThrow({ where: { id: c.id } })).used, 2);
});

test("una campaña PAUSADA no se muestra en la tienda", async () => {
  await prisma.travelCouponCampaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
  assert.equal(await payloadDeLaTienda(shopId, "555"), null);
});
