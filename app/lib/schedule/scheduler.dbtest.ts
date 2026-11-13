// Pruebas del cron de programación contra Postgres de verdad (base de DEV).
//
//   node --experimental-strip-types --env-file=.env --test-concurrency=1 \
//        --test app/lib/schedule/scheduler.dbtest.ts
//
// Aisladas igual que engine.dbtest.ts: una tienda de prueba con dominio
// .myshopify.test (inalcanzable), y el tick limitado a esa tienda con
// `onlyShopId`, así que no puede tocar ninguna campaña real de la base.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import prisma from "../../db.server.ts";
import { runScheduleTick } from "./scheduler.server.ts";

const TEST_DOMAIN = "discountflow-schedule-test.myshopify.test";
let SHOP_ID = "";
let seq = 0;

const hace = (min: number) => new Date(Date.now() - min * 60_000);
const en = (min: number) => new Date(Date.now() + min * 60_000);

before(async () => {
  assert.ok(!TEST_DOMAIN.endsWith(".myshopify.com"), "ABORTADO: dominio de prueba con forma de real");
  const url = process.env.DATABASE_URL ?? "";
  assert.ok(url.includes("ep-nameless-credit"), "ABORTADO: estas pruebas solo corren contra la base de DEV");
  const shop = await prisma.shop.upsert({
    where: { domain: TEST_DOMAIN },
    create: { domain: TEST_DOMAIN, accessToken: "test-token", currency: "CLP", plan: "ESSENTIAL" },
    update: { plan: "ESSENTIAL" },
  });
  SHOP_ID = shop.id;
  await prisma.campaign.deleteMany({ where: { shopId: SHOP_ID } });
});

after(async () => {
  if (SHOP_ID) {
    await prisma.campaign.deleteMany({ where: { shopId: SHOP_ID } });
    await prisma.campaignJob.deleteMany({ where: { shopId: SHOP_ID } });
    await prisma.shop.deleteMany({ where: { id: SHOP_ID, domain: TEST_DOMAIN } });
  }
  await prisma.$disconnect();
});

async function campaña(data: Record<string, unknown>) {
  return prisma.campaign.create({
    data: {
      shopId: SHOP_ID,
      name: `[test] programación #${++seq}`,
      type: "PERCENTAGE",
      status: "DRAFT",
      config: { discountPercent: 10, selectionMode: "collections", collectionIds: ["gid://shopify/Collection/1"] },
      ...data,
    } as never,
  });
}

async function tick() {
  const despachados: string[] = [];
  const r = await runScheduleTick({
    onlyShopId: SHOP_ID,
    dispatch: async (id) => {
      despachados.push(id);
    },
  });
  return { r, despachados };
}

/** Deja la tienda sin jobs vivos ni campañas entre pruebas. */
async function limpiar() {
  await prisma.campaign.updateMany({ where: { shopId: SHOP_ID }, data: { activeJobId: null } });
  await prisma.campaign.deleteMany({ where: { shopId: SHOP_ID } });
  await prisma.campaignJob.deleteMany({ where: { shopId: SHOP_ID } });
}

test("🔒 campañas VIEJAS con fechas vencidas y sin marca: el tick no las toca", async () => {
  await limpiar();
  const a = await campaña({ status: "PAUSED", startsAt: hace(9000), endsAt: hace(8000) });
  const b = await campaña({ status: "ACTIVE", endsAt: hace(60) });
  const c = await campaña({ status: "DRAFT", startsAt: hace(60) });
  const { r, despachados } = await tick();
  assert.equal(r.revisadas, 0);
  assert.deepEqual(despachados, []);
  assert.equal(await prisma.campaignJob.count({ where: { shopId: SHOP_ID } }), 0);
  for (const x of [a, b, c]) {
    const d = await prisma.campaign.findUnique({ where: { id: x.id } });
    assert.equal(d?.status, x.status);
    assert.equal(d?.activeJobId, null);
  }
});

test("inicio programado: al llegar la hora encola un APPLY con la selección guardada", async () => {
  await limpiar();
  const seleccion = { selectionMode: "collections", collectionIds: ["gid://shopify/Collection/1"] };
  const c = await campaña({
    autoStart: true,
    startsAt: hace(1),
    config: { discountPercent: 10, pendingApply: { selection: seleccion, excludedVariantIds: ["v1"] } },
  });
  const futura = await campaña({ autoStart: true, startsAt: en(30) });

  const { r, despachados } = await tick();
  assert.deepEqual(r.iniciadas, [c.id]);
  assert.equal(despachados.length, 1);

  const job = await prisma.campaignJob.findUnique({ where: { id: despachados[0] } });
  assert.equal(job?.operation, "APPLY");
  const payload = job?.payload as { selection: unknown; excludedVariantIds: string[]; maxVariants: number };
  assert.deepEqual(payload.selection, seleccion);
  assert.deepEqual(payload.excludedVariantIds, ["v1"]);
  assert.equal(typeof payload.maxVariants, "number");

  const d = await prisma.campaign.findUnique({ where: { id: c.id } });
  assert.equal(d?.autoStart, false, "la marca se apaga: cada fecha actúa una sola vez");
  assert.equal(d?.activeJobId, job?.id, "la campaña queda tomada por el job");
  assert.equal(d?.status, "DRAFT", "pasa a ACTIVE cuando el motor termina, no antes");

  // La que empieza en 30 minutos no se toca.
  const f = await prisma.campaign.findUnique({ where: { id: futura.id } });
  assert.equal(f?.autoStart, true);
  assert.equal(f?.activeJobId, null);

  // Un segundo tick no la vuelve a disparar.
  const segundo = await tick();
  assert.deepEqual(segundo.r.iniciadas, []);
  assert.deepEqual(segundo.despachados, []);
});

