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
    runJobBatch(job.id, { deadlineMs: 45_000, dispatchNext: async () => {} }),
    runJobBatch(job.id, { deadlineMs: 45_000, dispatchNext: async () => {} }),
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

  assert.equal(await requestCancel(job.id, SHOP_ID), true, "la cancelación se acepta");
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
    await runJobBatch(job.id, { deadlineMs: 45_000, dispatchNext: async () => {} });
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
