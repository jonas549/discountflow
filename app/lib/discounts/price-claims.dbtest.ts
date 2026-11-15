// Defecto H1 del QA (2026-11-14): dos campañas de precio sobre el mismo producto
// lo dejaban rebajado sin ninguna campaña activa.
//
//   npm run test:claims
//
// Corre contra PostgreSQL REAL (branch `dev` de Neon), igual que la batería del
// motor y por el mismo motivo: la regla «una variante, una sola campaña» es un
// cerrojo y una consulta, no lógica de JavaScript.
//
// A diferencia de fake-admin.ts, la tienda de aquí TIENE MEMORIA: una mutación
// cambia el precio y la lectura siguiente lo devuelve cambiado. Es lo que hace
// falta para reproducir H1, donde la segunda campaña LEE el precio que dejó la
// primera. Lo que se aserta al final es siempre lo mismo que miró el QA: el
// precio que queda en la tienda.
//
// 🔒 Mismo aislamiento que engine.dbtest.ts: una tienda .myshopify.test, todo
//    borrado acotado por shopId, teardown siempre.

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import prisma from "../../db.server.ts";
import { createJob, getJob } from "../jobs/jobs.server.ts";
import { runJobBatch } from "../jobs/runner.server.ts";
import { readSkipReport } from "./manual-discounts.ts";
import { readOverlapReport } from "./price-claims.ts";
import { buildRevertPlanFor, findHolders, releaseHeldRows } from "./price-claims.server.ts";

const TEST_DOMAIN = "claims-test.myshopify.test";
let SHOP_ID = "";

before(async () => {
  assert.ok(!TEST_DOMAIN.endsWith(".myshopify.com"), "ABORTADO: dominio de prueba con pinta de real");
  const shop = await prisma.shop.upsert({
    where: { domain: TEST_DOMAIN },
    create: { domain: TEST_DOMAIN, accessToken: "test-token-no-sirve-para-nada", currency: "USD", plan: "FREE" },
    update: {},
  });
  SHOP_ID = shop.id;
  const reales = await prisma.shop.findMany({
    where: { domain: { endsWith: ".myshopify.com" } },
    select: { id: true },
  });
  assert.equal(reales.some((s) => s.id === SHOP_ID), false, "ABORTADO: el shopId de prueba es de una tienda real");
  const recargada = await prisma.shop.findUnique({ where: { id: SHOP_ID } });
  assert.equal(recargada?.domain, TEST_DOMAIN, "ABORTADO: el shop de prueba no tiene el dominio esperado");
});

const limpiar = async () => {
  if (!SHOP_ID) return;
  await prisma.campaign.deleteMany({ where: { shopId: SHOP_ID } });
  await prisma.campaignJob.deleteMany({ where: { shopId: SHOP_ID } });
};

// Cada test arranca con la tienda de prueba vacía: los ids del catálogo falso se
// repiten, y una campaña activa de otro test tendría «tomadas» sus variantes.
beforeEach(limpiar);

after(async () => {
  await limpiar();
  if (SHOP_ID) await prisma.shop.deleteMany({ where: { id: SHOP_ID, domain: TEST_DOMAIN } });
  await prisma.$disconnect();
});

// ─── Tienda falsa CON memoria ─────────────────────────────────────────────────

const VARIANTES = 2;
const pid = (i: number) => `gid://shopify/Product/${i}`;
const vid = (i: number, v: number) => `gid://shopify/ProductVariant/${i}-${v}`;

type Precio = { price: string; compareAtPrice: string | null };

