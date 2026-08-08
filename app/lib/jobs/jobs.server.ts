// Almacén de jobs: crear, reclamar, latir, terminar.
//
// Todo lo delicado de este archivo es semántica de PostgreSQL, no de JavaScript.
// Las carreras (dos clics, dos workers) se resuelven con UPDATE condicional, que es
// atómico y bloquea la fila: el segundo escritor espera al primero y RE-EVALÚA su
// WHERE contra la fila ya modificada, así que no puede ganar. Falsear Prisma en los
// tests haría que estas garantías pasaran siempre sin demostrar nada, y por eso los
// tests del motor corren contra Postgres de verdad.

// Los imports llevan extensión .ts a propósito: estos módulos los cargan tanto
// Vite (que resuelve ambas formas) como el runner nativo de Node en los tests, y
// el resolvedor ESM de Node RECHAZA los imports sin extensión y los de directorio.
// Es la misma trampa que ya impidió una vez probar módulos de app/ con un script
// suelto. Mantenerlos explícitos es lo que hace que este motor sea testeable.
import prisma from "../../db.server.ts";
import {
  LEASE_STALE_MS,
  MAX_ATTEMPTS,
  TERMINAL_STATUSES,
} from "./constants.ts";
import { isTerminal, type JobOperation, type JobStatus } from "./job-state.ts";

export type JobRecord = {
  id: string;
  /** NULL = la campaña ya se borró y este job es solo historial. Ver el schema. */
  campaignId: string | null;
  /** Copia del nombre al crear el job: sobrevive al borrado de la campaña. */
  campaignName: string | null;
  shopId: string;
  operation: JobOperation;
  status: JobStatus;
  phase: string;
  totalProducts: number;
  processedProducts: number;
  totalVariants: number;
  processedVariants: number;
  resolveCursor: string | null;
  heartbeatAt: Date | null;
  leaseNonce: string | null;
  attempts: number;
  errorCount: number;
  /** Incidencias por unidad acumuladas entre lotes. Ver la siembra en el runner. */
  errors: unknown;
  lastError: string | null;
  payload: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

/** Marca interna para abortar la transacción cuando otro proceso ganó el cerrojo. */
const LOCK_TAKEN = "DISCOUNTFLOW_LOCK_TAKEN";

function newNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Crear ────────────────────────────────────────────────────────────────────

export type CreateJobResult = {
  job: JobRecord;
  /** false = ya había un job vivo y te has enganchado a él (segundo clic). */
  created: boolean;
};

/**
 * Crea un job para una campaña, o devuelve el que ya estuviera corriendo.
 *
 * 🔒 Idempotencia frente a doble disparo. Diez clics simultáneos producen UN job.
 *
 * El cerrojo NO es leer-y-luego-escribir: eso sí tiene carrera (dos transacciones
 * leen activeJobId = null y ambas escriben). Es un UPDATE condicional
 * `WHERE "activeJobId" IS NULL`, que bajo READ COMMITTED hace que el segundo
 * UPDATE espere al primero y vuelva a evaluar el WHERE contra la fila nueva:
 * afecta a 0 filas y pierde. El perdedor deshace su INSERT entero (misma
 * transacción), así que no quedan jobs huérfanos.
 */
export async function createJob(input: {
  campaignId: string;
  shopId: string;
  operation: JobOperation;
  payload?: Record<string, unknown>;
}): Promise<CreateJobResult> {
  const existing = await getLiveJobForCampaign(input.campaignId, input.shopId);
  if (existing) return { job: existing, created: false };

  try {
    const job = await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.findFirst({
        where: { id: input.campaignId, shopId: input.shopId },
        select: { id: true, name: true },
      });
      if (!campaign)
        throw new Error("Campaña no encontrada o de otra tienda.");

      const created = await tx.campaignJob.create({
        data: {
          campaignId: input.campaignId,
          // Se copia AQUÍ, no al terminar: si el job muere a mitad, el historial
          // tiene que poder decir de qué campaña hablaba.
          campaignName: campaign.name,
          shopId: input.shopId,
          operation: input.operation,
          payload: (input.payload ?? {}) as never,
        },
      });

      // El cerrojo. Si otro ganó, esto afecta a 0 filas y lanzamos para deshacer
      // también el INSERT de arriba.
      const locked = await tx.$executeRaw`
        UPDATE "Campaign"
           SET "activeJobId" = ${created.id}
         WHERE "id" = ${input.campaignId}
           AND "activeJobId" IS NULL
      `;
      if (locked !== 1) throw new Error(LOCK_TAKEN);

      return created as unknown as JobRecord;
    });

    return { job, created: true };
  } catch (err) {
    if (err instanceof Error && err.message === LOCK_TAKEN) {
      const winner = await getLiveJobForCampaign(input.campaignId, input.shopId);
      if (winner) return { job: winner, created: false };
    }
    throw err;
  }
}

