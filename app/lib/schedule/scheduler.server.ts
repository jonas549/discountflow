// El "tick" de la programación: lo llama el cron cada 5 minutos.
//
// Busca campañas con marca encendida (autoStart / autoEnd) y fecha vencida, y
// encola el job correspondiente en el motor. NO toca precios aquí: solo crea el
// job; el trabajo lo hace el motor por tandas, igual que cuando el merchant pulsa
// Activar o Pausar.
//
// 🔒 Solo mira campañas con marca en true. Las guardadas antes del 2026-11-13
//    tienen las dos en false, así que sus fechas viejas no disparan nada.
//
// Las reglas (qué toca y qué no) están en `scheduling.ts`, que es puro y tiene
// tests. Este archivo es la parte con base de datos.

import prisma from "../../db.server.ts";
import { PLAN_LIMITS, type Plan } from "../billing/plan-limits.ts";
import { createJob, findStalledJobs } from "../jobs/jobs.server.ts";
import { isStalled, type JobStatus } from "../jobs/job-state.ts";
import { LEASE_STALE_MS } from "../jobs/constants.ts";
import { dueAction } from "./scheduling.ts";

/** Lo que la pantalla deja guardado para aplicar cuando llegue la hora de inicio. */
export type PendingApply = {
  selection: Record<string, unknown>;
  excludedVariantIds?: string[];
};

export type TickResult = {
  revisadas: number;
  iniciadas: string[];
  terminadas: string[];
  limpiadas: string[];
  avisos: Array<{ campaignId: string; nota: string }>;
  despertados: number;
};

// Mismas cuentas que `plan-limits.server.ts` (solo campañas ACTIVAS). Se repiten
// aquí porque aquel archivo no se puede cargar desde las pruebas de base de datos.
const getActiveCampaignCount = (shopId: string) =>
  prisma.campaign.count({ where: { shopId, status: "ACTIVE" } });
const getVariantCount = (shopId: string) =>
  prisma.campaignProduct.count({ where: { campaign: { shopId, status: "ACTIVE" } } });

const PRICE_TYPES = new Set(["PERCENTAGE", "RANGE"]);
/** Tope por tick: un cron que se atrasa no debe lanzar cientos de jobs de golpe. */
const MAX_PER_TICK = 25;

type Dispatch = (jobId: string) => Promise<void>;

