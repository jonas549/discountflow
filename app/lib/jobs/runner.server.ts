// El bucle de un lote: reclamar, trabajar hasta el plazo, guardar, encadenar.
//
// ⭐ Dos costuras hacen que todo esto sea probable sin desplegar nada:
//    - `dispatchNext` se INYECTA: en la ruta es un POST HTTPS a uno mismo; en los
//      tests, una llamada al siguiente lote. Así se ejercita el encadenado real,
//      incluido que cada invocación tiene su propio plazo, sin levantar un HTTP.
//    - `getAdmin` se INYECTA: en la ruta es `unauthenticated.admin`; en los tests
//      es el cliente falso, que sirve catálogos de 20.000 variantes sin tienda,
//      sin rate limits y con fallos provocables a voluntad.

import prisma from "../../db.server.ts";
import {
  CONCURRENCY,
  DEADLINE_MS,
  MAX_PRODUCTS_PER_BATCH,
  MAX_VARIANTS_PER_BATCH,
  PROGRESS_FLUSH_UNITS,
} from "./constants.ts";
import { isJobFatal } from "./errors.ts";
import type { JobStatus } from "./job-state.ts";
import {
  claimJob,
  createCompensatingRevert,
  finishJob,
  flushProgress,
  handOffToNextBatch,
  readControl,
  type JobRecord,
} from "./jobs.server.ts";
import {
  getHandler,
  type AdminClient,
  type JobUnit,
  type OpContext,
} from "./operations/index.ts";

/** Cuántas unidades pendientes se traen de la BD de una vez. */
const UNIT_FETCH_PAGE = 100;

export type BatchDeps = {
  /** Dispara la siguiente invocación. Inyectado — ver cabecera del archivo. */
  dispatchNext: (jobId: string) => Promise<void>;
  /** Cliente Shopify de la tienda dueña del job. Inyectado. */
  getAdmin: (shopDomain: string) => Promise<AdminClient>;
  /** Plazo de ESTA invocación. Los tests lo bajan; producción usa DEADLINE_MS. */
  deadlineMs?: number;
  /**
   * Tope de unidades de ESTA invocación. Producción usa MAX_PRODUCTS_PER_BATCH,
   * donde es solo una red de seguridad y quien manda es el plazo.
   *
   * Los tests de interrupción lo usan como palanca principal: cortar por CANTIDAD
   * es determinista, cortar por TIEMPO depende de la latencia a la base. Con
   * plazos cortos, un test que pasa en un portátil junto al centro de datos falla
   * en otro a 70 ms de distancia, porque la fase de resolución se come el plazo
   * entero antes de procesar una sola unidad. Eso ya ocurrió.
   */
  maxProductsPerBatch?: number;
  /** Reloj inyectable para los tests. */
  now?: () => number;
};

export type BatchOutcome = {
  jobId: string;
  claimed: boolean;
  reason?: "busy" | "terminal" | "missing" | "exhausted";
  status: JobStatus | null;
  processed: number;
  total: number;
  unitsThisBatch: number;
  elapsedMs: number;
  chained: boolean;
  error?: string;
};

