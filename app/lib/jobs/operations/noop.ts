// Operación NOOP — el banco de pruebas del motor.
//
// No toca Shopify. Ni una llamada. Pero recorre EXACTAMENTE el mismo camino que
// recorrerán APPLY/REVERT en D2: fase de resolución troceada, unidades pendientes
// leídas de CampaignProduct, sellado con processedByJobId, progreso volcado por
// tandas. Por eso las pruebas de reanudación, zombis, lease y cancelación que pasan
// con NOOP dicen algo real sobre el motor, y no sobre un simulacro.
//
// Que "no pueda tocar un precio" es la característica, no una limitación: permite
// romper el motor de todas las formas imaginables sin poder dañar una tienda.

import prisma from "../../../db.server.ts";
import type { JobRecord } from "../jobs.server.ts";
import type { JobHandler, JobUnit, ResolveStep, RunUnitsResult } from "./index.ts";

export type NoopPayload = {
  /** Unidades totales a simular. */
  totalUnits?: number;
  /** Variantes por unidad — solo alimenta el texto de la barra. */
  variantsPerUnit?: number;
  /** Trabajo simulado por unidad, en ms. */
  msPerUnit?: number;
  /**
   * Revienta al llegar a esta unidad, SIEMPRE en el mismo punto. Sirve para
   * comprobar que el freno de MAX_ATTEMPTS corta el re-pateo infinito.
   */
  failAtUnit?: number;
  /** Filas creadas por página en la fase de resolución. */
  resolveChunk?: number;
};

function readPayload(job: JobRecord): Required<NoopPayload> {
  const p = (job.payload ?? {}) as NoopPayload;
  return {
    totalUnits: Math.max(0, Math.floor(p.totalUnits ?? 100)),
    variantsPerUnit: Math.max(1, Math.floor(p.variantsPerUnit ?? 1)),
    msPerUnit: Math.max(0, p.msPerUnit ?? 0),
    failAtUnit: p.failAtUnit ?? -1,
    resolveChunk: Math.max(1, Math.floor(p.resolveChunk ?? 1000)),
  };
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

/** GIDs sintéticos, marcados con el jobId para que dos jobs no colisionen. */
const productGid = (jobId: string, i: number) =>
  `gid://shopify/Product/noop-${jobId}-${i}`;
const variantGid = (jobId: string, i: number, v: number) =>
  `gid://shopify/ProductVariant/noop-${jobId}-${i}-${v}`;

export const noopHandler: JobHandler = {
  /**
   * Crea las filas de trabajo por páginas. `resolveCursor` guarda cuántas van, así
   * que si el plazo corta a mitad de la creación se retoma donde iba.
   */
  async resolveStep(job: JobRecord): Promise<ResolveStep> {
    const cfg = readPayload(job);
    const created = Number(job.resolveCursor ?? "0") || 0;
    const remaining = cfg.totalUnits - created;

    if (remaining <= 0)
      return {
        done: true,
        totalProducts: cfg.totalUnits,
        totalVariants: cfg.totalUnits * cfg.variantsPerUnit,
        resolveCursor: String(cfg.totalUnits),
      };

    const take = Math.min(cfg.resolveChunk, remaining);
    const rows: Array<{
      campaignId: string;
      shopifyProductId: string;
      shopifyVariantId: string;
    }> = [];
    for (let i = created; i < created + take; i++)
      for (let v = 0; v < cfg.variantsPerUnit; v++)
        rows.push({
          campaignId: job.campaignId,
          shopifyProductId: productGid(job.id, i),
          shopifyVariantId: variantGid(job.id, i, v),
        });

    // createMany, no upsert en bucle: aquí es donde el bucle de round-trips uno a
    // uno deja de existir, que era el problema original.
    await prisma.campaignProduct.createMany({ data: rows, skipDuplicates: true });

    const nowCreated = created + take;
    return {
      done: nowCreated >= cfg.totalUnits,
      totalProducts: cfg.totalUnits,
      totalVariants: cfg.totalUnits * cfg.variantsPerUnit,
      resolveCursor: String(nowCreated),
    };
  },

  /**
   * Lo pendiente es una CONSULTA, no un cálculo con cursor. Por eso reanudar es
   * exacto aunque el conjunto cambie entre lotes.
   */
  async pendingUnits(job: JobRecord, limit: number): Promise<JobUnit[]> {
    const rows = await prisma.campaignProduct.groupBy({
      by: ["shopifyProductId"],
      where: {
        campaignId: job.campaignId,
        shopifyProductId: { startsWith: `gid://shopify/Product/noop-${job.id}-` },
        OR: [{ processedByJobId: null }, { processedByJobId: { not: job.id } }],
      },
      _count: { _all: true },
      orderBy: { shopifyProductId: "asc" },
      take: limit,
    });
    return rows.map((r) => ({
      productId: r.shopifyProductId,
      variantCount: r._count._all,
    }));
  },

  async runUnits(job: JobRecord, units: JobUnit[]): Promise<RunUnitsResult> {
    const cfg = readPayload(job);

    if (cfg.failAtUnit >= 0) {
      const done = await prisma.campaignProduct.count({
        where: { campaignId: job.campaignId, processedByJobId: job.id },
      });
      // Revienta SIEMPRE en el mismo punto y sin haber progresado, que es el
      // escenario que debe agotar los intentos en vez de reintentarse eternamente.
      if (done >= cfg.failAtUnit)
        throw new Error(
          `[noop] fallo simulado y determinista en la unidad ${cfg.failAtUnit}`
        );
    }

    // El trabajo "real": en D2 esto es una mutación a Shopify por unidad, lanzadas
    // de CONCURRENCY en CONCURRENCY por el runner.
    await Promise.all(units.map(() => sleep(cfg.msPerUnit)));

    // El sello. Una sola escritura para toda la ola.
    await prisma.campaignProduct.updateMany({
      where: {
        campaignId: job.campaignId,
        shopifyProductId: { in: units.map((u) => u.productId) },
      },
      data: { processedByJobId: job.id },
    });

    return { succeeded: units, failures: [] };
  },

  async totalDone(job: JobRecord): Promise<{ products: number; variants: number }> {
    const variants = await prisma.campaignProduct.count({
      where: { campaignId: job.campaignId, processedByJobId: job.id },
    });
    const cfg = readPayload(job);
    return { products: Math.floor(variants / cfg.variantsPerUnit), variants };
  },

  async remaining(job: JobRecord): Promise<number> {
    const rows = await prisma.campaignProduct.groupBy({
      by: ["shopifyProductId"],
      where: {
        campaignId: job.campaignId,
        shopifyProductId: { startsWith: `gid://shopify/Product/noop-${job.id}-` },
        OR: [{ processedByJobId: null }, { processedByJobId: { not: job.id } }],
      },
    });
    return rows.length;
  },
};