function crearTienda(productos: number, precio = "100.00") {
  const precios = new Map<string, Precio>();
  for (let i = 0; i < productos; i++)
    for (let v = 0; v < VARIANTES; v++) precios.set(vid(i, v), { price: precio, compareAtPrice: null });
  const mutaciones: Array<{ productId: string; variantIds: string[] }> = [];

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const nodo = (i: number) => ({
    id: pid(i),
    title: `Producto ${i}`,
    variants: {
      nodes: Array.from({ length: VARIANTES }, (_, v) => ({ id: vid(i, v), ...precios.get(vid(i, v))! })),
    },
  });

  /** Un cliente que solo «ve» estos productos, pero escribe en la tienda común. */
  const vista = (indices: number[]) => ({
    async graphql(query: string, opts?: { variables: unknown }) {
      const vars = (opts?.variables ?? {}) as Record<string, unknown>;
      if (query.includes("productVariantsBulkUpdate")) {
        const variants = (vars.variants ?? []) as Array<{ id: string; price: string; compareAtPrice: string | null }>;
        mutaciones.push({ productId: String(vars.productId), variantIds: variants.map((x) => x.id) });
        for (const x of variants) precios.set(x.id, { price: x.price, compareAtPrice: x.compareAtPrice ?? null });
        return json({
          data: { productVariantsBulkUpdate: { productVariants: variants.map((x) => ({ id: x.id })), userErrors: [] } },
        });
      }
      const pagina = {
        nodes: indices.map(nodo),
        pageInfo: { hasNextPage: false, endCursor: String(indices.length) },
      };
      if (query.includes("GetCollectionProducts")) return json({ data: { collection: { products: pagina } } });
      if (query.includes("GetAllProducts") || query.includes("GetFilteredProducts"))
        return json({ data: { products: pagina } });
      return json({ data: {} });
    },
  });

  return {
    vista,
    mutaciones,
    /** Precio de la primera variante del producto, en número, como lo ve el comprador. */
    precio(i: number) {
      const p = precios.get(vid(i, 0))!;
      return { price: Number(p.price), compareAtPrice: p.compareAtPrice === null ? null : Number(p.compareAtPrice) };
    },
    poner(i: number, p: Precio) {
      for (let v = 0; v < VARIANTES; v++) precios.set(vid(i, v), { ...p });
    },
  };
}

const ORIGEN = { price: 100, compareAtPrice: null };

// ─── Utilidades ───────────────────────────────────────────────────────────────

type Admin = ReturnType<ReturnType<typeof crearTienda>["vista"]>;
let seq = 0;

async function campaña(nombre: string, config: Record<string, unknown>, type: "PERCENTAGE" | "RANGE" = "PERCENTAGE") {
  return prisma.campaign.create({
    data: { shopId: SHOP_ID, name: `[test] ${nombre} #${++seq}`, type, status: "DRAFT", config: config as never },
  });
}
const pct = (nombre: string, discountPercent: number) =>
  campaña(nombre, { discountPercent, showCompareAtPrice: false });

async function correr(campaignId: string, operation: "APPLY" | "REACTIVATE" | "REVERT" | "DELETE", admin: Admin) {
  const { job, created } = await createJob({
    campaignId,
    shopId: SHOP_ID,
    operation,
    ...(operation === "APPLY" ? { payload: { selection: { selectionMode: "all" } } } : {}),
  });
  assert.equal(created, true, "la campaña tenía otra operación en curso");
  for (let i = 0; i < 50; i++) {
    const out = await runJobBatch(job.id, {
      deadlineMs: 45_000,
      getAdmin: async () => admin,
      dispatchNext: async () => {},
    });
    if (!out.claimed || !out.chained) break;
  }
  const fin = await getJob(job.id, SHOP_ID);
  assert.equal(fin?.status, "COMPLETED", `${operation}: ${fin?.status} · ${fin?.lastError ?? ""}`);
}

const productosDe = async (campaignId: string) =>
  (
    await prisma.campaignProduct.groupBy({ by: ["shopifyProductId"], where: { campaignId }, orderBy: { shopifyProductId: "asc" } })
  ).map((g) => g.shopifyProductId);

const estado = async (campaignId: string) =>
  (await prisma.campaign.findUnique({ where: { id: campaignId } }))?.status;

const solapes = async (campaignId: string) =>
  readOverlapReport((await prisma.campaign.findUnique({ where: { id: campaignId } }))?.skipReport);

// ═══ El caso del QA ═══════════════════════════════════════════════════════════