export async function runJobBatch(
  jobId: string,
  deps: BatchDeps
): Promise<BatchOutcome> {
  const now = deps.now ?? (() => Date.now());
  const deadlineMs = deps.deadlineMs ?? DEADLINE_MS;
  const maxProducts = deps.maxProductsPerBatch ?? MAX_PRODUCTS_PER_BATCH;
  const startedAt = now();
  const expired = () => now() - startedAt >= deadlineMs;

  const base: BatchOutcome = {
    jobId,
    claimed: false,
    status: null,
    processed: 0,
    total: 0,
    unitsThisBatch: 0,
    elapsedMs: 0,
    chained: false,
  };

  const claim = await claimJob(jobId);
  if (!claim.ok)
    return { ...base, reason: claim.reason, elapsedMs: now() - startedAt };

  const { nonce } = claim;
  let job = claim.job;

  const handler = getHandler(job.operation);
  if (!handler) {
    await finishJob(jobId, nonce, "FAILED", {
      lastError: `Operación no soportada: ${job.operation}`,
    });
    return { ...base, claimed: true, status: "FAILED", elapsedMs: now() - startedAt };
  }

  // Contexto: la campaña y el cliente de Shopify se cargan UNA vez por lote.
  // campaignId NULL = la campaña se borró bajo los pies del job. No es un estado
  // alcanzable por la vía normal (DELETE la borra al final, cuando ya terminó),
  // pero si pasa hay que parar aquí y no seguir con media operación.
  const campaign = job.campaignId
    ? await prisma.campaign.findUnique({
        where: { id: job.campaignId },
        select: {
          id: true, name: true, type: true, status: true,
          config: true, startsAt: true, endsAt: true,
          shop: { select: { domain: true } },
        },
      })
    : null;
  if (!campaign) {
    await finishJob(jobId, nonce, "FAILED", {
      lastError: "La campaña de este trabajo ya no existe.",
    });
    return { ...base, claimed: true, status: "FAILED", elapsedMs: now() - startedAt };
  }

  const ctx: OpContext = {
    job,
    admin: await deps.getAdmin(campaign.shop.domain),
    campaign: {
      id: campaign.id,
      name: campaign.name,
      type: campaign.type as string,
      status: campaign.status as string,
      config: campaign.config,
      startsAt: campaign.startsAt,
      endsAt: campaign.endsAt,
    },
  };

  let unitsThisBatch = 0;
  let variantsThisBatch = 0;
  let errorCount = job.errorCount;
  let cancelled = false;

  // La lista de incidencias se SIEMBRA con las que ya había, no se empieza vacía.
  //
  // `flushProgress` sobrescribe el campo `errors` entero, así que con una lista
  // local por lote solo sobrevivían las del último: el merchant leía "3 productos
  // con incidencias" y encontraba el detalle de uno. El contador sí acumulaba
  // bien, y esa discordancia entre número y detalle es justo lo que hace dudar de
  // toda la pantalla.
  const failures: Array<{ unit: string; message: string }> = Array.isArray(job.errors)
    ? [...(job.errors as Array<{ unit: string; message: string }>)]
    : [];

  try {
    // ── Fase 0 — resolución ───────────────────────────────────────────────────
    // También se trocea: paginar el catálogo de una tienda de 20.000 variantes
    // son ~80 páginas, y no puede comerse el plazo de golpe. Si no se troceara,
    // el job moriría por plazo agotado SIN HABER EMPEZADO a aplicar nada, una y
    // otra vez, hasta agotar sus intentos.
    while (job.phase === "RESOLVING") {
      if (expired()) break;
      if (await isCancelRequested(jobId)) {
        cancelled = true;
        break;
      }

      const step = await handler.resolveStep(ctx);
      const alive = await flushProgress(jobId, nonce, {
        totalProducts: step.totalProducts,
        totalVariants: step.totalVariants,
        resolveCursor: step.resolveCursor,
        ...(step.done ? { phase: "APPLYING", status: "RUNNING" as JobStatus } : {}),
      });
      if (!alive) return leaseLost(base, startedAt, now);

      job = { ...job, ...step, phase: step.done ? "APPLYING" : "RESOLVING" };
      ctx.job = job;
      if (step.done) break;
    }

    // ── Fase 1 — trabajo ──────────────────────────────────────────────────────
    if (job.phase === "APPLYING" && !cancelled) {
      let sinceFlush = 0;

      outer: while (!expired()) {
        if (unitsThisBatch >= maxProducts) break;
        if (variantsThisBatch >= MAX_VARIANTS_PER_BATCH) break;

        const pending = await handler.pendingUnits(ctx, UNIT_FETCH_PAGE);
        if (pending.length === 0) break;

        for (let i = 0; i < pending.length; i += CONCURRENCY) {
          // El plazo se comprueba ANTES de lanzar la ola, nunca a mitad: así el
          // desbordamiento máximo está acotado por la duración de UNA ola.
          if (expired()) break outer;
          if (unitsThisBatch >= maxProducts) break outer;
          if (variantsThisBatch >= MAX_VARIANTS_PER_BATCH) break outer;

          const wave = pending.slice(i, i + CONCURRENCY);
          const res = await handler.runUnits(ctx, wave);

          unitsThisBatch += res.succeeded.length;
          variantsThisBatch += res.succeeded.reduce((n, u) => n + u.variantCount, 0);
          sinceFlush += wave.length;

          for (const f of res.failures) {
            errorCount += 1;
            if (failures.length < 50) failures.push(f);
          }

          if (sinceFlush >= PROGRESS_FLUSH_UNITS) {
            sinceFlush = 0;
            const done = await handler.totalDone(ctx);
            const alive = await flushProgress(jobId, nonce, {
              processedProducts: done.products,
              processedVariants: done.variants,
              errorCount,
              errors: failures.length ? failures : undefined,
            });
            if (!alive) return leaseLost(base, startedAt, now);

            if (await isCancelRequested(jobId)) {
              cancelled = true;
              break outer;
            }
          }
        }
      }
    }

    // ── Cierre del lote ───────────────────────────────────────────────────────
    const done = await handler.totalDone(ctx);
    const alive = await flushProgress(jobId, nonce, {
      processedProducts: done.products,
      processedVariants: done.variants,
      errorCount,
      errors: failures.length ? failures : undefined,
    });
    if (!alive) return leaseLost(base, startedAt, now);

    if (cancelled) {
      await finishJob(jobId, nonce, "CANCELLED");
      await enqueueCompensatingRevert(ctx, deps);
      return finish(base, "CANCELLED", done.products, job, unitsThisBatch, startedAt, now, false);
    }

    const remaining = await handler.remaining(ctx);
    if (remaining === 0 && job.phase !== "RESOLVING") {
      // finalize ANTES de marcar terminado: es donde DELETE borra la campaña, y
      // la cascada se lleva por delante la propia fila del job.
      if (handler.finalize) await handler.finalize(ctx);
      const status: JobStatus = errorCount > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
      await finishJob(jobId, nonce, status);
      return finish(base, status, done.products, job, unitsThisBatch, startedAt, now, false);
    }

    // ── Relevo ────────────────────────────────────────────────────────────────
    // 🔴 EL ORDEN IMPORTA Y NO SE PUEDE "SIMPLIFICAR": primero se SUELTA el lease,
    //    después se encadena.
    //
    //    Si se dispara el siguiente lote sin soltar antes, el job sigue en RUNNING
    //    con este `nonce` y con el latido recién puesto por el flushProgress de
    //    arriba. El worker siguiente llama a claimJob, no casa con ninguna de sus
    //    tres ramas (ni QUEUED, ni latido rancio) y se retira con "busy".
    //    LA CADENA MUERE AHÍ, sin error, sin log y con el job aparentando estar
    //    vivo: este lote ya devolvió chained:true y progreso escrito.
    //
    //    Ese bug existió y llegó a pasar los tests: una tanda pequeña cabe en un
    //    solo lote y nunca necesita un relevo, así que el fallo solo apareció al
    //    correr las 20.000 unidades reales. Si vuelves a tocar este bloque,
    //    ejecuta la batería COMPLETA, no la corta.
    await handOffToNextBatch(jobId, nonce);
    await deps.dispatchNext(jobId);
    return finish(base, "RUNNING", done.products, job, unitsThisBatch, startedAt, now, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Fatal = no mejora reintentando (cuota del plan, selección vacía, campaña
    // sin descuento asociado). Se corta ya, con el motivo a la vista, en vez de
    // hacer al merchant mirar cinco veces la misma barra que no avanza.
    if (isJobFatal(err)) {
      await finishJob(jobId, nonce, "FAILED", { lastError: message, force: true });
      return {
        ...base, claimed: true, status: "FAILED",
        unitsThisBatch, elapsedMs: now() - startedAt, chained: false, error: message,
      };
    }

    // Transitorio: se deja que el freno de MAX_ATTEMPTS decida.
    await flushProgress(jobId, nonce, { errorCount: errorCount + 1 }).catch(() => {});
    await prisma.campaignJob
      .updateMany({ where: { id: jobId, leaseNonce: nonce }, data: { lastError: message } })
      .catch(() => {});
    try {
      // 🔴 resetAttempts: false — este lote REVENTÓ. Reiniciar el contador aquí
      //    anularía el freno de MAX_ATTEMPTS y el job se re-patearía para siempre.
      await handOffToNextBatch(jobId, nonce, { resetAttempts: false });
      await deps.dispatchNext(jobId);
    } catch {
      /* si tampoco se puede encadenar, lo recogerá el vigilante */
    }
    return {
      ...base, claimed: true, status: "RUNNING",
      unitsThisBatch, elapsedMs: now() - startedAt, chained: true, error: message,
    };
  }
}

// ─── Auxiliares ───────────────────────────────────────────────────────────────

/**
 * Al cancelar un APPLY, deshacer lo ya aplicado.
 *
 * Es el ÚNICO sitio donde este sistema hace algo parecido a un rollback, y es
 * deliberadamente explícito: un job compensatorio nuevo, visible en la barra, con
 * su propio progreso. No una transacción mágica.
 *
 * Por qué no se reanuda en vez de deshacer: cancelar es una orden del merchant,
 * no una interrupción. Y por qué no es implícito: deshacer 1.720 productos son
 * 1.720 mutaciones más, o sea otra operación larga que también puede
 * interrumpirse. Merece su propia barra y su propia reanudación.
 *
 * Va acotado con `onlyStampedBy` a lo que el job cancelado llegó a tocar: no
 * tiene sentido recorrer el catálogo entero para deshacer un 5 %.
 *
 * Nunca lanza: si esto falla, la cancelación ya ocurrió y el merchant tiene el
 * botón de revertir en la tarjeta del job.
 */
async function enqueueCompensatingRevert(
  ctx: OpContext,
  deps: BatchDeps
): Promise<void> {
  const revertId = await createCompensatingRevert(ctx.job.id);
  if (!revertId) return;
  try {
    await deps.dispatchNext(revertId);
  } catch (err) {
    // Creado pero sin arrancar: lo recogerá el vigilante o el barrido.
    console.error("[jobs] revert compensatorio creado pero no despachado:", err);
  }
}

async function isCancelRequested(jobId: string): Promise<boolean> {
  const control = await readControl(jobId);
  return control?.status === "CANCELLING";
}

function leaseLost(
  base: BatchOutcome,
  startedAt: number,
  now: () => number
): BatchOutcome {
  // Nos declararon zombis y otro worker tomó el job. Parar en seco: seguir
  // escribiendo corrompería el progreso del nuevo dueño.
  return { ...base, claimed: true, reason: "busy", elapsedMs: now() - startedAt };
}

function finish(
  base: BatchOutcome,
  status: JobStatus,
  processed: number,
  job: JobRecord,
  unitsThisBatch: number,
  startedAt: number,
  now: () => number,
  chained: boolean
): BatchOutcome {
  return {
    ...base,
    claimed: true,
    status,
    processed,
    total: job.totalProducts,
    unitsThisBatch,
    elapsedMs: now() - startedAt,
    chained,
  };
}

export type { JobUnit };
