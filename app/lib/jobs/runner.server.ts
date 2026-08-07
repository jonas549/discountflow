// El bucle de un lote: reclamar, trabajar hasta el plazo, guardar, encadenar.
//
// ⭐ La costura que hace todo esto probable: `dispatchNext` se INYECTA.
//    - en la ruta /api/jobs/run  → es un POST HTTPS a uno mismo (invocación nueva)
//    - en los tests              → es una llamada recursiva a runJobBatch
//   Así los tests ejercitan el encadenado real —incluido que cada invocación tiene
//   su propio plazo— sin levantar un servidor HTTP.

import {
  CONCURRENCY,
  DEADLINE_MS,
  MAX_PRODUCTS_PER_BATCH,
  MAX_VARIANTS_PER_BATCH,
  PROGRESS_FLUSH_UNITS,
} from "./constants.ts";
import type { JobStatus } from "./job-state.ts";
import {
  claimJob,
  finishJob,
  flushProgress,
  handOffToNextBatch,
  readControl,
  type JobRecord,
} from "./jobs.server.ts";
import { getHandler, type JobUnit } from "./operations/index.ts";
import prisma from "../../db.server.ts";

/** Cuántas unidades pendientes se traen de la BD de una vez. */
const UNIT_FETCH_PAGE = 100;

export type BatchDeps = {
  /** Dispara la siguiente invocación. Inyectado — ver cabecera del archivo. */
  dispatchNext: (jobId: string) => Promise<void>;
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

  let unitsThisBatch = 0;
  let variantsThisBatch = 0;
  let errorCount = job.errorCount;
  const failures: Array<{ unit: string; message: string }> = [];
  let cancelled = false;

  try {
    // ── Fase 0 — resolución ───────────────────────────────────────────────────
    // También se trocea: paginar el catálogo de una tienda de 20.000 variantes
    // son ~80 páginas, y no puede comerse el plazo de golpe.
    while (job.phase === "RESOLVING") {
      if (expired()) break;
      if (await isCancelRequested(jobId)) {
        cancelled = true;
        break;
      }

      const step = await handler.resolveStep(job, nonce);
      const alive = await flushProgress(jobId, nonce, {
        totalProducts: step.totalProducts,
        totalVariants: step.totalVariants,
        resolveCursor: step.resolveCursor,
        ...(step.done ? { phase: "APPLYING", status: "RUNNING" as JobStatus } : {}),
      });
      if (!alive) return leaseLost(base, startedAt, now);

      job = { ...job, ...step, phase: step.done ? "APPLYING" : "RESOLVING" };
      if (step.done) break;
    }

    // ── Fase 1 — trabajo ──────────────────────────────────────────────────────
    if (job.phase === "APPLYING" && !cancelled) {
      let sinceFlush = 0;

      outer: while (!expired()) {
        if (unitsThisBatch >= maxProducts) break;
        if (variantsThisBatch >= MAX_VARIANTS_PER_BATCH) break;

        const pending = await handler.pendingUnits(job, UNIT_FETCH_PAGE);
        if (pending.length === 0) break;

        for (let i = 0; i < pending.length; i += CONCURRENCY) {
          // El plazo se comprueba ANTES de lanzar la ola, nunca a mitad: así el
          // desbordamiento máximo está acotado por la duración de UNA ola.
          if (expired()) break outer;
          if (unitsThisBatch >= maxProducts) break outer;
          if (variantsThisBatch >= MAX_VARIANTS_PER_BATCH) break outer;

          const wave = pending.slice(i, i + CONCURRENCY);
          const res = await handler.runUnits(job, wave);

          unitsThisBatch += res.succeeded.length;
          variantsThisBatch += res.succeeded.reduce((n, u) => n + u.variantCount, 0);
          sinceFlush += wave.length;

          for (const f of res.failures) {
            errorCount += 1;
            if (failures.length < 50) failures.push(f);
          }

          if (sinceFlush >= PROGRESS_FLUSH_UNITS) {
            sinceFlush = 0;
            const done = await handler.totalDone(job);
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
    const done = await handler.totalDone(job);
    const alive = await flushProgress(jobId, nonce, {
      processedProducts: done.products,
      processedVariants: done.variants,
      errorCount,
      errors: failures.length ? failures : undefined,
    });
    if (!alive) return leaseLost(base, startedAt, now);

    if (cancelled) {
      await finishJob(jobId, nonce, "CANCELLED");
      return finish(base, "CANCELLED", done.products, job, unitsThisBatch, startedAt, now, false);
    }

    const remaining = await handler.remaining(job);
    if (remaining === 0 && job.phase !== "RESOLVING") {
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
    // No se marca FAILED aquí: se deja que el freno de MAX_ATTEMPTS decida. Un
    // fallo transitorio (red, throttling agotado) merece reintento; uno que se
    // repite siempre en el mismo punto agotará los intentos y morirá solo.
    await flushProgress(jobId, nonce, { errorCount: errorCount + 1 }).catch(() => {});
    await prisma.campaignJob
      .updateMany({ where: { id: jobId, leaseNonce: nonce }, data: { lastError: message } })
      .catch(() => {});
    try {
      await deps.dispatchNext(jobId);
    } catch {
      /* si tampoco se puede encadenar, lo recogerá el vigilante */
    }
    return {
      ...base,
      claimed: true,
      status: "RUNNING",
      unitsThisBatch,
      elapsedMs: now() - startedAt,
      chained: true,
      error: message,
    };
  }
}

// ─── Auxiliares ───────────────────────────────────────────────────────────────

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
