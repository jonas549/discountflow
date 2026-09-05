// Config, títulos y traducción al metafield de las campañas CODE_ORIGINAL_PRICE.
// Sin imports de servidor: lo usan el formulario y las rutas por igual.

import {
  MAX_ORIGINAL_PRICE_PERCENT,
  MIN_ORIGINAL_PRICE_PERCENT,
} from "./original-price-calc.ts";

export { MAX_ORIGINAL_PRICE_PERCENT, MIN_ORIGINAL_PRICE_PERCENT };

export const ORIGINAL_PRICE_METAFIELD_NAMESPACE = "$app:discountflow";
export const ORIGINAL_PRICE_METAFIELD_KEY = "original-price-config";

export type OriginalPriceCampaignConfig = {
  /** El porcentaje del cupón. 10 = 10% sobre el precio original. */
  percent: number;
  /**
   * El código que escribe el comprador. UNO por campaña.
   *
   * Decisión de producto del 2026-09-05: nada de lotes de códigos. Si el
   * merchant quiere medir a cada influencer por separado, crea una campaña por
   * influencer — y así la analítica que ya existe, que es POR CAMPAÑA, es
   * también por influencer sin construir nada nuevo.
   */
  code: string;
  /** Texto que ve el comprador en el carrito. */
  message?: string;

  /**
   * Campañas cuya aplicación anula este cupón.
   *
   * Mismo mecanismo y mismos motivos que en `cart-value-client.ts`:
   * `combinesWith` solo ofrece "se suman" o "no se suman y Shopify elige en
   * silencio", y lo segundo es el fallo que se eliminó el 2026-09-05. La
   * decisión de quién gana la toma el merchant acá, y la Function la registra.
   *
   * ⚠️ Solo se pueden excluir PACKS: son las únicas campañas que dejan una
   * marca (`_df_pack`) en las líneas del carrito. Ver el aviso del formulario
   * para las que bloquean sin remedio.
   */
  excludedPackCampaignIds?: string[];

  // Handles de Shopify — se llenan al activar la campaña.
  shopifyDiscountId?: string;
  functionId?: string;
};

export const ORIGINAL_PRICE_TITLE_PREFIX = "[DiscountFlow] ";

export function originalPriceDiscountTitle(campaignName: string): string {
  return `${ORIGINAL_PRICE_TITLE_PREFIX}${campaignName}`;
}

export const ORIGINAL_PRICE_DEFAULT_MESSAGE = "Descuento sobre el precio original";

/**
 * El texto que ve el comprador. Sigue al de la Function
 * (`cart_lines_discounts_generate_run.ts`), que es quien lo publica de verdad.
 */
export function originalPriceDiscountMessage(
  config: OriginalPriceCampaignConfig
): string {
  return config.message?.trim() || ORIGINAL_PRICE_DEFAULT_MESSAGE;
}

/**
 * Normaliza un código como lo hace Shopify al guardarlo.
 *
 * Mayúsculas y sin espacios: el comprador lo escribe como quiera, pero lo que
 * viaja tiene que ser una sola forma. Si guardáramos "influ 10" y Shopify
 * "INFLU10", la atribución del pedido no cruzaría y el merchant vería cero
 * ventas de ese influencer sin ningún error a la vista.
 */
export function normalizeDiscountCode(raw: string): string {
  return (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/** Resumen de una línea para el listado de campañas. */
export function originalPriceLabel(config: OriginalPriceCampaignConfig): string {
  const pct = typeof config.percent === "number" ? config.percent : 0;
  return `${pct}% sobre el precio original`;
}

/**
 * Lo que se escribe en el metafield del descuento.
 *
 * 🔴 Deliberadamente distinto de la config de la campaña: acá va solo lo que la
 * Function necesita para decidir dinero. El CÓDIGO no viaja: Shopify ya sabe
 * cuál es —se lo damos al crear el descuento— y la Function nunca tiene que
 * comprobarlo. Cuanto menos viaje, menos hay que mantener en sintonía.
 */
export function toOriginalPriceFunctionConfig(
  config: OriginalPriceCampaignConfig
): {
  percent: number;
  message: string;
  excludeIfPackIds: string[];
} {
  return {
    percent: config.percent,
    message: originalPriceDiscountMessage(config),
    excludeIfPackIds: config.excludedPackCampaignIds ?? [],
  };
}
