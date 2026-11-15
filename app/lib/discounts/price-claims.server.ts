// Una variante, una sola campaña de precio a la vez — la parte que toca la base.
//
// La regla y el porqué están en price-claims.ts. Aquí viven las tres operaciones
// que la hacen cumplir:
//
//   claimRows          APLICAR: crea las filas de trabajo solo para las variantes
//                      que no tiene tomadas otra campaña.
//   releaseHeldRows    REACTIVAR: suelta las filas propias cuya variante tomó otra
//                      campaña mientras ésta estaba pausada.
//   buildRevertPlan    PAUSAR / ELIMINAR: decide, variante por variante, si se
//                      restaura el precio y quién hereda el original.
//
// Los imports llevan extensión .ts a propósito: este módulo lo cargan Vite y el
// runner nativo de Node (la batería del motor).

import { Prisma } from "@prisma/client";
import prisma from "../../db.server.ts";
import { readSkipReport } from "./manual-discounts.ts";
import {
  appendOverlap,
  composeSkipReport,
  decideRevert,
  readOverlapReport,
  type Holder,
  type OverlapProduct,
} from "./price-claims.ts";

type Db = Prisma.TransactionClient | typeof prisma;

const TROZO = 5_000;

/**
 * Qué variantes de la lista tiene TOMADAS otra campaña de precio de la tienda.
 *
 * «Tomada» = otra campaña de Porcentaje o Rango tiene una fila para esa variante
 * y, o bien está ACTIVA (el precio de Shopify es el suyo), o bien tiene una
 * operación en curso (está aplicándolo o devolviéndolo ahora mismo: el precio
 * que hay en Shopify no es de fiar como «original»).
 *
 * Una campaña pausada o en borrador sin nada en curso NO tiene nada tomado: sus
 * precios están en el original y cualquiera puede usar esas variantes.
 */
export async function findHolders(
  db: Db,
  input: { shopId: string; campaignId: string; variantIds: string[] }
): Promise<Map<string, Holder[]>> {
  const out = new Map<string, Holder[]>();
  const ids = [...new Set(input.variantIds)];
  for (let i = 0; i < ids.length; i += TROZO) {
    const trozo = ids.slice(i, i + TROZO);
    const filas = await db.$queryRaw<
      Array<{ variantId: string; campaignId: string; campaignName: string; rowCreatedAt: Date }>
    >`
      SELECT cp."shopifyVariantId" AS "variantId",
             c."id"                AS "campaignId",
             c."name"              AS "campaignName",
             cp."createdAt"        AS "rowCreatedAt"
        FROM "CampaignProduct" cp
        JOIN "Campaign" c ON c."id" = cp."campaignId"
        LEFT JOIN "CampaignJob" j ON j."id" = c."activeJobId"
       WHERE c."shopId" = ${input.shopId}
         AND c."id" <> ${input.campaignId}
         AND c."type" IN ('PERCENTAGE', 'RANGE')
         AND cp."shopifyVariantId" = ANY(${trozo})
         AND (
               c."status" = 'ACTIVE'
            OR (j."id" IS NOT NULL
                AND j."status" NOT IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'))
         )
    `;
    for (const f of filas) {
      if (!out.has(f.variantId)) out.set(f.variantId, []);
      out.get(f.variantId)!.push({
        campaignId: f.campaignId,
        campaignName: f.campaignName,
        rowCreatedAt: new Date(f.rowCreatedAt),
      });
    }
  }
  return out;
}

/**
 * Cerrojo por TIENDA para «mirar quién tiene la variante y quedármela».
 *
 * Sin él, dos campañas que arrancan a la vez (dos programadas a la misma hora)
 * podrían mirar las dos antes de que ninguna escriba, y quedarse las dos con la
 * misma variante. El cerrojo es de transacción: se suelta solo al terminar, pase
 * lo que pase, y solo frena a otra campaña de la MISMA tienda durante lo que
 * tarda una consulta y un INSERT.
 */
