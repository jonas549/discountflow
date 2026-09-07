// Batería del motor de jobs contra PostgreSQL REAL (branch `dev` de Neon).
//
//   npm run test:jobs
//
// ¿Por qué no se falsea Prisma? Porque cuatro de las garantías que hay que demostrar
// —cerrojo de campaña, lease entre dos workers, recuperación de zombis, reanudación
// exacta— NO son lógica de JavaScript: son semántica de PostgreSQL (UPDATE
// condicional que bloquea la fila y re-evalúa su WHERE, índices únicos,
// transacciones). Contra un doble pasarían siempre sin demostrar nada.
//
// ─────────────────────────────────────────────────────────────────────────────
//  🔒 AISLAMIENTO — las tres condiciones innegociables
//     1. Todo cuelga de UNA tienda de prueba con dominio .myshopify.test, que no
//        es un dominio válido de Shopify y por tanto no puede existir de verdad.
//     2. Antes de tocar nada se comprueba que ese shopId no coincide con ninguna
//        tienda real. Si coincidiera, se aborta sin escribir.
//     3. Ni un DELETE sin WHERE, ni un TRUNCATE. Todo borrado va acotado por
//        shopId, y el teardown se ejecuta SIEMPRE, incluso si un test revienta.
// ─────────────────────────────────────────────────────────────────────────────

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import prisma from "../../db.server.ts";
import { LEASE_STALE_MS, MAX_ATTEMPTS } from "./constants.ts";
import { isTerminal, type JobStatus } from "./job-state.ts";
import {
  claimJob,
  createJob,
  findStalledJobs,
  finishJob,
  getJob,
  requestCancel,
} from "./jobs.server.ts";
import { runJobBatch, type BatchOutcome } from "./runner.server.ts";
import { createFakeAdmin } from "../shopify/fake-admin.ts";

const TEST_DOMAIN = "jobs-test.myshopify.test";
const E2E_UNITS = Number(process.env.JOBS_TEST_UNITS ?? 20_000);

/**
 * ✂️ Unidades por lote en los tests que necesitan CORTAR el trabajo a mitad.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 🔴 SE CORTA POR CANTIDAD, NO POR TIEMPO. No lo cambies a un plazo corto: ya se
 *    intentó dos veces y falló las dos.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * La primera versión cortaba con `deadlineMs: 120`, elegido pensando en la
 * latencia de PRODUCCIÓN: allí las funciones corren en Vercel `iad1` y Neon está
 * en `us-east-1` —la misma región de AWS— así que un viaje a la base son ~1-3 ms.
 *
 * Pero estos tests NO corren en producción, sino en la máquina de desarrollo, a un
 * océano de us-east-1. Medido el 2026-08-07:
 *
 *     RTT simple a Neon: mediana 69 ms · min 68 ms · max 71 ms
 *
 * Entre 20 y 60 veces más lento. Con 120 ms cabe UN viaje, y se lo come el
 * `createMany` de la fase de resolución: el lote expira sin procesar una sola
 * unidad y el test falla con «progreso intermedio: 0» — no porque el motor esté
 * roto, sino porque nunca llegó a haber un "mitad" que matar. Se subió a 1.200 ms
 * y siguió fallando por lo mismo: con 400-600 filas, la resolución tarda ~1,3 s.
 *
 * La conclusión no es "hace falta un número mayor", es que **el tiempo es la
 * palanca equivocada**: un test que pasa o falla según desde qué ciudad lo corras
 * no prueba nada. Cortar por unidades es determinista y da igual la latencia.
 *
 * Con 400 unidades y lotes de 40, los cortes al 10 %, 50 % y 90 % caen siempre en
 * los lotes 1, 5 y 9, aquí y en cualquier máquina.
 *
 * (En producción manda el plazo: `MAX_PRODUCTS_PER_BATCH = 300` es solo una red de
 * seguridad y `DEADLINE_MS = 45.000` es quien decide el tamaño real del lote.)
 */
const CORTE_UNIDADES = 40;

let SHOP_ID = "";

// ─── Preparación y aislamiento ────────────────────────────────────────────────

before(async () => {
  // Condición 1: el dominio no puede ser el de una tienda real. Shopify solo emite
  // dominios .myshopify.com; .myshopify.test es inalcanzable por construcción.
  assert.ok(
    !TEST_DOMAIN.endsWith(".myshopify.com"),
    "ABORTADO: el dominio de prueba parece un dominio real de Shopify"
  );

  const shop = await prisma.shop.upsert({
    where: { domain: TEST_DOMAIN },
    create: {
      domain: TEST_DOMAIN,
      accessToken: "test-token-no-sirve-para-nada",
      currency: "CLP",
      plan: "FREE",
    },
    update: {},
  });
  SHOP_ID = shop.id;

  // Condición 2: comprobar que el shopId de prueba no coincide con ninguna tienda
  // real. Si coincidiera, abortar antes de escribir una sola fila más.
  const reales = await prisma.shop.findMany({
    where: { domain: { endsWith: ".myshopify.com" } },
    select: { id: true, domain: true },
  });
  const choque = reales.find((s) => s.id === SHOP_ID);
  assert.equal(
    choque,
    undefined,
    `ABORTADO: el shopId de prueba coincide con la tienda real ${choque?.domain}`
  );
  const recargada = await prisma.shop.findUnique({ where: { id: SHOP_ID } });
  assert.equal(
    recargada?.domain,
    TEST_DOMAIN,
    "ABORTADO: el shop de prueba no tiene el dominio esperado"
  );

  console.log(
    `[aislamiento] shop de prueba ${SHOP_ID} (${TEST_DOMAIN}) · ${reales.length} tienda(s) real(es) intactas`
  );
});

