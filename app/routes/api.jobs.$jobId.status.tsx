// Estado de un job para la barra de progreso.
//
//   GET  /api/jobs/:jobId/status   → el contrato que consume la UI
//   POST /api/jobs/:jobId/status   → { intent: "kick" | "cancel" }
//
// El POST existe porque el vigilante del cliente NO puede llamar a /api/jobs/run:
// esa ruta exige el secreto compartido y el secreto no puede bajar al navegador
// bajo ningún concepto. El cliente pide "despierta este job" a una ruta
// autenticada como merchant, y es el servidor quien usa el secreto.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import {
  LEASE_STALE_MS,
  POLL_FAST_MS,
  POLL_FAST_UNTIL_MS,
  POLL_NORMAL_MS,
  POLL_NORMAL_UNTIL_MS,
  POLL_SLOW_MS,
} from "../lib/jobs/constants";
import {
  isStalled,
  isTerminal,
  percentOf,
  type JobStatus,
} from "../lib/jobs/job-state";
import { getJob, requestCancel } from "../lib/jobs/jobs.server";
import { dispatchNextBatch } from "../lib/jobs/chain.server";
import { prisma } from "../lib/db";

function pollIntervalFor(startedAt: Date | null, now: Date): number {
  if (!startedAt) return POLL_FAST_MS;
  const elapsed = now.getTime() - startedAt.getTime();
  if (elapsed < POLL_FAST_UNTIL_MS) return POLL_FAST_MS;
  if (elapsed < POLL_NORMAL_UNTIL_MS) return POLL_NORMAL_MS;
  return POLL_SLOW_MS;
}

function humanMessage(
  status: JobStatus,
  phase: string,
  processedVariants: number,
  totalVariants: number
): string {
  const n = (v: number) => v.toLocaleString("es-CL");
  switch (status) {
    case "QUEUED":
      return "En cola…";
    case "RESOLVING":
      return "Buscando los productos de la campaña…";
    case "RUNNING":
      return phase === "RESOLVING"
        ? "Buscando los productos de la campaña…"
        : `Procesando ${n(processedVariants)} de ${n(totalVariants)} variantes`;
    case "CANCELLING":
      return "Cancelando…";
    case "COMPLETED":
      return `Listo: ${n(totalVariants)} variantes procesadas`;
    case "COMPLETED_WITH_ERRORS":
      return `Terminado con incidencias: ${n(processedVariants)} de ${n(totalVariants)}`;
    case "CANCELLED":
      return `Cancelado tras procesar ${n(processedVariants)} variantes`;
    case "FAILED":
      return "El proceso se detuvo";
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const job = await getJob(String(params.jobId), shop.id);
  if (!job) return Response.json({ error: "Job no encontrado" }, { status: 404 });

  const now = new Date();
  const status = job.status as JobStatus;
  // La campaña puede haberse borrado (un DELETE que terminó). El job sobrevive, y
  // el nombre sale de la copia que guardó al crearse.
  const campaign = job.campaignId
    ? await prisma.campaign.findUnique({
        where: { id: job.campaignId },
        select: { name: true },
      })
    : null;

  const etaSeconds =
    job.startedAt && job.totalProducts > 0 && job.processedProducts > 0
      ? Math.max(
          0,
          Math.round(
            ((now.getTime() - job.startedAt.getTime()) / job.processedProducts) *
              (job.totalProducts - job.processedProducts) /
              1000
          )
        )
      : null;

  return Response.json({
    jobId: job.id,
    campaignId: job.campaignId,
    campaignName: campaign?.name ?? job.campaignName ?? null,
    operation: job.operation,
    status,
    phase: job.phase,

    percent: percentOf(job.processedProducts, job.totalProducts, status),
    processedProducts: job.processedProducts,
    totalProducts: job.totalProducts,
    processedVariants: job.processedVariants,
    totalVariants: job.totalVariants,

    message: humanMessage(status, job.phase, job.processedVariants, job.totalVariants),
    // Solo tras un 10 % de avance: antes la muestra es tan pequeña que la
    // estimación salta de "2 min" a "11 min" y destruye la confianza más de lo
    // que la ausencia de estimación resta.
    etaSeconds:
      job.totalProducts > 0 && job.processedProducts / job.totalProducts >= 0.1
        ? etaSeconds
        : null,

    startedAt: job.startedAt,
    heartbeatAt: job.heartbeatAt,
    finishedAt: job.finishedAt,
    stalled: isStalled(status, job.heartbeatAt, now, LEASE_STALE_MS),

    errorCount: job.errorCount,
    lastError: status === "FAILED" ? job.lastError : null,
    attempts: job.attempts,
    canCancel: !isTerminal(status) && status !== "CANCELLING",

    nextPollMs: isTerminal(status) ? null : pollIntervalFor(job.startedAt, now),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const jobId = String(params.jobId);
  const job = await getJob(jobId, shop.id);
  if (!job) return Response.json({ error: "Job no encontrado" }, { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "cancel") {
    const res = await requestCancel(jobId, shop.id);
    // Cancelar un APPLY que ya tocó precios deja un REVERT compensatorio creado:
    // hay que arrancarlo, o los productos ya rebajados se quedarían así.
    if (res.compensatingJobId)
      await dispatchNextBatch(request, res.compensatingJobId);
    return Response.json({ ok: res.cancelled, revertJobId: res.compensatingJobId ?? null });
  }

  if (intent === "kick") {
    // Vigilante: solo despierta jobs que de verdad están colgados. Sin esta
    // comprobación, un cliente con una pestaña abierta re-patearía sin parar un
    // job perfectamente vivo y duplicaría el consumo de invocaciones.
    if (isTerminal(job.status as JobStatus))
      return Response.json({ ok: false, reason: "terminal" });
    if (!isStalled(job.status as JobStatus, job.heartbeatAt, new Date(), LEASE_STALE_MS))
      return Response.json({ ok: false, reason: "alive" });

    await dispatchNextBatch(request, jobId);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "intent no reconocido" }, { status: 400 });
};
