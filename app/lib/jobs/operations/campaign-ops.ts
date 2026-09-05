// Operaciones reales: APPLY, REACTIVATE, REVERT y DELETE.
//
// ─────────────────────────────────────────────────────────────────────────────
//  Cómo se descompone el trabajo
//
//  PERCENTAGE y RANGE → una unidad = UN PRODUCTO = una mutación
//    productVariantsBulkUpdate. Las filas de CampaignProduct son a la vez el plan
//    de trabajo, el almacén de los precios originales y el registro de lo hecho
//    (processedByJobId). Reanudar es una consulta, no un cálculo.
//
//  BXGY y TIERED → una unidad ÚNICA: activar, desactivar o borrar un descuento
//    automático es UNA mutación. No crean filas de CampaignProduct (decisión de
//    julio: su lista de productos vive en el metafield). Pasan por el mismo motor
//    para que la UI sea idéntica, y terminan en el primer lote.
//
//  PACK se comporta igual que BXGY y TIERED: su descuento es un objeto único en
//  Shopify, así que activar / pausar / eliminar son una sola mutación.
//
//  🔸 HUECO CONOCIDO (D3): CREAR una campaña BxGy, TIERED o PACK sigue por el camino
//     síncrono antiguo y no tiene barra. Crear un TIERED de "toda la tienda" en un
//     catálogo enorme resuelve ~80 páginas de Shopify sin sitio donde acumular los
//     GIDs entre lotes, porque TIERED no usa CampaignProduct. Requiere decidir
//     entre acumular en el payload del job o usar CampaignProduct como borrador.
//     Se dejó fuera a propósito para no tocar tiered.ts —el archivo que despliega
//     la Function— en la misma entrega que reescribe la ruta de precios.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import prisma from "../../../db.server.ts";
import { bulkUpdateVariantPrices } from "../../shopify/admin-api.ts";
import {
  parseCursor,
  resolveNextPage,
  serializeCursor,
  type PagedSelection,
} from "../../shopify/paged-resolve.server.ts";
import type { TieredCampaignConfig } from "../../discounts/tiered-client.ts";
import type { PackCampaignConfig } from "../../discounts/pack-client.ts";
import type { CartValueCampaignConfig } from "../../discounts/cart-value-client.ts";
import type { OriginalPriceCampaignConfig } from "../../discounts/original-price-client.ts";

// bxgy.ts y tiered.ts se cargan de forma DINÁMICA, no con un import estático.
//
// Ambos importan `../db` sin extensión y `tiered-client` como directorio, formas
// que Vite resuelve pero que el resolvedor ESM de Node rechaza. Con un import
// estático, el simple hecho de cargar este archivo reventaría la batería de tests
// —que corre con el runner nativo de Node— aunque el test no llegara a tocar una
// campaña BxGy. Cargarlos solo cuando de verdad hacen falta mantiene testeable
// toda la ruta de precios, que es donde está el volumen y el riesgo.
//
// La alternativa era añadir extensiones a esos dos archivos, pero tiered.ts queda
// deliberadamente fuera de esta entrega.
const bxgyOps = () => import("../../discounts/bxgy.ts");
const tieredOps = () => import("../../discounts/tiered.ts");
const packOps = () => import("../../discounts/pack.ts");
// Mismo motivo que los tres de arriba: importa `../db` sin extension.
const packWidget = () => import("../../discounts/pack-widget-metafield.server.ts");
const cartValueOps = () => import("../../discounts/cart-value.ts");
const cuponOps = () => import("../../discounts/original-price.ts");
import { JobFatalError } from "../errors.ts";
import { applyPercentCents, centsToString, toCents } from "../money.ts";
import type {
  JobHandler,
  JobUnit,
  OpContext,
  ResolveStep,
  RunUnitsResult,
} from "./index.ts";

/** Igual que en range.ts: por debajo de esto no se baja un precio. */
const MIN_PRICE_CENTS = 100; // 1,00

const isPriceType = (t: string) => t === "PERCENTAGE" || t === "RANGE";

// ─── Config ───────────────────────────────────────────────────────────────────

type PercentageConfig = {
  discountPercent: number;
  showCompareAtPrice?: boolean;
};
type RangeConfig = { mode: "fixedPrice" | "fixedAmount"; value: number };