// Condición 3: el teardown corre SIEMPRE. `after` de node:test se ejecuta aunque
// los tests fallen. Todo va acotado por shopId — nunca un DELETE sin WHERE.
after(async () => {
  if (!SHOP_ID) return;
  const campañas = await prisma.campaign.deleteMany({ where: { shopId: SHOP_ID } });
  const tienda = await prisma.shop.deleteMany({
    where: { id: SHOP_ID, domain: TEST_DOMAIN },
  });
  console.log(
    `[limpieza] ${campañas.count} campaña(s) y ${tienda.count} tienda de prueba borradas`
  );
  await prisma.$disconnect();
});

// ─── Utilidades ───────────────────────────────────────────────────────────────

let seq = 0;
async function nuevaCampaña(nombre: string) {
  return prisma.campaign.create({
    data: {
      shopId: SHOP_ID,
      name: `[test] ${nombre} #${++seq}`,
      type: "PERCENTAGE",
      status: "DRAFT",
      config: {},
    },
  });
}

type DriveOpts = {
  deadlineMs?: number;
  /** Unidades por lote. Ver CORTE_UNIDADES: es la palanca de corte determinista. */
  maxProductsPerBatch?: number;
  maxBatches?: number;
  /** Corta el bucle cuando el progreso alcance esta fracción del total. */
  stopAtFraction?: number;
  /** Cliente Shopify. Por defecto uno inerte: NOOP no llama a Shopify. */
  admin?: { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> };
};

/** Cliente que revienta si alguien lo usa: NOOP no debe tocar Shopify jamás. */
const adminProhibido = {
  graphql: async () => {
    throw new Error("NOOP no debe llamar a Shopify");
  },
};

/**
 * Ejecuta lotes hasta que el job termina o se alcanza un corte.
 *
 * `dispatchNext` se inyecta como un contador: así el bucle del test hace de cadena
 * y se puede "matar" el proceso simplemente dejando de iterar, que es justo lo que
 * pasa cuando Vercel liquida una invocación.
 */
async function drive(jobId: string, opts: DriveOpts = {}) {
  const batches: BatchOutcome[] = [];
  let dispatches = 0;

  for (let i = 0; i < (opts.maxBatches ?? 500); i++) {
    const out = await runJobBatch(jobId, {
      deadlineMs: opts.deadlineMs ?? 45_000,
      ...(opts.maxProductsPerBatch !== undefined && {
        maxProductsPerBatch: opts.maxProductsPerBatch,
      }),
      getAdmin: async () => opts.admin ?? adminProhibido,
      dispatchNext: async () => {
        dispatches += 1;
      },
    });
    batches.push(out);
    if (!out.claimed || !out.chained) break;

    if (opts.stopAtFraction) {
      const job = await getJob(jobId, SHOP_ID);
      if (
        job &&
        job.totalProducts > 0 &&
        job.processedProducts / job.totalProducts >= opts.stopAtFraction
      )
        break;
    }
  }
  return { batches, dispatches };
}

/** Simula que el worker murió: el latido se vuelve rancio y el job queda huérfano. */
async function matarWorker(jobId: string) {
  await prisma.campaignJob.update({
    where: { id: jobId },
    data: { heartbeatAt: new Date(Date.now() - LEASE_STALE_MS - 5_000) },
  });
}

const sellados = (campaignId: string, jobId: string) =>
  prisma.campaignProduct.count({ where: { campaignId, processedByJobId: jobId } });

const sinSellar = (campaignId: string, jobId: string) =>
  prisma.campaignProduct.count({
    where: {
      campaignId,
      OR: [{ processedByJobId: null }, { processedByJobId: { not: jobId } }],
    },
  });

// ─── 1. Recorrido completo encadenando lotes ──────────────────────────────────

test(`recorrido completo de ${E2E_UNITS.toLocaleString("es-CL")} unidades encadenando lotes`, async () => {
  const campaign = await nuevaCampaña("e2e");
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "NOOP",
    payload: { totalUnits: E2E_UNITS, msPerUnit: 0, resolveChunk: 2_000 },
  });

  const t0 = Date.now();
  const { batches, dispatches } = await drive(job.id, { deadlineMs: 45_000 });
  const total = Date.now() - t0;

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "COMPLETED", `estado final: ${final?.status}`);
  assert.equal(final?.processedProducts, E2E_UNITS, "productos procesados");
  assert.equal(await sellados(campaign.id, job.id), E2E_UNITS, "filas selladas");
  assert.equal(await sinSellar(campaign.id, job.id), 0, "no queda nada sin sellar");

  // La suma de unidades por lote debe cuadrar EXACTAMENTE con el total: si alguna
  // unidad se hubiera procesado dos veces, esta suma se pasaría.
  const suma = batches.reduce((n, b) => n + b.unitsThisBatch, 0);
  assert.equal(suma, E2E_UNITS, "sin reprocesar ni saltarse unidades");

  assert.ok(batches.length > 1, `se esperaba más de un lote, hubo ${batches.length}`);
  assert.equal(dispatches, batches.length - 1, "un encadenado por lote no final");

  const peor = Math.max(...batches.map((b) => b.elapsedMs));
  assert.ok(peor < 90_000, `el peor lote tardó ${peor} ms (límite 90.000)`);

  console.log(
    `[e2e] ${E2E_UNITS} uds · ${batches.length} lotes · peor lote ${(peor / 1000).toFixed(1)} s · total ${(total / 1000).toFixed(1)} s`
  );
});