test("🔴 H1 (P8–P10): dos campañas de Porcentaje sobre el mismo producto; al pausar las dos vuelve a su precio real", async () => {
  const tienda = crearTienda(1);
  const admin = tienda.vista([0]);
  const a = await pct("Pct 10", 10);
  const b = await pct("Pct 30", 30);

  await correr(a.id, "APPLY", admin);
  assert.deepEqual(tienda.precio(0), { price: 90, compareAtPrice: 100 });

  // La segunda NO se apila: el producto ya lo tiene la primera.
  const antes = tienda.mutaciones.length;
  await correr(b.id, "APPLY", admin);
  assert.equal(tienda.mutaciones.length, antes, "la segunda campaña no debe tocar el precio");
  assert.deepEqual(tienda.precio(0), { price: 90, compareAtPrice: 100 }, "sigue el precio de la primera");
  assert.deepEqual(await productosDe(b.id), [], "la segunda no guarda ningún «original»");
  assert.equal(await estado(b.id), "ACTIVE");

  // Y lo dice en su fila del listado, nombrando a la que lo tiene.
  const reporte = await solapes(b.id);
  assert.equal(reporte?.total, 1);
  assert.equal(reporte?.products[0].id, pid(0));
  assert.equal(reporte?.products[0].title, "Producto 0");
  assert.equal(reporte?.products[0].variants, VARIANTES);
  assert.equal(reporte?.products[0].campaignName, a.name);

  // Pausar la primera: precio real. Pausar la segunda: sigue en el precio real.
  await correr(a.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN);
  await correr(b.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN, "🔴 con las dos pausadas el producto NO puede quedar rebajado");
  assert.equal(await estado(a.id), "PAUSED");
  assert.equal(await estado(b.id), "PAUSED");
});

test("🔴 H1 en el otro orden: pausar primero la segunda y después la primera", async () => {
  const tienda = crearTienda(1);
  const admin = tienda.vista([0]);
  const a = await pct("Pct 10", 10);
  const b = await pct("Pct 30", 30);
  await correr(a.id, "APPLY", admin);
  await correr(b.id, "APPLY", admin);

  await correr(b.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), { price: 90, compareAtPrice: 100 }, "la primera sigue activa y descontando");
  await correr(a.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN);
});

test("🔴 H1 (R12): Porcentaje 20 % + Rango $50 sobre el mismo producto", async () => {
  const tienda = crearTienda(1);
  const admin = tienda.vista([0]);
  const a = await pct("Pct 20", 20);
  const r = await campaña("Rango 50", { mode: "fixedPrice", value: 50 }, "RANGE");
  await correr(a.id, "APPLY", admin);
  await correr(r.id, "APPLY", admin);
  assert.deepEqual(tienda.precio(0), { price: 80, compareAtPrice: 100 });
  assert.equal((await solapes(r.id))?.total, 1);

  await correr(a.id, "REVERT", admin);
  await correr(r.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN);
});

// ═══ Lo que NO puede cambiar ══════════════════════════════════════════════════

test("campañas que no comparten productos: todo igual que antes, sin aviso", async () => {
  const tienda = crearTienda(4);
  const a = await pct("A", 10);
  const b = await pct("B", 30);
  await correr(a.id, "APPLY", tienda.vista([0, 1]));
  await correr(b.id, "APPLY", tienda.vista([2, 3]));
  assert.deepEqual(tienda.precio(0), { price: 90, compareAtPrice: 100 });
  assert.deepEqual(tienda.precio(2), { price: 70, compareAtPrice: 100 });
  assert.equal(await solapes(a.id), null);
  assert.equal(await solapes(b.id), null);
  assert.equal((await prisma.campaign.findUnique({ where: { id: b.id } }))?.skipReport, null);

  await correr(a.id, "REVERT", tienda.vista([0, 1]));
  await correr(b.id, "REVERT", tienda.vista([2, 3]));
  for (const i of [0, 1, 2, 3]) assert.deepEqual(tienda.precio(i), ORIGEN);
});

test("una campaña PAUSADA no tiene nada tomado: la siguiente se aplica entera", async () => {
  const tienda = crearTienda(2);
  const admin = tienda.vista([0, 1]);
  const a = await pct("A", 10);
  const b = await pct("B", 30);
  await correr(a.id, "APPLY", admin);
  await correr(a.id, "REVERT", admin);

  await correr(b.id, "APPLY", admin);
  assert.deepEqual(await productosDe(b.id), [pid(0), pid(1)]);
  assert.equal(await solapes(b.id), null);
  assert.deepEqual(tienda.precio(0), { price: 70, compareAtPrice: 100 });
  await correr(b.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN);
});