export type ApplyPayload = {
  /** Cuota de variantes libre en el plan. Si se supera, el job muere.  */
  maxVariants?: number;
  /** Variantes que el merchant excluyó explícitamente. */
  excludedVariantIds?: string[];
  /** Selección a resolver. Solo la usa APPLY. */
  selection?: PagedSelection;
  /**
   * Acota el trabajo a las filas selladas por OTRO job.
   *
   * Lo usa el REVERT compensatorio que se encola al cancelar un APPLY: solo hay
   * que devolver a su precio original lo que ese APPLY llegó a tocar. Sin esto se
   * recorrería el catálogo entero —inofensivo pero lentísimo— para deshacer un 5 %.
   */
  onlyStampedBy?: string;
};

const payloadOf = (ctx: OpContext): ApplyPayload =>
  (ctx.job.payload ?? {}) as ApplyPayload;

/** Filas que este job todavía no ha sellado, opcionalmente acotadas. */
function pendingWhere(ctx: OpContext) {
  const only = payloadOf(ctx).onlyStampedBy;
  return {
    campaignId: ctx.campaign.id,
    ...(only
      ? { processedByJobId: only }
      : {
          OR: [
            { processedByJobId: null },
            { processedByJobId: { not: ctx.job.id } },
          ],
        }),
  };
}

/**
 * Precio que le toca a una variante al APLICAR el descuento.
 *
 * Devuelve null cuando la variante NO debe recibirlo — el caso de RANGE en que el
 * precio nuevo no supondría rebaja. Es la misma regla que range.ts:104-118, y por
 * eso esas variantes tampoco llegan a crear fila de CampaignProduct.
 */
function priceFor(
  type: string,
  config: unknown,
  originalPrice: number,
  originalCompareAtPrice: number | null
): { price: string; compareAtPrice: string | null } | null {
  if (type === "PERCENTAGE") {
    const cfg = config as PercentageConfig;
    const base =
      cfg.showCompareAtPrice && originalCompareAtPrice !== null
        ? originalCompareAtPrice
        : originalPrice;
    // En centavos: `base * (1 - pct/100)` en coma flotante se queda corto justo en
    // el medio centavo. 45,50 al 15 % vale 38,675, pero el float más cercano es
    // 38,674999999999997158, así que toFixed(2) daba 38,67 en vez de 38,68.
    const nextCents = applyPercentCents(toCents(base), cfg.discountPercent);
    return { price: centsToString(nextCents), compareAtPrice: centsToString(toCents(base)) };
  }

  const cfg = config as RangeConfig;
  if (cfg.mode === "fixedPrice") {
    if (cfg.value >= originalPrice) return null;
    return {
      price: centsToString(toCents(cfg.value)),
      compareAtPrice: centsToString(toCents(originalPrice)),
    };
  }
  const nextCents = toCents(originalPrice) - toCents(cfg.value);
  if (nextCents < MIN_PRICE_CENTS) return null;
  return {
    price: centsToString(nextCents),
    compareAtPrice: centsToString(toCents(originalPrice)),
  };
}

// ─── Unidades sobre CampaignProduct (PERCENTAGE / RANGE) ──────────────────────

async function pendingPriceUnits(
  ctx: OpContext,
  limit: number
): Promise<JobUnit[]> {
  const rows = await prisma.campaignProduct.groupBy({
    by: ["shopifyProductId"],
    where: pendingWhere(ctx),
    _count: { _all: true },
    orderBy: { shopifyProductId: "asc" },
    take: limit,
  });
  return rows.map((r) => ({
    productId: r.shopifyProductId,
    variantCount: r._count._all,
  }));
}

async function donePriceUnits(
  ctx: OpContext
): Promise<{ products: number; variants: number }> {
  // COUNT(DISTINCT) en una sola consulta agregada: con 20.000 filas, traerse los
  // grupos para contarlos en JS sería un escaneo completo en cada volcado.
  const rows = await prisma.$queryRaw<Array<{ products: bigint; variants: bigint }>>`
    SELECT COUNT(DISTINCT "shopifyProductId") AS products, COUNT(*) AS variants
      FROM "CampaignProduct"
     WHERE "campaignId" = ${ctx.campaign.id}
       AND "processedByJobId" = ${ctx.job.id}
  `;
  return {
    products: Number(rows[0]?.products ?? 0),
    variants: Number(rows[0]?.variants ?? 0),
  };
}