// ─── 2. Reanudación tras muerte al 10 %, 50 % y 90 % ──────────────────────────

for (const fraccion of [0.1, 0.5, 0.9]) {
  test(`matar el proceso al ${Math.round(fraccion * 100)} % y reanudar termina exacto`, async () => {
    const UNITS = 400;
    const campaign = await nuevaCampaña(`kill-${fraccion}`);
    const { job } = await createJob({
      campaignId: campaign.id,
      shopId: SHOP_ID,
      operation: "NOOP",
      payload: { totalUnits: UNITS, msPerUnit: 0, resolveChunk: 500 },
    });

    // Lotes de tamaño fijo para cortar en un punto exacto. Ver CORTE_UNIDADES.
    const primera = await drive(job.id, {
      maxProductsPerBatch: CORTE_UNIDADES,
      stopAtFraction: fraccion,
    });
    const medio = await getJob(job.id, SHOP_ID);
    assert.ok(medio, "el job existe");
    assert.equal(isTerminal(medio!.status as JobStatus), false, "aún no ha terminado");
    const hechoAntes = await sellados(campaign.id, job.id);
    assert.ok(hechoAntes > 0 && hechoAntes < UNITS, `progreso intermedio: ${hechoAntes}`);

    // 💀 El worker muere sin avisar.
    await matarWorker(job.id);

    // Otro worker lo recoge y lo termina.
    const segunda = await drive(job.id, { deadlineMs: 45_000 });

    const final = await getJob(job.id, SHOP_ID);
    assert.equal(final?.status, "COMPLETED", `estado final: ${final?.status}`);
    assert.equal(await sellados(campaign.id, job.id), UNITS, "todas las unidades selladas");
    assert.equal(await sinSellar(campaign.id, job.id), 0, "sin huecos");

    const suma =
      primera.batches.reduce((n, b) => n + b.unitsThisBatch, 0) +
      segunda.batches.reduce((n, b) => n + b.unitsThisBatch, 0);
    assert.equal(suma, UNITS, "ninguna unidad se procesó dos veces");

    console.log(
      `[kill ${Math.round(fraccion * 100)}%] cortado en ${hechoAntes}/${UNITS} · reanudado y completado sin solapes`
    );
  });
}

// ─── 3. Idempotencia: diez disparos simultáneos ───────────────────────────────

test("diez disparos simultáneos de la misma operación crean UN solo job", async () => {
  const campaign = await nuevaCampaña("doble-clic");

  const resultados = await Promise.all(
    Array.from({ length: 10 }, () =>
      createJob({
        campaignId: campaign.id,
        shopId: SHOP_ID,
        operation: "NOOP",
        payload: { totalUnits: 10, msPerUnit: 0 },
      })
    )
  );

  const ids = new Set(resultados.map((r) => r.job.id));
  assert.equal(ids.size, 1, `se crearon ${ids.size} jobs distintos`);
  assert.equal(
    resultados.filter((r) => r.created).length,
    1,
    "solo uno debe reportar created:true"
  );

  const enBd = await prisma.campaignJob.count({ where: { campaignId: campaign.id } });
  assert.equal(enBd, 1, `hay ${enBd} filas de job en la BD`);

  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.activeJobId, [...ids][0], "el cerrojo apunta al job ganador");

  console.log(`[idempotencia] 10 disparos -> 1 job (${[...ids][0]})`);

  // Este test crea un job y NO lo ejecuta: comprobar la idempotencia no requiere
  // trabajo. Pero entonces la campaña queda legítimamente bloqueada —hay una
  // operación pendiente—, y eso rompería la invariante final de la batería. Se
  // cierra aquí, lo que de paso comprueba que cancelar un job QUEUED que nunca
  // llegó a arrancar lo termina en el acto y suelta el cerrojo.
  assert.equal(await requestCancel([...ids][0], SHOP_ID), true);
  const tras = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(tras?.activeJobId, null, "cancelar un QUEUED suelta el cerrojo");
});

// ─── 4. Zombi: detectado y recuperado ─────────────────────────────────────────