export async function runScheduleTick(deps: {
  dispatch: Dispatch;
  now?: Date;
  /** Solo para las pruebas: limita el tick a una tienda. En producción no se pasa. */
  onlyShopId?: string;
}): Promise<TickResult> {
  const now = deps.now ?? new Date();
  const out: TickResult = {
    revisadas: 0,
    iniciadas: [],
    terminadas: [],
    limpiadas: [],
    avisos: [],
    despertados: 0,
  };

  const candidatas = await prisma.campaign.findMany({
    where: {
      ...(deps.onlyShopId ? { shopId: deps.onlyShopId } : {}),
      OR: [
        { autoStart: true, startsAt: { lte: now } },
        { autoEnd: true, endsAt: { lte: now } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: MAX_PER_TICK,
    select: {
      id: true,
      shopId: true,
      type: true,
      status: true,
      startsAt: true,
      endsAt: true,
      autoStart: true,
      autoEnd: true,
      activeJobId: true,
      config: true,
      shop: { select: { plan: true } },
    },
  });
  out.revisadas = candidatas.length;

  for (const c of candidatas) {
    // Una campaña que falla no puede tumbar el tick de las demás.
    try {
      const accion = dueAction(c, now);
      if (!accion) continue;

      if (accion === "clear-start") {
        await prisma.campaign.update({ where: { id: c.id }, data: { autoStart: false } });
        out.limpiadas.push(c.id);
        continue;
      }
      if (accion === "clear-end") {
        await prisma.campaign.update({ where: { id: c.id }, data: { autoEnd: false } });
        out.limpiadas.push(c.id);
        continue;
      }
      if (accion === "expired") {
        const nota = "No se activó: cuando llegó la hora de inicio la fecha de fin ya había pasado.";
        await prisma.campaign.update({
          where: { id: c.id },
          data: { autoStart: false, autoEnd: false, scheduleNote: nota },
        });
        out.avisos.push({ campaignId: c.id, nota });
        continue;
      }

      if (accion === "end") {
        // Pausar = el mismo REVERT que lanza el botón Pausar, para cualquier tipo.
        const { job, created } = await createJob({
          campaignId: c.id,
          shopId: c.shopId,
          operation: "REVERT",
          payload: { scheduled: "end" },
        });
        await prisma.campaign.update({
          where: { id: c.id },
          data: { autoEnd: false, scheduleNote: "Se pausó sola al llegar su fecha de fin." },
        });
        if (created) await deps.dispatch(job.id);
        out.terminadas.push(c.id);
        continue;
      }

      // accion === "start"
      const nota = await iniciar(c, deps.dispatch);
      if (nota) {
        await prisma.campaign.update({
          where: { id: c.id },
          data: { autoStart: false, scheduleNote: nota },
        });
        out.avisos.push({ campaignId: c.id, nota });
      } else {
        out.iniciadas.push(c.id);
      }
    } catch (err) {
      console.error(`[schedule] fallo con la campaña ${c.id}:`, err);
    }
  }

  await anotarArranquesFallidos(now, out, deps.onlyShopId);
  out.despertados = await despertarColgados(deps.dispatch, now, deps.onlyShopId);
  return out;
}

/** Arranca una campaña programada. Devuelve un aviso si NO pudo, o null si arrancó. */
async function iniciar(
  c: {
    id: string;
    shopId: string;
    type: string;
    config: unknown;
    shop: { plan: string };
  },
  dispatch: Dispatch
): Promise<string | null> {
  const plan = (c.shop.plan as Plan) in PLAN_LIMITS ? (c.shop.plan as Plan) : "FREE";
  const limits = PLAN_LIMITS[plan];

  const activas = await getActiveCampaignCount(c.shopId);
  if (activas >= limits.campaigns)
    return `No se activó a la hora programada: tu plan admite ${limits.campaigns} campañas activas y ya tienes ${activas}. Pausa una y actívala desde aquí.`;

  if (!PRICE_TYPES.has(c.type)) {
    // Los descuentos de Shopify (BxGy, escalonado, pack, carrito, cupón) se crean
    // ya con su fecha y Shopify los enciende solo: aquí no debería llegar ninguno.
    return "No se activó sola: este tipo de campaña se programa al crearla. Actívala desde aquí.";
  }

  const cfg = (c.config ?? {}) as { pendingApply?: PendingApply };
  const pendiente = cfg.pendingApply;
  const filas = await prisma.campaignProduct.count({ where: { campaignId: c.id } });

  if (!pendiente && filas === 0)
    return "No se activó sola: la campaña no tiene productos guardados. Edítala y vuelve a programarla.";

  const usadas = await getVariantCount(c.shopId);
  const restantes = limits.variants - usadas;

  if (pendiente) {
    // Selección guardada al programar: se aplica desde cero. Las filas viejas (de
    // una activación anterior, ya revertida) dejan de valer.
    const { job, created } = await createJob({
      campaignId: c.id,
      shopId: c.shopId,
      operation: "APPLY",
      payload: {
        maxVariants: restantes,
        excludedVariantIds: pendiente.excludedVariantIds ?? [],
        selection: pendiente.selection,
        scheduled: "start",
      },
    });
    if (!created) return null; // otra operación se adelantó; el motor ya trabaja
    // Solo se llega aquí con la campaña en borrador o pausada (precios en su
    // original), así que las filas viejas ya no guardan nada que devolver.
    await prisma.campaignProduct.deleteMany({ where: { campaignId: c.id } });
    await prisma.campaign.update({
      where: { id: c.id },
      data: { autoStart: false, scheduleNote: null },
    });
    await dispatch(job.id);
    return null;
  }

  // Sin selección pendiente pero con filas: es una campaña pausada que se reanuda.
  if (filas > restantes)
    return `No se activó a la hora programada: supera el límite de variantes de tu plan (${limits.variants}).`;
  const { job, created } = await createJob({
    campaignId: c.id,
    shopId: c.shopId,
    operation: "REACTIVATE",
    payload: { scheduled: "start" },
  });
  await prisma.campaign.update({
    where: { id: c.id },
    data: { autoStart: false, scheduleNote: null },
  });
  if (created) await dispatch(job.id);
  return null;
}

/**
 * Si el job de un arranque programado falló (p. ej. por el límite de variantes),
 * el motivo se copia a la campaña para que el merchant lo vea en el listado: la
 * barra ya no está y de otro modo la campaña quedaría en borrador sin explicación.
 */
async function anotarArranquesFallidos(now: Date, out: TickResult, shopId?: string): Promise<void> {
  const desde = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fallidos = await prisma.campaignJob.findMany({
    where: {
      ...(shopId ? { shopId } : {}),
      status: "FAILED",
      finishedAt: { gte: desde },
      operation: { in: ["APPLY", "REACTIVATE"] },
      payload: { path: ["scheduled"], equals: "start" },
      campaignId: { not: null },
    },
    select: { campaignId: true, lastError: true },
    take: 20,
  });
  for (const j of fallidos) {
    if (!j.campaignId) continue;
    const nota = `No se activó a la hora programada: ${j.lastError ?? "el proceso se detuvo"}`;
    const r = await prisma.campaign.updateMany({
      where: { id: j.campaignId, scheduleNote: null, status: { not: "ACTIVE" } },
      data: { scheduleNote: nota },
    });
    if (r.count > 0) out.avisos.push({ campaignId: j.campaignId, nota });
  }
}

/**
 * Tercera capa de recuperación de jobs colgados (las otras dos son el sondeo de
 * la barra y el barrido al abrir el listado). Estaba prevista desde agosto y no
 * existía porque la ruta del cron nunca se había escrito.
 */
async function despertarColgados(dispatch: Dispatch, now: Date, shopId?: string): Promise<number> {
  try {
    const colgados = await findStalledJobs({ limit: 5, shopId });
    let n = 0;
    for (const job of colgados) {
      if (!isStalled(job.status as JobStatus, job.heartbeatAt, now, LEASE_STALE_MS, job.createdAt)) continue;
      await dispatch(job.id);
      n += 1;
    }
    return n;
  } catch (err) {
    console.error("[schedule] fallo al despertar jobs colgados:", err);
    return 0;
  }
}