// ═══ Solape parcial, reactivar y eliminar ═════════════════════════════════════

test("solape PARCIAL: la segunda se aplica a los productos libres y salta solo el compartido", async () => {
  const tienda = crearTienda(4);
  const a = await pct("A", 10);
  const b = await pct("B", 30);
  await correr(a.id, "APPLY", tienda.vista([0, 1]));
  await correr(b.id, "APPLY", tienda.vista([1, 2, 3]));

  assert.deepEqual(await productosDe(b.id), [pid(2), pid(3)]);
  assert.deepEqual(tienda.precio(1), { price: 90, compareAtPrice: 100 }, "el compartido sigue con la primera");
  assert.deepEqual(tienda.precio(2), { price: 70, compareAtPrice: 100 });
  assert.deepEqual((await solapes(b.id))?.products.map((p) => p.id), [pid(1)]);

  await correr(a.id, "REVERT", tienda.vista([0, 1]));
  assert.deepEqual(tienda.precio(1), ORIGEN);
  assert.deepEqual(tienda.precio(2), { price: 70, compareAtPrice: 100 }, "pausar A no toca lo de B");
  await correr(b.id, "REVERT", tienda.vista([1, 2, 3]));
  for (const i of [0, 1, 2, 3]) assert.deepEqual(tienda.precio(i), ORIGEN);
});

test("🔴 REACTIVAR una campaña cuyo producto tomó otra mientras estaba pausada: lo suelta y no pisa nada", async () => {
  const tienda = crearTienda(3);
  const a = await pct("A", 10);
  const b = await pct("B", 30);
  await correr(a.id, "APPLY", tienda.vista([0, 1]));
  await correr(a.id, "REVERT", tienda.vista([0, 1]));
  await correr(b.id, "APPLY", tienda.vista([1, 2])); // B toma el 1 con A pausada: legítimo

  await correr(a.id, "REACTIVATE", tienda.vista([0, 1]));
  assert.deepEqual(tienda.precio(0), { price: 90, compareAtPrice: 100 }, "A vuelve a su producto libre");
  assert.deepEqual(tienda.precio(1), { price: 70, compareAtPrice: 100 }, "🔴 el 1 sigue con el precio de B");
  assert.deepEqual(await productosDe(a.id), [pid(0)], "A soltó el producto que ya no es suyo");
  const reporte = await solapes(a.id);
  assert.equal(reporte?.total, 1);
  assert.equal(reporte?.products[0].id, pid(1));
  assert.equal(reporte?.products[0].campaignName, b.name);

  // Pausar A ya no puede devolver el 1 a su original por encima de B.
  await correr(a.id, "REVERT", tienda.vista([0, 1]));
  assert.deepEqual(tienda.precio(1), { price: 70, compareAtPrice: 100 });
  await correr(b.id, "REVERT", tienda.vista([1, 2]));
  for (const i of [0, 1, 2]) assert.deepEqual(tienda.precio(i), ORIGEN);
});

test("🔴 ELIMINAR una campaña pausada no le pisa el descuento a la que hoy tiene el producto", async () => {
  const tienda = crearTienda(2);
  const a = await pct("A", 10);
  const b = await pct("B", 30);
  await correr(a.id, "APPLY", tienda.vista([0, 1]));
  await correr(a.id, "REVERT", tienda.vista([0, 1]));
  await correr(b.id, "APPLY", tienda.vista([1]));

  // DELETE revierte antes de borrar. El 0 (de nadie) se restaura; el 1 es de B.
  const { job } = await createJob({ campaignId: a.id, shopId: SHOP_ID, operation: "DELETE" });
  await runJobBatch(job.id, { deadlineMs: 45_000, getAdmin: async () => tienda.vista([0, 1]), dispatchNext: async () => {} });
  assert.equal(await prisma.campaign.findUnique({ where: { id: a.id } }), null, "la campaña se borró");
  assert.deepEqual(tienda.precio(0), ORIGEN);
  assert.deepEqual(tienda.precio(1), { price: 70, compareAtPrice: 100 }, "🔴 el descuento de B sigue puesto");

  await correr(b.id, "REVERT", tienda.vista([1]));
  assert.deepEqual(tienda.precio(1), ORIGEN);
});