test("un job congelado se detecta como zombi por el umbral y se recupera", async () => {
  const campaign = await nuevaCampaña("zombi");
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "NOOP",
    payload: { totalUnits: 40, msPerUnit: 0 },
  });

  const primero = await claimJob(job.id);
  assert.equal(primero.ok, true, "el primer worker toma el job");

  // Vivo: nadie más puede tocarlo y no figura como colgado.
  assert.equal((await claimJob(job.id)).ok, false, "un job vivo no es reclamable");
  assert.equal(
    (await findStalledJobs({ shopId: SHOP_ID })).some((j) => j.id === job.id),
    false,
    "un job vivo no aparece como colgado"
  );

  // 💀 Se congela.
  await matarWorker(job.id);

  const colgados = await findStalledJobs({ shopId: SHOP_ID });
  assert.ok(
    colgados.some((j) => j.id === job.id),
    "el job congelado debe aparecer como colgado"
  );

  const { batches } = await drive(job.id, { deadlineMs: 45_000 });
  assert.ok(batches[0].claimed, "el nuevo worker pudo reclamarlo");

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "COMPLETED");
  assert.equal(await sellados(campaign.id, job.id), 40);

  console.log(`[zombi] detectado con umbral de ${LEASE_STALE_MS / 1000} s y recuperado hasta COMPLETED`);
});

// ─── 5. Dos workers a la vez: el lease los serializa ──────────────────────────

test("dos workers sobre el mismo job: solo uno avanza", async () => {
  const campaign = await nuevaCampaña("dos-workers");
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "NOOP",
    payload: { totalUnits: 120, msPerUnit: 3 },
  });

  const [a, b] = await Promise.all([
    runJobBatch(job.id, {
      deadlineMs: 45_000,
      getAdmin: async () => adminProhibido,
      dispatchNext: async () => {},
    }),
    runJobBatch(job.id, {
      deadlineMs: 45_000,
      getAdmin: async () => adminProhibido,
      dispatchNext: async () => {},
    }),
  ]);

  const avanzaron = [a, b].filter((r) => r.unitsThisBatch > 0);
  assert.equal(avanzaron.length, 1, "exactamente un worker debe hacer trabajo");
  const rechazado = [a, b].find((r) => r.unitsThisBatch === 0);
  assert.equal(rechazado?.reason, "busy", "el otro debe retirarse por 'busy'");

  // Y el resultado no está corrompido: el total sellado nunca pasa del total.
  const hechas = await sellados(campaign.id, job.id);
  assert.ok(hechas <= 120, `se sellaron ${hechas} de 120`);

  console.log(`[lease] 2 workers simultáneos -> 1 trabajó, el otro se retiró (busy)`);
});

// ─── 6. Cancelación ───────────────────────────────────────────────────────────

test("cancelar a mitad deja CANCELLED y suelta el cerrojo de la campaña", async () => {
  const campaign = await nuevaCampaña("cancelar");
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "NOOP",
    payload: { totalUnits: 600, msPerUnit: 0, resolveChunk: 600 },
  });

  // Un primer lote acotado para que haya progreso real antes de cancelar.
  await drive(job.id, { maxProductsPerBatch: CORTE_UNIDADES, maxBatches: 1 });
  const parcial = await sellados(campaign.id, job.id);
  assert.ok(parcial > 0 && parcial < 600, `progreso parcial: ${parcial}`);

  assert.equal(
    (await requestCancel(job.id, SHOP_ID)).cancelled,
    true,
    "la cancelación se acepta"
  );
  await matarWorker(job.id); // el worker anterior ya no está
  await drive(job.id, { deadlineMs: 45_000 });

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "CANCELLED", `estado final: ${final?.status}`);

  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.activeJobId, null, "el cerrojo debe quedar suelto");

  console.log(`[cancelar] cortado en ${parcial}/600 -> CANCELLED y cerrojo liberado`);
});

// ─── 7. Freno de intentos ─────────────────────────────────────────────────────

