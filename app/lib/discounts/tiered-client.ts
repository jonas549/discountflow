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
 * Título con el que se crea el descuento en el admin de Shopify.
 *
 * ⚠️ NO SIRVE PARA ATRIBUIR PEDIDOS. Comprobado con un pedido real
 * (2026-07-25): en `discount_applications[].title` Shopify NO publica este
 * título, sino el `message` de la Function —el texto que ve el comprador—,
 * que además es IDÉNTICO en todas las campañas escalonadas. La atribución
 * (webhooks/orders.create) asigna por PRODUCTOS; ver `tieredAppliesToProduct`.
 *
 * Este título sigue siendo el que el merchant ve en su lista de descuentos.
 */
export const TIERED_TITLE_PREFIX = "[DiscountFlow] ";

export function tieredDiscountTitle(campaignName: string): string {
  return `${TIERED_TITLE_PREFIX}${campaignName}`;
}

/**
 * Texto que ve el comprador y que Shopify publica como `title` de la
 * `discount_application`. El default debe seguir al de la Function
 * (`cart_lines_discounts_generate_run.ts`) o la atribución dejaría de cruzar.
 */
export const TIERED_DEFAULT_MESSAGE = "Descuento por cantidad";

export function tieredDiscountMessage(config: TieredCampaignConfig): string {
  return config?.message || TIERED_DEFAULT_MESSAGE;
}

/**
 * ¿Pudo esta campaña haber descontado una línea con este producto?
 *
 * Replica EXACTAMENTE la regla de elegibilidad de la Function: lista de
 * inclusión VACÍA = toda la tienda. No mira `selectionMode` a propósito — lo
 * que decide en el checkout es el contenido de `productIds`, no lo que dijera
 * el formulario. Así la atribución coincide con lo que de verdad pasó.
 *
 * @param productGid formato `gid://shopify/Product/123`. El webhook manda el
 *        id numérico: hay que normalizarlo antes de llamar aquí.
 */
export function tieredAppliesToProduct(
  config: TieredCampaignConfig,
  productGid: string
): boolean {
  if ((config?.excludeProductIds ?? []).includes(productGid)) return false;
  const included = config?.productIds ?? [];
  return included.length === 0 || included.includes(productGid);
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
 * Texto de la columna "Productos" del listado de campañas.
 *
 * TIERED no crea filas en `CampaignProduct` —igual que BXGY—, porque no edita
 * precios de variantes: el descuento lo calcula la Function en el carrito. Por
 * eso el `_count.products` del listado siempre da 0 y el conteo real hay que
 * sacarlo del propio config.
 *
 * ⚠️ `selectionMode === "all"` guarda `productIds` VACÍO a propósito (vacío =
 * toda la tienda para la Function), así que ahí un "0" sería justo el
 * malentendido que este helper viene a evitar.
 */
export function tieredProductsLabel(config: TieredCampaignConfig): string {
  if (config?.selectionMode === "all") return "Toda la tienda";

  const count = config?.productIds?.length ?? 0;

  // Los modos por colección / tag / vendor / tipo resuelven sus productos al
  // ACTIVAR la campaña. Un borrador todavía no los tiene: "0" haría pensar que
  // no aplica a nada, cuando en realidad aún no se ha resuelto.
  if (count === 0 && config?.selectionMode && config.selectionMode !== "products")
    return "—";

  return String(count);
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