function withShopPriceLock<T>(
  shopId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const llave = `discountflow:price-claim:${shopId}`;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${llave}))`;
      return fn(tx);
    },
    { timeout: 30_000, maxWait: 15_000 }
  );
}

/**
 * APLICAR: crea las filas de trabajo de las variantes libres y devuelve cuáles
 * estaban tomadas (esas no reciben fila, ni mutación, ni consumen cuota).
 */
export async function claimRows(
  shopId: string,
  campaignId: string,
  rows: Prisma.CampaignProductCreateManyInput[]
): Promise<Map<string, Holder[]>> {
  if (rows.length === 0) return new Map();
  return withShopPriceLock(shopId, async (tx) => {
    const tomadas = await findHolders(tx, {
      shopId,
      campaignId,
      variantIds: rows.map((r) => r.shopifyVariantId).filter((v): v is string => !!v),
    });
    const libres = rows.filter((r) => !r.shopifyVariantId || !tomadas.has(r.shopifyVariantId));
    if (libres.length > 0)
      await tx.campaignProduct.createMany({ data: libres, skipDuplicates: true });
    return tomadas;
  });
}

/**
 * REACTIVAR: las filas propias cuya variante tomó otra campaña mientras ésta
 * estaba pausada se sueltan (se borran). Devuelve lo soltado, por producto.
 *
 * Se borran, y no solo se saltan, para que las filas de una campaña sean siempre
 * «lo que esta campaña tiene aplicado»: si se quedaran, la próxima pausa
 * devolvería esos productos a su original y le pisaría el descuento a la otra.
 */
export async function releaseHeldRows(
  shopId: string,
  campaignId: string
): Promise<OverlapProduct[]> {
  return withShopPriceLock(shopId, async (tx) => {
    const propias = await tx.campaignProduct.findMany({
      where: { campaignId, shopifyVariantId: { not: null } },
      select: { shopifyProductId: true, shopifyVariantId: true },
    });
    if (propias.length === 0) return [];
    const tomadas = await findHolders(tx, {
      shopId,
      campaignId,
      variantIds: propias.map((p) => p.shopifyVariantId!),
    });
    if (tomadas.size === 0) return [];

    const ids = [...tomadas.keys()];
    for (let i = 0; i < ids.length; i += TROZO)
      await tx.campaignProduct.deleteMany({
        where: { campaignId, shopifyVariantId: { in: ids.slice(i, i + TROZO) } },
      });

    return overlapByProduct(
      propias
        .filter((p) => tomadas.has(p.shopifyVariantId!))
        .map((p) => ({ productId: p.shopifyProductId, title: null, variantId: p.shopifyVariantId! })),
      tomadas
    );
  });
}

/** Agrupa variantes tomadas en una entrada de reporte por producto. */
export function overlapByProduct(
  variantes: Array<{ productId: string; title: string | null; variantId: string }>,
  tomadas: Map<string, Holder[]>
): OverlapProduct[] {
  const porProducto = new Map<string, OverlapProduct>();
  for (const v of variantes) {
    const dueña = tomadas.get(v.variantId)?.[0];
    if (!dueña) continue;
    const ya = porProducto.get(v.productId);
    if (ya) ya.variants += 1;
    else
      porProducto.set(v.productId, {
        id: v.productId,
        title: v.title,
        variants: 1,
        campaignName: dueña.campaignName,
      });
  }
  return [...porProducto.values()];
}

/** Suma productos al reporte de solapes de la campaña, sin tocar el de manuales. */
export async function recordOverlap(campaignId: string, items: OverlapProduct[]): Promise<void> {
  if (items.length === 0) return;
  const actual = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { skipReport: true },
  });
  const overlap = appendOverlap(readOverlapReport(actual?.skipReport), items);
  const manual = readSkipReport(actual?.skipReport) as unknown as Record<string, unknown> | null;
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      skipReport: composeSkipReport(manual, overlap) as unknown as Prisma.InputJsonValue,
    },
  });
}

// ─── Devolver precios ─────────────────────────────────────────────────────────

type FilaARevertir = {
  shopifyVariantId: string | null;
  createdAt: Date;
  originalPrice: Prisma.Decimal | null;
  originalCompareAtPrice: Prisma.Decimal | null;
};

export type RevertPlan = {
  /** ¿Se escribe en Shopify el original de esta variante? */
  writes(variantId: string): boolean;
  /**
   * Tras restaurar con éxito estas variantes: las campañas que se habían apilado
   * encima pasan a guardar el original bueno. Sin solapes heredados no hace nada.
   */
  inherit(variantIds: string[]): Promise<void>;
};

const PLAN_DE_SIEMPRE: RevertPlan = { writes: () => true, inherit: async () => {} };

/**
 * Plan para devolver los precios de una campaña (pausar, eliminar, editar).
 *
 * Sin otra campaña que comparta variantes —el caso normal— el plan es el de
 * siempre: restaurar todo, sin escribir nada más.
 */
export async function buildRevertPlan(
  self: { shopId: string; campaignId: string; active: boolean },
  rows: FilaARevertir[]
): Promise<RevertPlan> {
  const conVariante = rows.filter((r) => r.shopifyVariantId !== null);
  if (conVariante.length === 0) return PLAN_DE_SIEMPRE;

  const tomadas = await findHolders(prisma, {
    shopId: self.shopId,
    campaignId: self.campaignId,
    variantIds: conVariante.map((r) => r.shopifyVariantId!),
  });
  if (tomadas.size === 0) return PLAN_DE_SIEMPRE;

  const noEscribir = new Set<string>();
  const herencias = new Map<
    string,
    Array<{ campaignId: string; originalPrice: Prisma.Decimal | null; originalCompareAtPrice: Prisma.Decimal | null }>
  >();
  for (const r of conVariante) {
    const id = r.shopifyVariantId!;
    const d = decideRevert(self.active, r.createdAt, tomadas.get(id));
    if (!d.write) noEscribir.add(id);
    if (d.inheritTo.length > 0)
      herencias.set(
        id,
        d.inheritTo.map((h) => ({
          campaignId: h.campaignId,
          originalPrice: r.originalPrice,
          originalCompareAtPrice: r.originalCompareAtPrice,
        }))
      );
  }

  return {
    writes: (variantId) => !noEscribir.has(variantId),
    async inherit(variantIds) {
      for (const id of variantIds)
        for (const h of herencias.get(id) ?? [])
          await prisma.campaignProduct.updateMany({
            where: { campaignId: h.campaignId, shopifyVariantId: id },
            data: {
              originalPrice: h.originalPrice,
              originalCompareAtPrice: h.originalCompareAtPrice,
            },
          });
    },
  };
}

/** Lo mismo, para los caminos síncronos, que solo conocen el id de la campaña. */
export async function buildRevertPlanFor(
  campaignId: string,
  rows: FilaARevertir[]
): Promise<RevertPlan> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { shopId: true, status: true },
  });
  if (!campaign) return PLAN_DE_SIEMPRE;
  return buildRevertPlan(
    { shopId: campaign.shopId, campaignId, active: campaign.status === "ACTIVE" },
    rows
  );
}