test("inicio programado de una campaña PAUSADA con filas: encola un REACTIVATE", async () => {
  await limpiar();
  const c = await campaña({ status: "PAUSED", autoStart: true, startsAt: hace(1), config: { discountPercent: 10 } });
  await prisma.campaignProduct.create({
    data: {
      campaignId: c.id,
      shopifyProductId: "gid://shopify/Product/1",
      shopifyVariantId: "gid://shopify/ProductVariant/1",
      originalPrice: "100.00",
    } as never,
  });
  const { r, despachados } = await tick();
  assert.deepEqual(r.iniciadas, [c.id]);
  const job = await prisma.campaignJob.findUnique({ where: { id: despachados[0] } });
  assert.equal(job?.operation, "REACTIVATE");
  assert.equal(await prisma.campaignProduct.count({ where: { campaignId: c.id } }), 1, "las filas no se tocan");
});

test("fin programado: al llegar la hora encola un REVERT (pausar) y apaga la marca", async () => {
  await limpiar();
  const c = await campaña({ status: "ACTIVE", autoEnd: true, endsAt: hace(1) });
  const noAun = await campaña({ status: "ACTIVE", autoEnd: true, endsAt: en(30) });
  const { r, despachados } = await tick();
  assert.deepEqual(r.terminadas, [c.id]);
  const job = await prisma.campaignJob.findUnique({ where: { id: despachados[0] } });
  assert.equal(job?.operation, "REVERT");
  assert.equal((await prisma.campaign.findUnique({ where: { id: c.id } }))?.autoEnd, false);
  assert.equal((await prisma.campaign.findUnique({ where: { id: noAun.id } }))?.autoEnd, true);
});

test("con una operación en curso no se pisa: espera al siguiente tick", async () => {
  await limpiar();
  const c = await campaña({ status: "ACTIVE", autoEnd: true, endsAt: hace(1) });
  const vivo = await prisma.campaignJob.create({
    data: { campaignId: c.id, campaignName: c.name, shopId: SHOP_ID, operation: "APPLY", heartbeatAt: new Date() } as never,
  });
  await prisma.campaign.update({ where: { id: c.id }, data: { activeJobId: vivo.id } });
  const { r, despachados } = await tick();
  assert.deepEqual(r.terminadas, []);
  assert.equal(despachados.includes(vivo.id), false, "un job vivo y con latido no se re-despacha");
  assert.equal((await prisma.campaign.findUnique({ where: { id: c.id } }))?.autoEnd, true, "la marca sigue para el próximo tick");
});

test("no arranca si el plan ya está al tope de campañas activas: deja un aviso", async () => {
  await limpiar();
  await prisma.shop.update({ where: { id: SHOP_ID }, data: { plan: "FREE" } }); // 2 activas
  await campaña({ status: "ACTIVE" });
  await campaña({ status: "ACTIVE" });
  const c = await campaña({ autoStart: true, startsAt: hace(1), config: { pendingApply: { selection: { selectionMode: "all" } } } });
  const { r, despachados } = await tick();
  assert.deepEqual(despachados, []);
  assert.equal(r.avisos.length, 1);
  const d = await prisma.campaign.findUnique({ where: { id: c.id } });
  assert.equal(d?.autoStart, false);
  assert.match(d?.scheduleNote ?? "", /No se activó a la hora programada/);
  assert.equal(d?.status, "DRAFT");
  await prisma.shop.update({ where: { id: SHOP_ID }, data: { plan: "ESSENTIAL" } });
});

test("inicio y fin vencidos a la vez: no arranca para apagarse enseguida", async () => {
  await limpiar();
  const c = await campaña({ autoStart: true, autoEnd: true, startsAt: hace(120), endsAt: hace(60) });
  const { r, despachados } = await tick();
  assert.deepEqual(despachados, []);
  assert.equal(r.avisos.length, 1);
  const d = await prisma.campaign.findUnique({ where: { id: c.id } });
  assert.equal(d?.autoStart, false);
  assert.equal(d?.autoEnd, false);
});

test("marcas que quedaron sin efecto se limpian sin crear jobs", async () => {
  await limpiar();
  const a = await campaña({ status: "ACTIVE", autoStart: true, startsAt: hace(1) }); // la activaron a mano
  const b = await campaña({ status: "PAUSED", autoEnd: true, endsAt: hace(1) }); // la pausaron a mano
  const { r, despachados } = await tick();
  assert.deepEqual(despachados, []);
  assert.equal(r.limpiadas.length, 2);
  assert.equal((await prisma.campaign.findUnique({ where: { id: a.id } }))?.autoStart, false);
  assert.equal((await prisma.campaign.findUnique({ where: { id: b.id } }))?.autoEnd, false);
});
