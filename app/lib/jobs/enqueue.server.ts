// Puerta de entrada al sistema de jobs desde las rutas.
//
// Todas las pantallas hacen lo mismo: "¿puedo encolar esto?" Si el flag está
// encendido devuelve un jobId y la ruta responde al instante con la barra; si no,
// devuelve null y la ruta sigue por el camino síncrono de siempre, intacto.
//
// 🔒 El flag gobierna SOLO esta puerta. Nunca al worker: apagarlo con jobs en
//    vuelo debe dejar que terminen, o el propio interruptor de emergencia sería
//    quien generase los estados a medias que todo esto viene a evitar.

import prisma from "../../db.server.ts";
import { hasFeature } from "../features.server.ts";
import { dispatchNextBatch } from "./chain.server.ts";
import { JOBS_FEATURE_FLAG } from "./constants.ts";
import { isStalled, type JobOperation, type JobStatus } from "./job-state.ts";
import { LEASE_STALE_MS } from "./constants.ts";
import { createJob, findStalledJobs } from "./jobs.server.ts";

export type EnqueueResult =
  | { enqueued: true; jobId: string; alreadyRunning: boolean }
  | { enqueued: false; reason: "flag-off" };

export async function enqueueCampaignJob(input: {
  request: Request;
  shop: { id: string; features?: unknown };
  campaignId: string;
  operation: JobOperation;
  payload?: Record<string, unknown>;
}): Promise<EnqueueResult> {
  if (!hasFeature(input.shop, JOBS_FEATURE_FLAG))
    return { enqueued: false, reason: "flag-off" };

  const { job, created } = await createJob({
    campaignId: input.campaignId,
    shopId: input.shop.id,
    operation: input.operation,
    payload: input.payload,
  });

  // Si ya había uno vivo, el merchant hizo doble clic: se engancha al existente y
  // NO se dispara otra cadena, que duplicaría el consumo de invocaciones.
  if (created) await dispatchNextBatch(input.request, job.id);

  return { enqueued: true, jobId: job.id, alreadyRunning: !created };
}

/**
 * Barrido perezoso: cualquier interacción del merchant despierta los jobs de su
 * tienda que se hayan quedado colgados.
 *
 * Es la segunda de las tres capas de recuperación. La primera es el sondeo de la
 * barra (segundos, pero solo si hay alguien mirando) y la tercera el cron diario
 * —lo máximo que permite Hobby—. Esta cubre el hueco de en medio: el merchant
 * entra al listado a la mañana siguiente y sus jobs arrancan solos.
 *
 * Nunca lanza: es una cortesía, no puede tumbar la pantalla que la invoca.
 */
export async function sweepStalledJobs(
  request: Request,
  shopId: string
): Promise<number> {
  try {
    const colgados = await findStalledJobs({ shopId, limit: 5 });
    const now = new Date();
    let despertados = 0;
    for (const job of colgados) {
      if (!isStalled(job.status as JobStatus, job.heartbeatAt, now, LEASE_STALE_MS))
        continue;
      await dispatchNextBatch(request, job.id);
      despertados += 1;
    }
    return despertados;
  } catch (err) {
    console.error("[jobs] fallo en el barrido de jobs colgados:", err);
    return 0;
  }
}

/**
 * 🔴 Cierra la puerta a editar una campaña mientras tiene una operación en curso.
 *
 * Devuelve una respuesta 409 si está ocupada, o null si puede seguir.
 *
 * Editar a mitad de un job corrompe el trabajo sin remedio: la fase de resolución
 * ya fijó la lista de productos y sus precios originales, y cambiar la selección
 * por debajo deja al worker aplicando descuentos sobre un plan que ya no existe —
 * o revirtiendo a precios que ya no son los buenos.
 *
 * ⚠️ Esta comprobación va en el ACTION, no solo en la UI. Los botones
 *    deshabilitados del listado son cortesía: una pestaña vieja, un doble envío o
 *    una petición fabricada se los saltan sin enterarse. Esta es la única capa
 *    que cuenta.
 */
export async function rejectIfCampaignBusy(
  shopDomain: string,
  campaignId: string
): Promise<Response | null> {
  // Se filtra por el dominio de la sesión, no por shopId, para poder llamarla en
  // la PRIMERA línea del action —antes de parsear el formulario y antes de
  // getOrCreateShop—. Cuanto antes se cierre la puerta, menos código corre con la
  // campaña en un estado en el que no debería tocarse.
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shop: { domain: shopDomain } },
    select: { activeJobId: true },
  });
  if (!campaign?.activeJobId) return null;

  return Response.json(
    {
      errors: {
        general:
          "Esta campaña tiene una operación en curso. Espera a que termine para editarla.",
      },
      busyJobId: campaign.activeJobId,
    },
    { status: 409 }
  );
}

/** El job vivo de cada campaña de una tienda, para pintar la barra en el listado. */
export async function liveJobsByCampaign(
  shopId: string
): Promise<Record<string, string>> {
  const rows = await prisma.campaign.findMany({
    where: { shopId, activeJobId: { not: null } },
    select: { id: true, activeJobId: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r.activeJobId as string]));
}