// ═══ Solapes que ya existían antes del arreglo ════════════════════════════════

/** Deja la base y la tienda como las dejaba el código anterior al apilar B sobre A. */
async function solapeHeredado() {
  const tienda = crearTienda(1);
  const a = await pct("A vieja", 10);
  const b = await pct("B vieja", 30);
  const t0 = new Date(Date.now() - 60_000);
  const t1 = new Date(Date.now() - 30_000);
  for (let v = 0; v < VARIANTES; v++) {
    await prisma.campaignProduct.create({
      data: { campaignId: a.id, shopifyProductId: pid(0), shopifyVariantId: vid(0, v), originalPrice: "100.00", originalCompareAtPrice: null, createdAt: t0 },
    });
    // B guardó como «original» el precio que había dejado A: 90 con 100 tachado.
    await prisma.campaignProduct.create({
      data: { campaignId: b.id, shopifyProductId: pid(0), shopifyVariantId: vid(0, v), originalPrice: "90.00", originalCompareAtPrice: "100.00", createdAt: t1 },
    });
  }
  await prisma.campaign.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { status: "ACTIVE" } });
  tienda.poner(0, { price: "63.00", compareAtPrice: "90.00" });
  return { tienda, admin: tienda.vista([0]), a, b };
}

test("🔴 solape HEREDADO, pausando primero la más vieja (el orden que rompía): termina en el precio real", async () => {
  const { tienda, admin, a, b } = await solapeHeredado();

  await correr(a.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN);
  // B heredó el original bueno: ya no guarda el precio rebajado por A.
  const filasB = await prisma.campaignProduct.findMany({ where: { campaignId: b.id } });
  for (const f of filasB) {
    assert.equal(Number(f.originalPrice), 100);
    assert.equal(f.originalCompareAtPrice, null);
  }

  await correr(b.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN, "🔴 antes quedaba en $90 con $100 tachado");
});

test("solape HEREDADO, pausando primero la más nueva: igual que antes, termina en el precio real", async () => {
  const { tienda, admin, a, b } = await solapeHeredado();
  await correr(b.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), { price: 90, compareAtPrice: 100 });
  const filasA = await prisma.campaignProduct.findMany({ where: { campaignId: a.id } });
  for (const f of filasA) assert.equal(Number(f.originalPrice), 100, "el original de A no se toca");
  await correr(a.id, "REVERT", admin);
  assert.deepEqual(tienda.precio(0), ORIGEN);
});

// ═══ Carrera ══════════════════════════════════════════════════════════════════

test("🔴 dos campañas que arrancan A LA VEZ sobre el mismo catálogo: cada variante queda en UNA sola", async () => {
  const PRODUCTOS = 12;
  const tienda = crearTienda(PRODUCTOS);
  const todos = Array.from({ length: PRODUCTOS }, (_, i) => i);
  const a = await pct("simultánea A", 10);
  const b = await pct("simultánea B", 30);

  await Promise.all([correr(a.id, "APPLY", tienda.vista(todos)), correr(b.id, "APPLY", tienda.vista(todos))]);

  const filas = await prisma.campaignProduct.findMany({
    where: { campaignId: { in: [a.id, b.id] } },
    select: { shopifyVariantId: true },
  });
  const ids = filas.map((f) => f.shopifyVariantId);
  assert.equal(new Set(ids).size, ids.length, "ninguna variante puede estar en las dos campañas");
  assert.equal(ids.length, PRODUCTOS * VARIANTES, "y ninguna se queda sin campaña");

  await Promise.all([correr(a.id, "REVERT", tienda.vista(todos)), correr(b.id, "REVERT", tienda.vista(todos))]);
  for (const i of todos) assert.deepEqual(tienda.precio(i), ORIGEN);
});

// ═══ Las piezas que comparte el camino síncrono ═══════════════════════════════
//
// percentage.ts y range.ts (editar Rango, y todo con la barra apagada) no se
// pueden cargar con el runner de Node, pero llaman a estas mismas tres funciones.