test(`un job que revienta siempre en el mismo punto para en attempts=${MAX_ATTEMPTS}`, async () => {
  const campaign = await nuevaCampaña("veneno");
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "NOOP",
    // Revienta en cuanto haya 8 unidades selladas, siempre en el mismo punto.
    payload: { totalUnits: 100, msPerUnit: 0, failAtUnit: 8, resolveChunk: 100 },
  });

  for (let i = 0; i < MAX_ATTEMPTS + 4; i++) {
    await runJobBatch(job.id, {
      deadlineMs: 45_000,
      getAdmin: async () => adminProhibido,
      dispatchNext: async () => {},
    });
    await matarWorker(job.id); // cada reintento llega como worker nuevo
    const j = await getJob(job.id, SHOP_ID);
    if (j && isTerminal(j.status as JobStatus)) break;
  }

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "FAILED", `estado final: ${final?.status}`);
  assert.ok(
    (final?.attempts ?? 0) >= MAX_ATTEMPTS,
    `attempts=${final?.attempts}, se esperaba >= ${MAX_ATTEMPTS}`
  );
  assert.match(String(final?.lastError ?? ""), /interrumpió|indefinidamente/i);

  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.activeJobId, null, "un job muerto no puede dejar la campaña bloqueada");

  console.log(
    `[freno] el job murió en attempts=${final?.attempts} sin re-patearse indefinidamente`
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WORKERS REALES — contra el cliente Shopify falso, con volumen
//
//  Aquí no hay simulacro: se ejecutan APPLY, REVERT, REACTIVATE y DELETE de
//  verdad, con toda su lógica de precios, contra un catálogo sintético de 1.000
//  productos × 5 variantes = 5.000 variantes. El cliente falso permite además
//  provocar a voluntad lo que en una tienda real es imposible reproducir: un
//  THROTTLED en la mutación 47, un userError en la 300, o matar el proceso justo
//  a la mitad.
// ═══════════════════════════════════════════════════════════════════════════════

const CAT_PRODUCTOS = 1_000;
const CAT_VARIANTES = 5;
const TOTAL_VARIANTES = CAT_PRODUCTOS * CAT_VARIANTES; // 5.000
const PCT = 20;

async function campañaPorcentaje(nombre: string, status = "DRAFT") {
  return prisma.campaign.create({
    data: {
      shopId: SHOP_ID,
      name: `[test] ${nombre} #${++seq}`,
      type: "PERCENTAGE",
      status: status as "DRAFT",
      config: { discountPercent: PCT, showCompareAtPrice: false },
    },
  });
}

const catalogo = (b: Parameters<typeof createFakeAdmin>[1] = {}) =>
  createFakeAdmin(
    { products: CAT_PRODUCTOS, variantsPerProduct: CAT_VARIANTES, basePrice: 100 },
    b
  );

const applyPayload = (max?: number) => ({
  selection: { selectionMode: "all" as const },
  ...(max !== undefined ? { maxVariants: max } : {}),
});

test(`APPLY real sobre ${TOTAL_VARIANTES.toLocaleString("es-CL")} variantes: precios correctos y una mutación por producto`, async () => {
  const campaign = await campañaPorcentaje("apply-grande");
  const admin = catalogo();
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "APPLY",
    payload: applyPayload(),
  });

  const t0 = Date.now();
  const { batches } = await drive(job.id, { deadlineMs: 45_000, admin });
  const total = Date.now() - t0;

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "COMPLETED", `estado: ${final?.status} · ${final?.lastError}`);

  // Se crearon las filas de trabajo con los precios originales dentro.
  assert.equal(
    await prisma.campaignProduct.count({ where: { campaignId: campaign.id } }),
    TOTAL_VARIANTES,
    "filas de CampaignProduct creadas"
  );
  assert.equal(await sellados(campaign.id, job.id), TOTAL_VARIANTES, "todas selladas");
  assert.equal(await sinSellar(campaign.id, job.id), 0, "sin huecos");

  // UNA mutación por producto, ni una de más: es la garantía de que no se
  // reprocesó nada entre lotes.
  assert.equal(admin.mutationCalls.length, CAT_PRODUCTOS, "mutaciones a Shopify");
  const tocados = new Set(admin.mutationCalls.map((m) => m.productId));
  assert.equal(tocados.size, CAT_PRODUCTOS, "productos distintos tocados");

  // Y el precio es el correcto: producto i vale 100+i, con 20 % queda en 0,8×.
  const primera = admin.mutationCalls.find(
    (m) => m.productId === "gid://shopify/Product/0"
  );
  assert.ok(primera, "se mutó el producto 0");
  assert.equal(primera!.prices[0].price, "80.00", "100.00 con 20% -> 80.00");
  assert.equal(primera!.prices[0].compareAtPrice, "100.00", "precio tachado");

  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.status, "ACTIVE", "la campaña pasa a ACTIVE solo al terminar");
  assert.equal(c?.activeJobId, null, "cerrojo liberado");

  const peor = Math.max(...batches.map((b) => b.elapsedMs));
  assert.ok(peor < 90_000, `peor lote ${peor} ms`);
  console.log(
    `[apply real] ${TOTAL_VARIANTES} variantes · ${CAT_PRODUCTOS} mutaciones · ${batches.length} lotes · peor lote ${(peor / 1000).toFixed(1)} s · total ${(total / 1000).toFixed(1)} s`
  );
});

test("APPLY interrumpido a mitad: al reanudar no repite ni una sola mutación", async () => {
  const campaign = await campañaPorcentaje("apply-interrumpido");
  const admin = catalogo();
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "APPLY",
    payload: applyPayload(),
  });

  await drive(job.id, { maxProductsPerBatch: 120, stopAtFraction: 0.4, admin });
  const aMitad = admin.mutationCalls.length;
  assert.ok(aMitad > 0 && aMitad < CAT_PRODUCTOS, `mutaciones a mitad: ${aMitad}`);

  await matarWorker(job.id); // 💀
  await drive(job.id, { deadlineMs: 45_000, admin });

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "COMPLETED", `estado: ${final?.status}`);
  assert.equal(await sinSellar(campaign.id, job.id), 0, "sin huecos");

  // Lo que de verdad importa: el TOTAL de mutaciones sigue siendo una por
  // producto. Si la reanudación repitiera trabajo, este número se pasaría.
  assert.equal(
    admin.mutationCalls.length,
    CAT_PRODUCTOS,
    `se esperaban ${CAT_PRODUCTOS} mutaciones y hubo ${admin.mutationCalls.length}`
  );
  console.log(
    `[apply interrumpido] cortado tras ${aMitad} mutaciones · total final ${admin.mutationCalls.length} (esperado ${CAT_PRODUCTOS})`
  );
});