/**
 * El job vivo de una campaña, si lo hay.
 *
 * Además limpia punteros rancios: si activeJobId apunta a un job terminal o
 * inexistente —lo que puede pasar tras un rollback de código con jobs en vuelo—,
 * se suelta el cerrojo para que la campaña no quede bloqueada para siempre.
 */
export async function getLiveJobForCampaign(
  campaignId: string,
  shopId: string
): Promise<JobRecord | null> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { activeJobId: true },
  });
  if (!campaign?.activeJobId) return null;

  const job = await prisma.campaignJob.findUnique({
    where: { id: campaign.activeJobId },
  });

  if (job && !isTerminal(job.status as JobStatus))
    return job as unknown as JobRecord;

  await releaseCampaignLock(campaignId, campaign.activeJobId);
  return null;
}

/** Suelta el cerrojo SOLO si sigue apuntando a este job. Nunca a ciegas. */
async function releaseCampaignLock(
  campaignId: string,
  jobId: string
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Campaign"
       SET "activeJobId" = NULL
     WHERE "id" = ${campaignId}
       AND "activeJobId" = ${jobId}
  `;
}

// ─── Reclamar (lease) ─────────────────────────────────────────────────────────

export type ClaimOutcome =
  | { ok: true; nonce: string; job: JobRecord }
  | { ok: false; reason: "busy" | "terminal" | "missing" | "exhausted" };

/**
 * Toma posesión exclusiva de un job.
 *
 * Un UPDATE condicional. Dos workers simultáneos: uno afecta a 1 fila y es el
 * dueño; el otro afecta a 0 y se retira. No hay ventana entre comprobar y escribir
 * porque es la misma sentencia.
 *
 * Se puede reclamar un job QUEUED (nunca arrancó) o uno RUNNING/RESOLVING con el
 * heartbeat rancio: eso último es la definición operativa de ZOMBI, y es la vía por
 * la que un job cuyo worker murió vuelve al ruedo.
 */
export async function claimJob(jobId: string): Promise<ClaimOutcome> {
  const current = await prisma.campaignJob.findUnique({ where: { id: jobId } });
  if (!current) return { ok: false, reason: "missing" };
  if (isTerminal(current.status as JobStatus))
    return { ok: false, reason: "terminal" };

  if (current.attempts >= MAX_ATTEMPTS) {
    await finishJob(jobId, current.leaseNonce, "FAILED", {
      lastError: `El trabajo se interrumpió ${current.attempts} veces seguidas y se detuvo para no reintentar indefinidamente.`,
      force: true,
    });
    return { ok: false, reason: "exhausted" };
  }

  const nonce = newNonce();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_STALE_MS);
  const nextStatus: JobStatus =
    current.phase === "RESOLVING" ? "RESOLVING" : "RUNNING";

  const res = await prisma.campaignJob.updateMany({
    where: {
      id: jobId,
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: "QUEUED" },
        { status: { in: ["RUNNING", "RESOLVING"] }, heartbeatAt: null },
        {
          status: { in: ["RUNNING", "RESOLVING"] },
          heartbeatAt: { lt: staleBefore },
        },
      ],
    },
    data: {
      status: nextStatus,
      leaseNonce: nonce,
      heartbeatAt: now,
      attempts: { increment: 1 },
    },
  });

  if (res.count !== 1) return { ok: false, reason: "busy" };

  if (!current.startedAt)
    await prisma.campaignJob.update({
      where: { id: jobId },
      data: { startedAt: now },
    });

  const job = await prisma.campaignJob.findUnique({ where: { id: jobId } });
  return { ok: true, nonce, job: job as unknown as JobRecord };
}

// ─── Latir y progresar ────────────────────────────────────────────────────────

/**
 * Vuelca progreso y late, en una sola escritura.
 *
 * Devuelve false si el lease ya no es nuestro: entonces el worker DEBE parar de
 * inmediato. Es la contrapartida del desalojo por zombi — si nos declararon
 * muertos y otro tomó el job, seguir escribiendo corrompería su progreso.
 *
 * El progreso se ESCRIBE (valor absoluto), nunca se incrementa, para que repetir
 * un volcado sea idempotente.
 */
export async function flushProgress(
  jobId: string,
  nonce: string,
  data: {
    processedProducts?: number;
    processedVariants?: number;
    totalProducts?: number;
    totalVariants?: number;
    phase?: string;
    status?: JobStatus;
    resolveCursor?: string | null;
    errorCount?: number;
    errors?: unknown;
  }
): Promise<boolean> {
  const res = await prisma.campaignJob.updateMany({
    where: { id: jobId, leaseNonce: nonce },
    data: {
      ...(data.processedProducts !== undefined && {
        processedProducts: data.processedProducts,
      }),
      ...(data.processedVariants !== undefined && {
        processedVariants: data.processedVariants,
      }),
      ...(data.totalProducts !== undefined && { totalProducts: data.totalProducts }),
      ...(data.totalVariants !== undefined && { totalVariants: data.totalVariants }),
      ...(data.phase !== undefined && { phase: data.phase }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.resolveCursor !== undefined && { resolveCursor: data.resolveCursor }),
      ...(data.errorCount !== undefined && { errorCount: data.errorCount }),
      ...(data.errors !== undefined && { errors: data.errors as never }),
      heartbeatAt: new Date(),
    },
  });
  return res.count === 1;
}

/**
 * 🔴 Suelta el lease para que el SIGUIENTE lote de la cadena pueda tomar el job.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  ESTA FUNCIÓN NO ES OPCIONAL. Sin ella la cadena se rompe EN SILENCIO.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Un lote que termina limpio deja el job en RUNNING con `leaseNonce` puesto y el
 * latido recién actualizado. En ese estado, `claimJob` del lote siguiente no casa
 * con NINGUNA de sus tres ramas —no está QUEUED, y su latido no es rancio— así que
 * se retira con "busy" y la cadena muere ahí mismo.
 *
 * El síntoma es especialmente traicionero: el primer lote hace su trabajo, escribe
 * progreso y devuelve `chained: true`, o sea que TODO parece correcto. La campaña
 * simplemente se queda congelada a mitad hasta que, 90 segundos después, el latido
 * se vuelve rancio y el vigilante la rescata. Con una tanda pequeña que cabe en un
 * solo lote el fallo es INVISIBLE: se detectó únicamente al correr las 20.000
 * unidades de verdad.
 *
 * Pasar a QUEUED es la transición correcta y ya está contemplada en la máquina de
 * estados (RUNNING -> QUEUED, la misma que usa el vigilante). El latido se deja
 * FRESCO a propósito: así el job no figura como colgado durante el relevo, y si la
 * cadena se rompiera de verdad, a los 90 s se volvería rancio y el vigilante lo
 * recogería igual.
 *
 * 🔴 `resetAttempts` NO es un detalle: es lo que decide si el freno de
 *    MAX_ATTEMPTS funciona.
 *
 *    Tras un lote LIMPIO hay que reiniciarlo (true): `attempts` solo debe contar
 *    arranques que NO avanzan, o un job sano de 18 lotes llegaría a attempts=18 y
 *    el freno lo mataría por estar funcionando bien.
 *
 *    Tras un lote que REVENTÓ hay que conservarlo (false). Reiniciarlo ahí anula
 *    el freno por completo: el contador vuelve a cero en cada fallo, nunca alcanza
 *    el tope y un job que revienta siempre en el mismo punto se re-patea para
 *    siempre, comiéndose la cuota de invocaciones de Hobby —donde agotarla no
 *    degrada el servicio, lo APAGA hasta 30 días—. Ese bug existió: se coló al
 *    cablear las operaciones reales y lo cazó el test del freno.
 */
export async function handOffToNextBatch(
  jobId: string,
  nonce: string,
  opts: { resetAttempts: boolean } = { resetAttempts: true }
): Promise<boolean> {
  const res = await prisma.campaignJob.updateMany({
    where: { id: jobId, leaseNonce: nonce, status: { in: ["RUNNING", "RESOLVING"] } },
    data: {
      status: "QUEUED",
      leaseNonce: null,
      ...(opts.resetAttempts ? { attempts: 0 } : {}),
      heartbeatAt: new Date(),
    },
  });
  return res.count === 1;
}

/** Lectura barata para que el worker sepa si le han pedido cancelar. */
export async function readControl(
  jobId: string
): Promise<{ status: JobStatus; leaseNonce: string | null } | null> {
  const job = await prisma.campaignJob.findUnique({
    where: { id: jobId },
    select: { status: true, leaseNonce: true },
  });
  return job
    ? { status: job.status as JobStatus, leaseNonce: job.leaseNonce }
    : null;
}

// ─── Terminar ─────────────────────────────────────────────────────────────────

/**
 * Lleva el job a un estado terminal y SUELTA EL CERROJO DE LA CAMPAÑA.
 *
 * 🔴 Las dos cosas van en la MISMA transacción. Si el cerrojo no se soltara, la
 * campaña quedaría bloqueada para siempre por un job muerto: no se podría editar,
 * ni pausar, ni volver a lanzar nada sobre ella. Es la invariante más importante
 * del sistema y la que verifica el criterio "cero campañas con activeJobId".
 */
export async function finishJob(
  jobId: string,
  nonce: string | null,
  status: JobStatus,
  opts: { lastError?: string; force?: boolean } = {}
): Promise<boolean> {
  if (!TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number]))
    throw new Error(`finishJob solo acepta estados terminales, recibió ${status}`);

  const job = await prisma.campaignJob.findUnique({ where: { id: jobId } });
  if (!job) return false;
  if (isTerminal(job.status as JobStatus)) return false;

  return prisma.$transaction(async (tx) => {
    const res = await tx.campaignJob.updateMany({
      where: {
        id: jobId,
        ...(opts.force ? {} : { leaseNonce: nonce }),
      },
      data: {
        status,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        ...(opts.lastError !== undefined && { lastError: opts.lastError }),
      },
    });
    if (res.count !== 1) return false;

    // Si la campaña ya no existe (campaignId NULL tras un DELETE) no hay cerrojo
    // que soltar: se borró con ella.
    if (job.campaignId !== null) {
      await tx.$executeRaw`
        UPDATE "Campaign"
           SET "activeJobId" = NULL
         WHERE "id" = ${job.campaignId}
           AND "activeJobId" = ${jobId}
      `;
    }
    return true;
  });
}

// ─── Cancelar ─────────────────────────────────────────────────────────────────

/**
 * Pide la cancelación. No para nada por su cuenta: marca CANCELLING y el worker lo
 * ve en el corte de la siguiente unidad y se detiene limpiamente.
 *
 * Un job QUEUED que nunca llegó a arrancar se cancela en el acto: no hay worker que
 * pueda enterarse, así que esperar a que "alguien lo vea" lo dejaría colgado.
 */
export async function requestCancel(
  jobId: string,
  shopId: string
): Promise<{ cancelled: boolean; compensatingJobId?: string }> {
  const job = await prisma.campaignJob.findFirst({ where: { id: jobId, shopId } });
  if (!job || isTerminal(job.status as JobStatus)) return { cancelled: false };

  // ⚠️ Un job QUEUED se cancela EN EL ACTO, y ese es el caso más frecuente, no una
  // rareza: entre lote y lote el job pasa por QUEUED, así que la mayoría de las
  // cancelaciones caen aquí. Como no hay worker que se entere, el revert
  // compensatorio hay que crearlo desde aquí; si solo viviera en el runner —donde
  // estaba al principio— cancelar entre lotes dejaría los precios aplicados sin
  // deshacer y sin que nadie lo supiera.
  if (job.status === "QUEUED") {
    const ok = await finishJob(jobId, job.leaseNonce, "CANCELLED", { force: true });
    if (!ok) return { cancelled: false };
    const compensatingJobId = await createCompensatingRevert(jobId);
    return { cancelled: true, ...(compensatingJobId ? { compensatingJobId } : {}) };
  }

  const res = await prisma.campaignJob.updateMany({
    where: { id: jobId, status: { in: ["RESOLVING", "RUNNING"] } },
    data: { status: "CANCELLING" },
  });
  return { cancelled: res.count === 1 };
}

/**
 * Crea (sin lanzar) el REVERT que deshace lo que un APPLY cancelado llegó a
 * aplicar. Devuelve su id, o null si no hacía falta.
 *
 * Vive aquí, y no en el runner, porque hay DOS caminos por los que un APPLY puede
 * acabar cancelado: que el worker vea la orden a mitad de lote, o que la orden
 * llegue mientras el job espera entre lotes (estado QUEUED). Si solo lo hiciera
 * uno de los dos, la mitad de las cancelaciones dejarían precios rebajados sin
 * deshacer.
 *
 * Va acotado con `onlyStampedBy`: no tiene sentido recorrer el catálogo entero
 * para deshacer el 10 % que se llegó a tocar.
 */
export async function createCompensatingRevert(
  cancelledJobId: string
): Promise<string | null> {
  try {
    const job = await prisma.campaignJob.findUnique({
      where: { id: cancelledJobId },
      include: { campaign: { select: { id: true, type: true } } },
    });
    if (!job || job.operation !== "APPLY") return null;
    // Sin campaña no hay nada que compensar: si se borró, sus CampaignProduct se
    // fueron con ella (siguen en Cascade) y no queda precio que devolver.
    if (job.campaignId === null || !job.campaign) return null;
    if (job.campaign.type !== "PERCENTAGE" && job.campaign.type !== "RANGE") return null;

    const tocadas = await prisma.campaignProduct.count({
      where: { campaignId: job.campaignId, processedByJobId: cancelledJobId },
    });
    if (tocadas === 0) return null; // no se aplicó nada: no hay qué deshacer

    const { job: revert, created } = await createJob({
      campaignId: job.campaignId,
      shopId: job.shopId,
      operation: "REVERT",
      payload: { onlyStampedBy: cancelledJobId },
    });
    return created ? revert.id : null;
  } catch (err) {
    console.error("[jobs] no se pudo crear el revert compensatorio:", err);
    return null;
  }
}

// ─── Zombis ───────────────────────────────────────────────────────────────────

/**
 * Jobs no terminales que dejaron de dar señales.
 *
 * Los consultan las tres capas de recuperación: el sondeo del cliente (segundos),
 * el barrido perezoso de cualquier action (siguiente interacción) y el cron diario
 * (red final — Hobby no permite más de una ejecución al día).
 */
export async function findStalledJobs(opts: {
  shopId?: string;
  limit?: number;
}): Promise<JobRecord[]> {
  const staleBefore = new Date(Date.now() - LEASE_STALE_MS);
  const jobs = await prisma.campaignJob.findMany({
    where: {
      ...(opts.shopId ? { shopId: opts.shopId } : {}),
      status: { in: ["QUEUED", "RESOLVING", "RUNNING"] },
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 20,
  });
  return jobs as unknown as JobRecord[];
}

export async function getJob(
  jobId: string,
  shopId: string
): Promise<JobRecord | null> {
  const job = await prisma.campaignJob.findFirst({ where: { id: jobId, shopId } });
  return (job as unknown as JobRecord) ?? null;
}