async function remainingPriceUnits(ctx: OpContext): Promise<number> {
  const groups = await prisma.campaignProduct.groupBy({
    by: ["shopifyProductId"],
    where: pendingWhere(ctx),
  });
  return groups.length;
}

/**
 * Ejecuta una ola de productos contra Shopify y los sella.
 *
 * ⚠️ El sello se pone SIEMPRE, también cuando la mutación falla. Suena raro, pero
 * es deliberado y replica el comportamiento del camino síncrono
 * (percentage.ts:176): un producto que falla se anota y el bucle sigue. Si un
 * producto que falla siempre no se sellara, `remaining` nunca llegaría a cero y el
 * job daría vueltas hasta agotar sus intentos. El merchant acaba con
 * COMPLETED_WITH_ERRORS y la lista exacta de lo que no se pudo aplicar.
 */
async function runPriceUnits(
  ctx: OpContext,
  units: JobUnit[],
  mode: "apply" | "revert"
): Promise<RunUnitsResult> {
  const productIds = units.map((u) => u.productId);
  const rows = await prisma.campaignProduct.findMany({
    where: { campaignId: ctx.campaign.id, shopifyProductId: { in: productIds } },
  });

  const byProduct = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byProduct.has(r.shopifyProductId)) byProduct.set(r.shopifyProductId, []);
    byProduct.get(r.shopifyProductId)!.push(r);
  }

  const failures: RunUnitsResult["failures"] = [];

  // En paralelo: el runner ya limita la ola a CONCURRENCY unidades, que es lo
  // calibrado contra el presupuesto de puntos de Shopify.
  await Promise.all(
    units.map(async (unit) => {
      const productRows = byProduct.get(unit.productId) ?? [];
      const updates = productRows
        .filter((r) => r.shopifyVariantId !== null)
        .map((r) => {
          const orig = Number(r.originalPrice ?? 0);
          const origCompare =
            r.originalCompareAtPrice !== null ? Number(r.originalCompareAtPrice) : null;

          if (mode === "revert")
            return {
              id: r.shopifyVariantId!,
              price: r.originalPrice?.toString() ?? "0",
              compareAtPrice: r.originalCompareAtPrice?.toString() ?? null,
            };

          const next = priceFor(ctx.campaign.type, ctx.campaign.config, orig, origCompare);
          // null = esta variante no cumple la regla de rebaja. Se devuelve a su
          // precio original para no dejarla a medio camino.
          return next
            ? { id: r.shopifyVariantId!, price: next.price, compareAtPrice: next.compareAtPrice }
            : {
                id: r.shopifyVariantId!,
                price: orig.toFixed(2),
                compareAtPrice: origCompare !== null ? origCompare.toFixed(2) : null,
              };
        });

      if (updates.length > 0) {
        try {
          await bulkUpdateVariantPrices(ctx.admin, unit.productId, updates);
        } catch (err) {
          failures.push({
            unit: unit.productId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })
  );

  // ── El sellado ────────────────────────────────────────────────────────────
  // 🔴 Antes se sellaba el lote ENTERO sin mirar el resultado. Como el sello es el
  // mecanismo de reanudación (`pendingUnits` descarta lo sellado), una unidad que
  // había fallado quedaba marcada como hecha y NO se reintentaba nunca dentro del
  // job. En un APPLY eso deja un producto sin descuento; en un REVERT deja un
  // producto REBAJADO mientras el sistema da por hecho que lo devolvió, que es
  // exactamente el sangrado silencioso que este motor existe para evitar.
  //
  // Ahora se sellan las que salieron bien. Las que fallaron se dejan sin sellar
  // para que el siguiente lote las reintente —salvo que ya vinieran fallando de
  // antes, en cuyo caso se sellan igual: sin ese tope, una unidad que falla
  // siempre haría que el job encadenase lotes indefinidamente, y agotar la cuota
  // de invocaciones en Hobby apaga el servicio hasta 30 días.
  const failedNow = new Set(failures.map((f) => f.unit));
  const failedBefore = new Set(
    (Array.isArray(ctx.job.errors) ? ctx.job.errors : [])
      .map((e) => (e as { unit?: string })?.unit)
      .filter((u): u is string => typeof u === "string")
  );
  const toSeal = productIds.filter((id) => !failedNow.has(id) || failedBefore.has(id));

  if (toSeal.length > 0)
    await prisma.campaignProduct.updateMany({
      where: { campaignId: ctx.campaign.id, shopifyProductId: { in: toSeal } },
      data: { processedByJobId: ctx.job.id },
    });

  return { succeeded: units.filter((u) => !failedNow.has(u.productId)), failures };
}

// ─── Unidad única (BXGY / TIERED / PACK) ──────────────────────────────────────
//
// No hay filas que sellar, así que la marca de "hecho" va en resolveCursor, un
// campo de texto libre que estos tipos no usan para nada más.

const SINGLE_DONE = "unit-done";
const singleUnit: JobUnit = { productId: "discount", variantCount: 1 };

const singlePending = async (ctx: OpContext): Promise<JobUnit[]> =>
  ctx.job.resolveCursor === SINGLE_DONE ? [] : [singleUnit];

const singleDone = async (ctx: OpContext) =>
  ctx.job.resolveCursor === SINGLE_DONE
    ? { products: 1, variants: 1 }
    : { products: 0, variants: 0 };

const singleRemaining = async (ctx: OpContext) =>
  ctx.job.resolveCursor === SINGLE_DONE ? 0 : 1;

async function markSingleDone(ctx: OpContext): Promise<void> {
  await prisma.campaignJob.update({
    where: { id: ctx.job.id },
    data: { resolveCursor: SINGLE_DONE },
  });
  ctx.job.resolveCursor = SINGLE_DONE;
}

function discountIdOf(ctx: OpContext): string | null {
  const cfg = ctx.campaign.config as { shopifyDiscountId?: string } | null;
  return cfg?.shopifyDiscountId ?? null;
}

/** Sin resolución que hacer: se pasa directo a la fase de trabajo. */
const noResolve = async (ctx: OpContext): Promise<ResolveStep> => ({
  done: true,
  totalProducts: ctx.job.totalProducts,
  totalVariants: ctx.job.totalVariants,
  resolveCursor: ctx.job.resolveCursor,
});

/** Totales para BXGY/TIERED: siempre una unidad. */
const singleResolve = async (ctx: OpContext): Promise<ResolveStep> => ({
  done: true,
  totalProducts: 1,
  totalVariants: 1,
  resolveCursor: ctx.job.resolveCursor,
});

// ─── APPLY ────────────────────────────────────────────────────────────────────

export const applyHandler: JobHandler = {
  /**
   * Resuelve la selección PÁGINA A PÁGINA y va creando las filas de trabajo con
   * los precios originales dentro.
   *
   * 🔒 Invariante que no se puede romper: los precios originales quedan escritos
   *    ANTES de que se toque un solo precio en Shopify. Aquí se refuerza respecto
   *    al camino antiguo, porque toda la resolución termina antes de que empiece
   *    la fase de mutaciones. La información para revertir no puede perderse por
   *    una interrupción, pase lo que pase.
   */
  async resolveStep(ctx: OpContext): Promise<ResolveStep> {
    if (!isPriceType(ctx.campaign.type)) return singleResolve(ctx);

    const payload = payloadOf(ctx);
    const selection = payload.selection;
    if (!selection)
      throw new JobFatalError("La campaña no trae una selección de productos que resolver.");

    const excluded = new Set(payload.excludedVariantIds ?? []);
    const cursor = parseCursor(ctx.job.resolveCursor);
    const page = await resolveNextPage(ctx.admin, selection, cursor);

    const rows: Prisma.CampaignProductCreateManyInput[] = [];
    for (const { productId, variants } of page.batch) {
      for (const v of variants) {
        if (excluded.has(v.id)) continue;
        const orig = parseFloat(v.price);
        const origCompare = v.compareAtPrice ? parseFloat(v.compareAtPrice) : null;
        // Las variantes que no cumplen la regla de rebaja (RANGE) no entran, igual
        // que en el camino síncrono: ni fila, ni mutación, ni cuota consumida.
        if (!priceFor(ctx.campaign.type, ctx.campaign.config, orig, origCompare)) continue;
        rows.push({
          campaignId: ctx.campaign.id,
          shopifyProductId: productId,
          shopifyVariantId: v.id,
          originalPrice: new Prisma.Decimal(orig),
          originalCompareAtPrice:
            origCompare !== null ? new Prisma.Decimal(origCompare) : null,
        });
      }
    }

    if (rows.length > 0)
      await prisma.campaignProduct.createMany({ data: rows, skipDuplicates: true });

    const totals = await prisma.$queryRaw<Array<{ products: bigint; variants: bigint }>>`
      SELECT COUNT(DISTINCT "shopifyProductId") AS products, COUNT(*) AS variants
        FROM "CampaignProduct" WHERE "campaignId" = ${ctx.campaign.id}
    `;
    const totalVariants = Number(totals[0]?.variants ?? 0);
    const totalProducts = Number(totals[0]?.products ?? 0);

    // ENFORCEMENT DE PLAN. Se comprueba durante la RESOLUCIÓN, o sea antes de la
    // primera mutación: abortar aquí no deja ni un precio tocado en Shopify, que
    // es la misma garantía del camino síncrono (percentage.ts:110-120).
    if (payload.maxVariants !== undefined && totalVariants > payload.maxVariants)
      throw new JobFatalError(
        `La selección alcanza ${totalVariants.toLocaleString("es-CL")} variantes y tu plan admite ` +
          `${payload.maxVariants.toLocaleString("es-CL")}. No se ha modificado ningún precio.`,
        { planLimit: true }
      );

    return {
      done: page.next === null,
      totalProducts,
      totalVariants,
      resolveCursor: page.next === null ? null : serializeCursor(page.next),
    };
  },

  pendingUnits: (ctx, limit) =>
    isPriceType(ctx.campaign.type) ? pendingPriceUnits(ctx, limit) : singlePending(ctx),

  async runUnits(ctx, units) {
    if (isPriceType(ctx.campaign.type)) return runPriceUnits(ctx, units, "apply");
    await markSingleDone(ctx);
    return { succeeded: units, failures: [] };
  },

  totalDone: (ctx) => (isPriceType(ctx.campaign.type) ? donePriceUnits(ctx) : singleDone(ctx)),
  remaining: (ctx) =>
    isPriceType(ctx.campaign.type) ? remainingPriceUnits(ctx) : singleRemaining(ctx),

  async finalize(ctx) {
    await prisma.campaign.update({
      where: { id: ctx.campaign.id },
      data: { status: "ACTIVE" },
    });
  },
};

// ─── REACTIVATE ───────────────────────────────────────────────────────────────

export const reactivateHandler: JobHandler = {
  resolveStep: (ctx) => (isPriceType(ctx.campaign.type) ? noResolveWithTotals(ctx) : singleResolve(ctx)),
  pendingUnits: (ctx, limit) =>
    isPriceType(ctx.campaign.type) ? pendingPriceUnits(ctx, limit) : singlePending(ctx),

  async runUnits(ctx, units) {
    if (isPriceType(ctx.campaign.type)) return runPriceUnits(ctx, units, "apply");

    const id = discountIdOf(ctx);
    if (!id) throw new JobFatalError("La campaña no tiene un descuento de Shopify asociado.");

    if (ctx.campaign.type === "TIERED") {
      // Se reescribe la configuración antes de activar: migra metafields legados
      // (sin `scope`) y re-resuelve la colección para que refleje la de HOY. Sin
      // esto, la puerta de seguridad de la Function dejaría la campaña activa y
      // sin descontar, en silencio. Misma lógica que el listado ya hacía.
      const t = await tieredOps();
      await t.updateTieredDiscount(
        ctx.admin,
        id,
        ctx.campaign.id,
        ctx.campaign.name,
        ctx.campaign.config as TieredCampaignConfig,
        ctx.campaign.startsAt,
        ctx.campaign.endsAt
      );
      await t.activateTieredDiscount(ctx.admin, id);
    } else if (ctx.campaign.type === "PACK") {
      // Igual que TIERED: se reescribe el metafield antes de activar, para que
      // el descuento refleje lo último que guardó el merchant y no la
      // configuración con la que se creó.
      const pk = await packOps();
      await pk.updatePackDiscount(
        ctx.admin,
        ctx.campaign.id,
        ctx.campaign.name,
        id,
        ctx.campaign.config as PackCampaignConfig,
        ctx.campaign.startsAt,
        ctx.campaign.endsAt
      );
      await pk.activatePackDiscount(ctx.admin, id);
      await (await packWidget()).sincronizarMetafieldDeWidget(ctx.admin, ctx.campaign.shopId);
    } else if (ctx.campaign.type === "CART_VALUE") {
      // Igual que TIERED y PACK: se reescribe el metafield antes de activar,
      // para que el descuento refleje lo ultimo que guardo el merchant.
      const cv = await cartValueOps();
      await cv.updateCartValueDiscount(
        ctx.admin,
        ctx.campaign.id,
        ctx.campaign.name,
        id,
        ctx.campaign.config as CartValueCampaignConfig,
        ctx.campaign.startsAt,
        ctx.campaign.endsAt
      );
      await cv.activateCartValueDiscount(ctx.admin, id);
    } else if (ctx.campaign.type === "CODE_ORIGINAL_PRICE") {
      // Igual que los otros tres: se reescribe la configuracion antes de
      // activar, para que el descuento refleje lo ultimo que guardo el merchant
      // y no lo que habia cuando se creo. Aca ademas eso incluye el CODIGO, que
      // el merchant puede haber cambiado mientras la campana estaba pausada.
      const cp = await cuponOps();
      await cp.updateOriginalPriceDiscount(
        ctx.admin,
        ctx.campaign.id,
        ctx.campaign.name,
        id,
        ctx.campaign.config as OriginalPriceCampaignConfig,
        ctx.campaign.startsAt,
        ctx.campaign.endsAt
      );
      await cp.activateOriginalPriceDiscount(ctx.admin, id);
    } else {
      await (await bxgyOps()).activateBxgyDiscount(ctx.admin, id);
    }
    await markSingleDone(ctx);
    return { succeeded: units, failures: [] };
  },

  totalDone: (ctx) => (isPriceType(ctx.campaign.type) ? donePriceUnits(ctx) : singleDone(ctx)),
  remaining: (ctx) =>
    isPriceType(ctx.campaign.type) ? remainingPriceUnits(ctx) : singleRemaining(ctx),

  async finalize(ctx) {
    await prisma.campaign.update({
      where: { id: ctx.campaign.id },
      data: { status: "ACTIVE" },
    });
  },
};

// ─── REVERT (pausar) ──────────────────────────────────────────────────────────

export const revertHandler: JobHandler = {
  resolveStep: (ctx) => (isPriceType(ctx.campaign.type) ? noResolveWithTotals(ctx) : singleResolve(ctx)),
  pendingUnits: (ctx, limit) =>
    isPriceType(ctx.campaign.type) ? pendingPriceUnits(ctx, limit) : singlePending(ctx),

  async runUnits(ctx, units) {
    if (isPriceType(ctx.campaign.type)) return runPriceUnits(ctx, units, "revert");

    const id = discountIdOf(ctx);
    if (!id) throw new JobFatalError("La campaña no tiene un descuento de Shopify asociado.");
    if (ctx.campaign.type === "TIERED")
      await (await tieredOps()).deactivateTieredDiscount(ctx.admin, id);
    else if (ctx.campaign.type === "PACK") {
      await (await packOps()).deactivatePackDiscount(ctx.admin, id);
      await (await packWidget()).sincronizarMetafieldDeWidget(ctx.admin, ctx.campaign.shopId);
    } else if (ctx.campaign.type === "CART_VALUE")
      await (await cartValueOps()).deactivateCartValueDiscount(ctx.admin, id);
    else if (ctx.campaign.type === "CODE_ORIGINAL_PRICE")
      await (await cuponOps()).deactivateOriginalPriceDiscount(ctx.admin, id);
    else await (await bxgyOps()).deactivateBxgyDiscount(ctx.admin, id);
    await markSingleDone(ctx);
    return { succeeded: units, failures: [] };
  },

  totalDone: (ctx) => (isPriceType(ctx.campaign.type) ? donePriceUnits(ctx) : singleDone(ctx)),
  remaining: (ctx) =>
    isPriceType(ctx.campaign.type) ? remainingPriceUnits(ctx) : singleRemaining(ctx),

  async finalize(ctx) {
    await prisma.campaign.update({
      where: { id: ctx.campaign.id },
      data: { status: "PAUSED" },
    });
  },
};

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const deleteHandler: JobHandler = {
  resolveStep: (ctx) => (isPriceType(ctx.campaign.type) ? noResolveWithTotals(ctx) : singleResolve(ctx)),
  pendingUnits: (ctx, limit) =>
    isPriceType(ctx.campaign.type) ? pendingPriceUnits(ctx, limit) : singlePending(ctx),

  async runUnits(ctx, units) {
    // Borrar es revertir y luego quitar: los precios vuelven a su original ANTES
    // de que desaparezca el registro que los guarda. Al revés, un fallo a mitad
    // dejaría precios rebajados sin forma de saber cuáles eran los originales.
    if (isPriceType(ctx.campaign.type)) return runPriceUnits(ctx, units, "revert");

    const id = discountIdOf(ctx);
    if (id) {
      try {
        if (ctx.campaign.type === "TIERED")
          await (await tieredOps()).deleteTieredDiscount(ctx.admin, id);
        else if (ctx.campaign.type === "PACK")
          await (await packOps()).deletePackDiscount(ctx.admin, id);
        else if (ctx.campaign.type === "CART_VALUE")
          await (await cartValueOps()).deleteCartValueDiscount(ctx.admin, id);
        else if (ctx.campaign.type === "CODE_ORIGINAL_PRICE")
          await (await cuponOps()).deleteOriginalPriceDiscount(ctx.admin, id);
        else await (await bxgyOps()).deleteBxgyDiscount(ctx.admin, id);
      } catch {
        // El descuento puede haber sido borrado ya desde el admin de Shopify.
      }
    }
    // Tambien cuando el descuento ya no estaba: del metafield hay que quitar la
    // campana, no el descuento.
    if (ctx.campaign.type === "PACK")
      await (await packWidget()).sincronizarMetafieldDeWidget(ctx.admin, ctx.campaign.shopId);
    await markSingleDone(ctx);
    return { succeeded: units, failures: [] };
  },

  totalDone: (ctx) => (isPriceType(ctx.campaign.type) ? donePriceUnits(ctx) : singleDone(ctx)),
  remaining: (ctx) =>
    isPriceType(ctx.campaign.type) ? remainingPriceUnits(ctx) : singleRemaining(ctx),

  /**
   * El borrado va aquí y no en runUnits: la cascada de Campaign se lleva por
   * delante sus CampaignProduct y su propio CampaignJob. Hacerlo antes de tiempo
   * borraría el job mientras se está ejecutando.
   *
   * El runner llama a finalize ANTES de marcar el job terminado, así que la fila
   * del job desaparece con la campaña. Es correcto: la operación fue un borrado y
   * no queda nada a lo que volver.
   */
  async finalize(ctx) {
    await prisma.campaign.delete({ where: { id: ctx.campaign.id } });
  },
};

// ─── Auxiliar ─────────────────────────────────────────────────────────────────

/**
 * Sin fase de resolución, pero fijando los totales: REACTIVATE, REVERT y DELETE
 * trabajan sobre filas que YA existen, así que el denominador de la barra se sabe
 * de entrada con una sola consulta.
 */
async function noResolveWithTotals(ctx: OpContext): Promise<ResolveStep> {
  const totals = await prisma.$queryRaw<Array<{ products: bigint; variants: bigint }>>`
    SELECT COUNT(DISTINCT "shopifyProductId") AS products, COUNT(*) AS variants
      FROM "CampaignProduct" WHERE "campaignId" = ${ctx.campaign.id}
  `;
  return {
    done: true,
    totalProducts: Number(totals[0]?.products ?? 0),
    totalVariants: Number(totals[0]?.variants ?? 0),
    resolveCursor: null,
  };
}

void noResolve;