test("APPLY que excede la cuota del plan muere SIN tocar un solo precio", async () => {
  const campaign = await campañaPorcentaje("apply-limite");
  const admin = catalogo();
  const { job } = await createJob({
    campaignId: campaign.id,
    shopId: SHOP_ID,
    operation: "APPLY",
    payload: applyPayload(50), // plan FREE: 50 variantes
  });

  await drive(job.id, { deadlineMs: 45_000, admin });

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "FAILED", `estado: ${final?.status}`);
  assert.match(String(final?.lastError), /plan admite/i);

  // 🔴 La garantía que importa: cero mutaciones. El límite salta durante la
  // RESOLUCIÓN, antes de la primera escritura en Shopify.
  assert.equal(admin.mutationCalls.length, 0, "no se tocó ningún precio");

  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.status, "DRAFT", "la campaña se queda en borrador, no activa");
  assert.equal(c?.activeJobId, null, "cerrojo liberado");
  console.log(`[apply límite] FAILED sin mutaciones · campaña en DRAFT`);
});

test("REVERT devuelve exactamente los precios originales", async () => {
  const campaign = await campañaPorcentaje("revert");
  const admin = catalogo();

  const { job: apply } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });
  await drive(apply.id, { deadlineMs: 45_000, admin });
  const trasApply = admin.mutationCalls.length;

  const { job: revert } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "REVERT",
  });
  await drive(revert.id, { deadlineMs: 45_000, admin });

  const final = await getJob(revert.id, SHOP_ID);
  assert.equal(final?.status, "COMPLETED", `estado: ${final?.status}`);
  assert.equal(
    admin.mutationCalls.length - trasApply,
    CAT_PRODUCTOS,
    "una mutación de revert por producto"
  );

  // El precio del producto 0 vuelve a ser 100.00 y su tachado desaparece.
  const ultima = [...admin.mutationCalls]
    .reverse()
    .find((m) => m.productId === "gid://shopify/Product/0");
  assert.equal(ultima?.prices[0].price, "100", "precio original restaurado");
  assert.equal(ultima?.prices[0].compareAtPrice, null, "sin precio tachado");

  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.status, "PAUSED", "la campaña queda pausada");
  console.log(`[revert] ${CAT_PRODUCTOS} productos devueltos a su precio original`);
});

test("cancelar un APPLY encola SOLO el revert de lo ya aplicado", async () => {
  const campaign = await campañaPorcentaje("cancel-compensa");
  const admin = catalogo();
  const { job } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });

  await drive(job.id, { maxProductsPerBatch: 100, maxBatches: 1, admin });
  const aplicados = admin.mutationCalls.length;
  assert.ok(aplicados > 0 && aplicados < CAT_PRODUCTOS, `aplicados: ${aplicados}`);

  // Entre lote y lote el job está en QUEUED, así que la cancelación se resuelve
  // en el acto y es AHÍ donde tiene que nacer el revert compensatorio.
  const cancel = await requestCancel(job.id, SHOP_ID);
  assert.equal(cancel.cancelled, true, "la cancelación se acepta");
  assert.equal((await getJob(job.id, SHOP_ID))?.status, "CANCELLED");

  assert.ok(
    cancel.compensatingJobId,
    "cancelar un APPLY con precios ya tocados debe crear un REVERT compensatorio"
  );
  const compensatorio = await getJob(cancel.compensatingJobId!, SHOP_ID);
  assert.ok(compensatorio, "el revert compensatorio existe");

  const antes = admin.mutationCalls.length;
  await drive(compensatorio!.id, { deadlineMs: 45_000, admin });
  const deshechos = admin.mutationCalls.length - antes;

  assert.equal((await getJob(compensatorio!.id, SHOP_ID))?.status, "COMPLETED");
  // Solo lo aplicado, NO el catálogo entero: esa es la razón de `onlyStampedBy`.
  assert.equal(deshechos, aplicados, `deshechos ${deshechos}, aplicados ${aplicados}`);
  console.log(
    `[cancelar APPLY] ${aplicados} productos aplicados -> revert compensatorio deshizo exactamente ${deshechos}`
  );
});

test("APPLY tolera fallos por producto y acaba COMPLETED_WITH_ERRORS", async () => {
  const campaign = await campañaPorcentaje("apply-con-fallos");
  // Un throttle (que el backoff absorbe) y dos rechazos duros de Shopify.
  const admin = catalogo({ throttleAtCalls: [7], userErrorAtCalls: [20, 400] });
  const { job } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });

  await drive(job.id, { deadlineMs: 45_000, admin });

  const final = await getJob(job.id, SHOP_ID);
  assert.equal(final?.status, "COMPLETED_WITH_ERRORS", `estado: ${final?.status}`);
  assert.equal(final?.errorCount, 2, `errores contados: ${final?.errorCount}`);
  // Un producto que falla también se sella: si no, `remaining` nunca llegaría a
  // cero y el job daría vueltas hasta agotar sus intentos.
  assert.equal(await sinSellar(campaign.id, job.id), 0, "ningún producto bloquea el final");
  console.log(
    `[apply con fallos] 1 throttle absorbido por el backoff + 2 rechazos -> COMPLETED_WITH_ERRORS`
  );
});

test("DELETE revierte los precios y luego borra la campaña", async () => {
  const campaign = await campañaPorcentaje("delete");
  const admin = catalogo();
  const { job: apply } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });
  await drive(apply.id, { deadlineMs: 45_000, admin });
  const trasApply = admin.mutationCalls.length;

  const { job: del } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "DELETE",
  });
  await drive(del.id, { deadlineMs: 45_000, admin });

  assert.equal(
    admin.mutationCalls.length - trasApply,
    CAT_PRODUCTOS,
    "revierte antes de borrar"
  );
  assert.equal(
    await prisma.campaign.count({ where: { id: campaign.id } }),
    0,
    "la campaña ya no existe"
  );
  console.log(`[delete] ${CAT_PRODUCTOS} productos revertidos y campaña borrada`);
});

