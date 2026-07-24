// Helpers client-safe para campañas TIERED (sin imports de servidor).

import type { Tier, TierMode } from "./tiered-calc";
import { normalizeTiers } from "./tiered-calc";

export type { Tier, TierMode };

export type TieredSelectionMode =
  | "products"
  | "collections"
  | "tags"
  | "vendors"
  | "productTypes"
  | "all";

export type TieredCampaignConfig = {
  mode: TierMode;
  tiers: Tier[];

  // Aplicabilidad — mismo vocabulario que BXGY
  selectionMode: TieredSelectionMode;
  /** Productos resueltos al activar. Vacío + selectionMode "all" = toda la tienda. */
  productIds: string[];
  /** Solo para reconstruir el formulario al editar. */
  collectionIds: string[];
  /** Tags / vendors / tipos seleccionados, según selectionMode. */
  rawItems: string[];
  excludeProductIds: string[];

  /** Texto que ve el cliente en el carrito. */
  message?: string;

  // Handles de Shopify — se llenan al activar la campaña
  shopifyDiscountId?: string;
  functionId?: string;
};

export const TIERED_METAFIELD_NAMESPACE = "$app:discountflow";
export const TIERED_METAFIELD_KEY = "tiered-config";

/**
 * Título con el que se crea el descuento en Shopify.
 *
 * ⚠️ PUNTO ÚNICO DE AJUSTE. La atribución de pedidos (webhooks/orders.create)
 * cruza `discount_applications[].title` contra esto para saber a qué campaña
 * pertenece un descuento. Si Shopify resultara mandar otra cosa en ese campo
 * —por ejemplo el `message` de la Function en vez del título del descuento—,
 * se ajusta AQUÍ y en `matchesTieredDiscountTitle`, y no hay que tocar nada más.
 *
 * (El bug de atribución de BXGY existe justamente porque este formato está
 * escrito a mano en dos archivos distintos que no coinciden.)
 */
export const TIERED_TITLE_PREFIX = "[DiscountFlow] ";

export function tieredDiscountTitle(campaignName: string): string {
  return `${TIERED_TITLE_PREFIX}${campaignName}`;
}

/** ¿Este título de `discount_applications` corresponde a esta campaña? */
export function matchesTieredDiscountTitle(
  discountApplicationTitle: string | undefined | null,
  campaignName: string
): boolean {
  if (!discountApplicationTitle) return false;
  return discountApplicationTitle.trim() === tieredDiscountTitle(campaignName).trim();
}

export const DEFAULT_TIERS: Tier[] = [
  { minQty: 1, percent: 10 },
  { minQty: 2, percent: 15 },
  { minQty: 3, percent: 20 },
];

/** Etiqueta corta para la tabla del listado de campañas. */
export function tieredDiscountLabel(config: TieredCampaignConfig): string {
  const tiers = normalizeTiers(config?.tiers);
  if (tiers.length === 0) return "—";
  const max = tiers[tiers.length - 1].percent;
  const modo = config.mode === "INCREMENTAL" ? "incremental" : "uniforme";
  return `${tiers.length} ${tiers.length === 1 ? "nivel" : "niveles"} · hasta ${max}% (${modo})`;
}

/**
 * Recorta la config a lo que la Function necesita leer del metafield.
 * Todo lo demás (colecciones, tags…) se queda solo en la base de datos.
 */
export function toFunctionConfig(config: TieredCampaignConfig) {
  return {
    mode: config.mode,
    tiers: normalizeTiers(config.tiers),
    productIds: config.selectionMode === "all" ? [] : config.productIds,
    excludeProductIds: config.excludeProductIds ?? [],
    message: config.message || "Descuento por cantidad",
  };
}
