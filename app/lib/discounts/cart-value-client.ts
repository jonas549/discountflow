// Config, títulos y traducción al metafield de las campañas CART_VALUE.
// Sin imports de servidor: lo usan el formulario y las rutas por igual.

import {
  normalizeCartValueTiers,
  type CartValueType,
  type CartValueTier,
} from "./cart-value-calc.ts";

export type { CartValueType, CartValueTier };

export const CART_VALUE_METAFIELD_NAMESPACE = "$app:discountflow";
export const CART_VALUE_METAFIELD_KEY = "cart-value-config";

/** La marca que el widget de packs escribe en cada línea que agrega. */
export const PACK_LINE_ATTRIBUTE_REF = "_df_pack";

export type CartValueCampaignConfig = {
  valueType: CartValueType;
  tiers: CartValueTier[];
  /** Texto que ve el comprador en el carrito. */
  message?: string;

  /**
   * Campañas de PACK que, si están aplicando en el carrito, anulan ésta.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * 🔴 QUÉ PROBLEMA RESUELVE Y POR QUÉ NO ALCANZABA UNA CASILLA
   *
   * El 2026-09-05, en dev, un pack de $278 aplicó su 30% y el descuento por
   * monto de compra —que a $194,60 tenía que dar $25— no apareció. Nadie se
   * enteró: ni el comprador, ni el merchant, ni un log.
   *
   * La causa inmediata era `combinesWith`, que es BILATERAL: el pack decía
   * `orderDiscounts: false` y con eso bastaba para que Shopify descartara el
   * otro. Se arregló (ver `COMBINACION_DEL_PACK` en `pack.ts`).
   *
   * Pero arreglarlo solo deja dos comportamientos posibles: que los dos se
   * sumen, o que NO se sumen y Shopify elija uno con su propio criterio y sin
   * decírselo a nadie. Lo segundo es exactamente el fallo que se quería
   * eliminar. Así que la decisión de quién gana se sube acá, donde el merchant
   * la toma explícitamente y la Function la registra con su motivo.
   *
   * ⚠️ Solo se pueden excluir PACKS, y es una limitación real, no una etapa: una
   * línea del carrito solo lleva marca de campaña si la puso el widget de packs
   * (`_df_pack`). Una campaña escalonada, de porcentaje o de rango no marca
   * nada, así que desde dentro de la Function no hay forma de saber si está
   * aplicando. Para ésas sigue valiendo el aviso de solapamiento del
   * formulario.
   * ═════════════════════════════════════════════════════════════════════════
   */
  excludedPackCampaignIds?: string[];

  // Handles de Shopify — se llenan al activar la campaña.
  shopifyDiscountId?: string;
  functionId?: string;
};

export const CART_VALUE_TITLE_PREFIX = "[DiscountFlow] ";

export function cartValueDiscountTitle(campaignName: string): string {
  return `${CART_VALUE_TITLE_PREFIX}${campaignName}`;
}

export const CART_VALUE_DEFAULT_MESSAGE = "Descuento por monto de compra";

/**
 * El texto que ve el comprador. Sigue al de la Function
 * (`cart_lines_discounts_generate_run.ts`), que es quien lo publica de verdad.
 */
export function cartValueDiscountMessage(config: CartValueCampaignConfig): string {
  return config.message?.trim() || CART_VALUE_DEFAULT_MESSAGE;
}

export const DEFAULT_CART_VALUE_TIERS: CartValueTier[] = [
  { minSubtotal: 50000, percent: 5 },
  { minSubtotal: 100000, percent: 10 },
];

/** Resumen de una línea para el listado de campañas. */
export function cartValueLabel(config: CartValueCampaignConfig): string {
  const tiers = normalizeCartValueTiers(config.tiers, config.valueType);
  if (tiers.length === 0) return "Sin niveles";
  return tiers
    .map((t) =>
      config.valueType === "AMOUNT"
        ? `${t.minSubtotal}+ → −${t.amount}`
        : `${t.minSubtotal}+ → ${t.percent}%`
    )
    .join(" · ");
}

/** El umbral más bajo desde el que la campaña descuenta algo. */
export function cartValueMinimum(config: CartValueCampaignConfig): number {
  const tiers = normalizeCartValueTiers(config.tiers, config.valueType);
  return tiers.length ? tiers[0].minSubtotal : 0;
}

/**
 * Lo que se escribe en el metafield del descuento.
 *
 * 🔴 Es DELIBERADAMENTE distinto de la config de la campaña: acá va solo lo que
 * la Function necesita para decidir dinero. Ni el nombre, ni las fechas, ni
 * nada de presentación. Cuanto menos viaje, menos hay que mantener en sintonía
 * entre Postgres y Shopify.
 */
export function toCartValueFunctionConfig(config: CartValueCampaignConfig): {
  valueType: CartValueType;
  tiers: CartValueTier[];
  message: string;
  excludeIfPackIds: string[];
} {
  return {
    valueType: config.valueType,
    tiers: normalizeCartValueTiers(config.tiers, config.valueType),
    message: cartValueDiscountMessage(config),
    excludeIfPackIds: config.excludedPackCampaignIds ?? [],
  };
}