// ─── 7-BIS. Productos y variantes borrados de la tienda ───────────────────────
//
//  🔴 Catálogo CHICO a propósito, y no es un atajo.
//
//  Lo que estos cuatro tests demuestran —que un producto inexistente se saltea,
//  que una variante muerta no arrastra a sus hermanas, que el bucle está cortado
//  y que una comprobación fallida NO saltea— no depende del tamaño del catálogo:
//  cada aserción mira UN producto concreto. Con los 1.000 del bloque anterior
//  cada test cuesta ~6 min contra Neon (medido: un APPLY de 5.000 variantes son
//  383 s) y no prueban ni una cosa más.
//
//  El volumen y el encadenado de lotes ya los cubren los tests de arriba, que
//  siguen corriendo con el catálogo grande y que este cambio NO toca.

const CHICO_PRODUCTOS = 20;

const catalogoChico = (b: Parameters<typeof createFakeAdmin>[1] = {}) =>
  createFakeAdmin(
    { products: CHICO_PRODUCTOS, variantsPerProduct: CAT_VARIANTES, basePrice: 100 },
    b
  );
//
//  El caso real que bloqueó a un merchant (Greta, 2026-09-07): borró productos de
//  su catálogo y a partir de ahí NO PUDO PAUSAR sus campañas. Cada intento
//  terminaba con cientos de "incidencias" —310 sobre 2 unidades reales— porque el
//  lote daba vueltas sobre lo que fallaba hasta agotar el plazo, y una sola
//  variante borrada tumbaba la mutación del producto ENTERO, dejando a sus
//  hermanas vivas rebajadas con la campaña pausada.

test("🔴 REVERT con la MITAD del catálogo borrado: revierte el resto y PAUSA igual", async () => {
  const campaign = await campañaPorcentaje("revert-mitad-borrada");

  // Se aplica con el catálogo intacto…
  const admin = catalogoChico();
  const { job: apply } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });
  await drive(apply.id, { deadlineMs: 45_000, admin });
  assert.equal((await getJob(apply.id, SHOP_ID))?.status, "COMPLETED");

  // …y entre medias el merchant borra la mitad de los productos de su tienda.
  const borrados = Array.from({ length: CHICO_PRODUCTOS / 2 }, (_, i) => i * 2);
  const adminTrasBorrado = catalogoChico({ missingProductIndexes: borrados });

  const { job: revert } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "REVERT",
  });
  await drive(revert.id, { deadlineMs: 45_000, admin: adminTrasBorrado });

  const final = await getJob(revert.id, SHOP_ID);

  // 1. Lo que más importa: la campaña SE PAUSA.
  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.status, "PAUSED", "la campaña tiene que quedar pausada");
  assert.equal(c?.activeJobId, null, "cerrojo liberado");

  // 2. No es un fallo: un producto que ya no existe no tiene precio que revertir.
  assert.equal(final?.status, "COMPLETED", `estado: ${final?.status}`);
  assert.equal(final?.errorCount, 0, "los borrados NO son incidencias");
  assert.equal(final?.skippedCount, borrados.length, "se cuentan como salteados");

  // 3. Nada queda a medias: sin filas sin sellar, `remaining` llegó a cero.
  assert.equal(await sinSellar(campaign.id, revert.id), 0, "sin huecos");

  // 4. Los productos VIVOS sí volvieron a su precio original.
  const vivo = [...adminTrasBorrado.mutationCalls]
    .reverse()
    .find((m) => m.productId === "gid://shopify/Product/1");
  assert.equal(vivo?.prices[0].price, "101", "el producto vivo se revirtió");
  assert.equal(vivo?.prices[0].compareAtPrice, null, "sin precio tachado");

  console.log(
    `[borrados] ${borrados.length} productos salteados · ${CHICO_PRODUCTOS - borrados.length} revertidos · campaña PAUSED`
  );
});

test("🔴 una variante borrada NO tumba a sus hermanas vivas", async () => {
  const campaign = await campañaPorcentaje("variante-borrada");
  const admin = catalogoChico();
  const { job: apply } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });
  await drive(apply.id, { deadlineMs: 45_000, admin });

  // Del producto 3 desaparece UNA de sus cinco variantes. El producto sigue vivo.
  const muerta = "gid://shopify/ProductVariant/3-0";
  const adminTrasBorrado = catalogoChico({ missingVariantIds: [muerta] });

  const { job: revert } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "REVERT",
  });
  await drive(revert.id, { deadlineMs: 45_000, admin: adminTrasBorrado });

  const final = await getJob(revert.id, SHOP_ID);
  assert.equal(final?.status, "COMPLETED", `estado: ${final?.status}`);
  assert.equal(final?.errorCount, 0, "una variante borrada no es una incidencia");
  assert.equal(final?.skippedCount, 1, "se salteó exactamente una unidad");

  // 🔴 La aserción que sostiene todo: el reintento mandó las CUATRO hermanas.
  const delProducto3 = adminTrasBorrado.mutationCalls.filter(
    (m) => m.productId === "gid://shopify/Product/3"
  );
  const ultima = delProducto3.at(-1);
  assert.ok(ultima, "se reintentó el producto 3");
  assert.equal(ultima!.variantIds.length, CAT_VARIANTES - 1, "solo las variantes vivas");
  assert.ok(!ultima!.variantIds.includes(muerta), "la borrada no viaja en el reintento");
  assert.equal(ultima!.prices[0].price, "103", "las hermanas SÍ vuelven a su precio");

  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c?.status, "PAUSED", "la campaña queda pausada");
  console.log(
    `[variante borrada] producto 3: 1 variante fantasma salteada, ${CAT_VARIANTES - 1} hermanas revertidas`
  );
});

