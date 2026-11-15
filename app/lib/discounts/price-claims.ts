// Una variante, una sola campaña de precio a la vez.
//
// Porcentaje y Rango no crean un descuento en Shopify: EDITAN el precio de la
// variante y guardan el precio que había para poder devolverlo. Si dos campañas
// editan la misma variante, la segunda guarda como «original» un precio que ya
// venía rebajado por la primera, y al pausar las dos el producto queda rebajado
// sin ninguna campaña activa (QA 2026-11-14, defecto H1).
//
// La regla que lo hace imposible: una variante solo puede estar TOMADA por una
// campaña de precio. La que llega después no la toca y lo dice en su fila del
// listado. Así el «original» guardado es siempre el precio real, y pausar
// devuelve siempre el precio real.
//
// Archivo puro (sin BD ni red) para poder probarlo. Lo que consulta la base
// vive en price-claims.server.ts.

/** Otra campaña de precio que hoy tiene tomada una variante. */
export type Holder = {
  campaignId: string;
  campaignName: string;
  /** Cuándo creó SU fila para esa variante. Decide quién se apiló sobre quién. */
  rowCreatedAt: Date;
};

export type RevertDecision = {
  /** ¿Se escribe en Shopify el precio original que guarda esta fila? */
  write: boolean;
  /** Campañas cuya fila debe pasar a guardar este mismo original. */
  inheritTo: Holder[];
};

/**
 * Qué hacer con UNA variante al devolver los precios de una campaña.
 *
 * - Nadie más la tiene → se restaura. Es el caso de siempre y no cambia nada.
 *
 * - La campaña que se revierte NO está activa (se elimina una pausada) y otra la
 *   tiene tomada → no se toca. Sus precios ya se devolvieron al pausarla; volver
 *   a escribirlos le pisaría el descuento a la campaña que la tiene hoy.
 *
 * - Las dos están ACTIVAS sobre la misma variante. Con la regla nueva eso ya no
 *   puede pasar: es un solape heredado de antes. Se restaura como siempre, y las
 *   campañas que se apilaron DESPUÉS (su fila es más nueva, o sea que guardaron
 *   como «original» el precio ya rebajado por ésta) heredan el original bueno.
 *   Así, cuando se pausen, también devuelven el precio real.
 */
export function decideRevert(
  selfActive: boolean,
  selfRowCreatedAt: Date,
  holders: readonly Holder[] | undefined
): RevertDecision {
  if (!holders || holders.length === 0) return { write: true, inheritTo: [] };
  if (!selfActive) return { write: false, inheritTo: [] };
  return {
    write: true,
    inheritTo: holders.filter((h) => h.rowCreatedAt.getTime() > selfRowCreatedAt.getTime()),
  };
}

// ─── Reporte para el listado ──────────────────────────────────────────────────

export type OverlapProduct = {
  /** GID del producto. */
  id: string;
  title: string | null;
  /** Cuántas variantes del producto quedaron fuera. */
  variants: number;
  /** La campaña que las tiene tomadas. */
  campaignName: string;
};

export type OverlapReport = {
  /** Total de productos que quedaron fuera (puede superar a `products.length`). */
  total: number;
  products: OverlapProduct[];
  truncated: boolean;
};

/** Tope de productos listados. El total se cuenta siempre entero. */
export const OVERLAP_REPORT_CAP = 200;

/** Suma una tanda al reporte acumulado. Un producto ya anotado no se repite. */
export function appendOverlap(
  prev: OverlapReport | null,
  items: OverlapProduct[]
): OverlapReport | null {
  if (items.length === 0) return prev;
  const ya = new Set((prev?.products ?? []).map((p) => p.id));
  const nuevos = items.filter((p) => !ya.has(p.id));
  if (nuevos.length === 0) return prev;
  const products = [...(prev?.products ?? []), ...nuevos].slice(0, OVERLAP_REPORT_CAP);
  const total = (prev?.total ?? 0) + nuevos.length;
  return { total, products, truncated: total > products.length };
}

/**
 * Lee el reporte de solapes de `Campaign.skipReport` sin fiarse de su forma.
 *
 * Vive en la clave `overlap` del mismo JSON que el reporte de descuentos
 * manuales: no hace falta columna nueva, y el código anterior —que solo mira
 * `reason`/`total`/`products`— lo ignora sin romperse.
 */
export function readOverlapReport(raw: unknown): OverlapReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = (raw as { overlap?: unknown }).overlap;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Partial<OverlapReport>;
  if (!Array.isArray(r.products)) return null;
  const products = r.products
    .filter((p) => p && typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      title: typeof p.title === "string" ? p.title : null,
      variants: typeof p.variants === "number" ? p.variants : 1,
      campaignName: typeof p.campaignName === "string" ? p.campaignName : "",
    }));
  const total = typeof r.total === "number" ? r.total : products.length;
  if (total <= 0) return null;
  return { total, products, truncated: r.truncated === true };
}

/**
 * El JSON que se guarda en `Campaign.skipReport`: el reporte de descuentos
 * manuales (si lo hay) más el de solapes (si lo hay). null = nada que guardar.
 *
 * Sin reporte manual se escribe uno vacío (`total: 0`), que `readSkipReport`
 * lee como «no hay»: es solo el sobre que lleva la clave `overlap`.
 */
export function composeSkipReport(
  manual: Record<string, unknown> | null,
  overlap: OverlapReport | null
): Record<string, unknown> | null {
  if (!manual && !overlap) return null;
  const base = manual ?? {
    reason: "manual-discount",
    total: 0,
    products: [],
    truncated: false,
    at: "",
  };
  return overlap ? { ...base, overlap } : { ...base };
}