test("findHolders: activa = tomada · pausada = libre · con operación en curso = tomada · otra tienda = no cuenta", async () => {
  const yo = await pct("yo", 10);
  const activa = await pct("activa", 10);
  const pausada = await pct("pausada", 10);
  const enCurso = await pct("en curso", 10);
  const fila = (campaignId: string, i: number) =>
    prisma.campaignProduct.create({
      data: { campaignId, shopifyProductId: pid(i), shopifyVariantId: vid(i, 0), originalPrice: "100.00" },
    });
  await fila(activa.id, 0);
  await fila(pausada.id, 1);
  await fila(enCurso.id, 2);
  await fila(yo.id, 3);
  await prisma.campaign.update({ where: { id: activa.id }, data: { status: "ACTIVE" } });
  await prisma.campaign.update({ where: { id: pausada.id }, data: { status: "PAUSED" } });
  await createJob({ campaignId: enCurso.id, shopId: SHOP_ID, operation: "APPLY", payload: { selection: { selectionMode: "all" } } });

  const tomadas = await findHolders(prisma, {
    shopId: SHOP_ID,
    campaignId: yo.id,
    variantIds: [vid(0, 0), vid(1, 0), vid(2, 0), vid(3, 0), vid(9, 0)],
  });
  assert.deepEqual([...tomadas.keys()].sort(), [vid(0, 0), vid(2, 0)]);
  assert.equal(tomadas.get(vid(0, 0))?.[0].campaignName, activa.name);

  const desdeOtraTienda = await findHolders(prisma, {
    shopId: "otra-tienda-que-no-existe",
    campaignId: yo.id,
    variantIds: [vid(0, 0)],
  });
  assert.equal(desdeOtraTienda.size, 0);
});

test("releaseHeldRows y buildRevertPlanFor: lo que usa el camino síncrono al reactivar y al pausar", async () => {
  const a = await pct("A", 10);
  const b = await pct("B", 30);
  const fila = (campaignId: string, i: number) =>
    prisma.campaignProduct.create({
      data: { campaignId, shopifyProductId: pid(i), shopifyVariantId: vid(i, 0), originalPrice: "100.00" },
    });
  await fila(a.id, 0);
  await fila(a.id, 1);
  await fila(b.id, 1);
  await prisma.campaign.update({ where: { id: a.id }, data: { status: "PAUSED" } });
  await prisma.campaign.update({ where: { id: b.id }, data: { status: "ACTIVE" } });

  // Eliminar A (pausada): el 0 se restaura, el 1 —de B— no se toca.
  const filasA = await prisma.campaignProduct.findMany({ where: { campaignId: a.id } });
  const plan = await buildRevertPlanFor(a.id, filasA);
  assert.equal(plan.writes(vid(0, 0)), true);
  assert.equal(plan.writes(vid(1, 0)), false);

  // Reactivar A: suelta el 1 y lo informa por producto.
  const sueltos = await releaseHeldRows(SHOP_ID, a.id);
  assert.deepEqual(sueltos, [{ id: pid(1), title: null, variants: 1, campaignName: b.name }]);
  assert.deepEqual(await productosDe(a.id), [pid(0)]);
  assert.equal((await prisma.campaignProduct.count({ where: { campaignId: b.id } })), 1, "las filas de B no se tocan");
});

test("el reporte de solapes no borra el de descuentos manuales (y al revés)", async () => {
  const tienda = crearTienda(3);
  // El 2 tiene un descuento puesto a mano; el 0 lo tiene otra campaña.
  tienda.poner(2, { price: "80.00", compareAtPrice: "100.00" });
  const a = await pct("A", 10);
  await correr(a.id, "APPLY", tienda.vista([0]));
  const b = await campaña("B salta manuales", { discountPercent: 30, showCompareAtPrice: false, skipManualDiscounts: true });
  await correr(b.id, "APPLY", tienda.vista([0, 1, 2]));

  assert.deepEqual(await productosDe(b.id), [pid(1)]);
  const crudo = (await prisma.campaign.findUnique({ where: { id: b.id } }))?.skipReport;
  assert.deepEqual(readSkipReport(crudo)?.products.map((p) => p.id), [pid(2)]);
  assert.deepEqual(readOverlapReport(crudo)?.products.map((p) => p.id), [pid(0)]);
  assert.deepEqual(tienda.precio(0), { price: 90, compareAtPrice: 100 });
  assert.deepEqual(tienda.precio(2), { price: 80, compareAtPrice: 100 });
});