test("🔴 el bucle está muerto: un producto borrado recibe UNA mutación, no decenas", async () => {
  // Antes, la unidad fallida no se sellaba dentro del lote, `pendingUnits` la
  // devolvía otra vez y el lote giraba sobre ella hasta agotar los 45 s: así se
  // llegó a errorCount=310 sobre 2 unidades reales.
  const campaign = await campañaPorcentaje("sin-bucle");
  const admin = catalogoChico();
  const { job: apply } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });
  await drive(apply.id, { deadlineMs: 45_000, admin });

  const adminTrasBorrado = catalogoChico({ missingProductIndexes: [7] });
  const { job: revert } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "REVERT",
  });
  await drive(revert.id, { deadlineMs: 45_000, admin: adminTrasBorrado });

  const intentos = adminTrasBorrado.mutationCalls.filter(
    (m) => m.productId === "gid://shopify/Product/7"
  ).length;
  assert.equal(intentos, 1, `el producto borrado recibió ${intentos} mutaciones`);

  const final = await getJob(revert.id, SHOP_ID);
  assert.equal(final?.skippedCount, 1, "una unidad salteada, no una por vuelta");
  console.log(`[sin bucle] producto borrado: 1 intento y se saltea`);
});

test("🔴 si la comprobación de existencia falla, NO se saltea: es una incidencia", async () => {
  // La salvaguarda. Saltear ante una lectura que no se pudo hacer dejaría la
  // campaña pausada con precios rebajados vivos — el fallo caro, en la dirección
  // contraria. Ante la duda se anota como incidencia y no se da por revertido.
  const campaign = await campañaPorcentaje("comprobacion-falla");
  const admin = catalogoChico();
  const { job: apply } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "APPLY", payload: applyPayload(),
  });
  await drive(apply.id, { deadlineMs: 45_000, admin });

  const adminRoto = catalogoChico({ missingProductIndexes: [5], existsQueryFails: true });
  const { job: revert } = await createJob({
    campaignId: campaign.id, shopId: SHOP_ID, operation: "REVERT",
  });
  await drive(revert.id, { deadlineMs: 45_000, admin: adminRoto });

  const final = await getJob(revert.id, SHOP_ID);
  assert.equal(final?.skippedCount, 0, "no se saltea nada sin poder comprobarlo");
  assert.equal(final?.status, "COMPLETED_WITH_ERRORS", `estado: ${final?.status}`);

  // 🔴 EXACTAMENTE 2, y ese número es el arreglo del bucle en una aserción.
  //
  // La unidad falla, no se sella, y `pendingUnits` la devuelve una segunda vez.
  // En esa segunda pasada `ctx.job.errors` YA la contiene —porque el runner lo
  // refresca tras cada ola— así que `failedBefore` la reconoce y la sella. Fin.
  //
  // Antes de ese refresco, `ctx.job.errors` era la foto del inicio del lote y no
  // cambiaba nunca: la unidad no se sellaba jamás y el lote giraba sobre ella
  // hasta agotar los 45 s. Así se llegó a errorCount=310 sobre 2 unidades reales.
  // Si alguien deshace el refresco, este número se dispara y el test cae.
  assert.equal(final?.errorCount, 2, `intentos por unidad: ${final?.errorCount}`);
  assert.equal(await sinSellar(campaign.id, revert.id), 0, "se sella igual");
  console.log(
    `[salvaguarda] comprobación fallida -> incidencia (2 intentos, no 310), nunca salteo`
  );
});

// ─── 8. Invariante final ──────────────────────────────────────────────────────

test("al terminar la batería: cero campañas con el cerrojo puesto", async () => {
  const bloqueadas = await prisma.campaign.findMany({
    where: { shopId: SHOP_ID, activeJobId: { not: null } },
    select: { id: true, name: true, activeJobId: true },
  });
  assert.equal(
    bloqueadas.length,
    0,
    `campañas bloqueadas: ${JSON.stringify(bloqueadas)}`
  );

  const vivos = await prisma.campaignJob.findMany({
    where: { shopId: SHOP_ID, status: { in: ["QUEUED", "RESOLVING", "RUNNING", "CANCELLING"] } },
    select: { id: true, status: true },
  });
  assert.equal(vivos.length, 0, `jobs no terminales: ${JSON.stringify(vivos)}`);

  console.log(`[invariante] 0 campañas bloqueadas · 0 jobs colgados`);
});

// Silencia el aviso de import no usado de finishJob si algún día se retira su uso.
void finishJob;
