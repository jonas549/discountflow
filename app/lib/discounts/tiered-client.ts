// Helpers client-safe para campañas TIERED (sin imports de servidor).

import type { Tier, TierMode, TierValueType } from "./tiered-calc.ts";
import { normalizeTiers } from "./tiered-calc.ts";

export type { Tier, TierMode, TierValueType };

export type TieredSelectionMode =
  | "products"
  | "collections"
  | "tags"
  | "vendors"
  | "productTypes"
  | "all";

/**
 * Alcance que viaja en el metafield. Es lo único que autoriza a la Function a
 * descontar todo el catálogo; sin `"all"` explícito, una lista de productos
 * vacía significa "no descuentes nada", nunca "descuéntalo todo".
 */
export type TieredScope = "all" | "selected";

export type TieredCampaignConfig = {
  mode: TierMode;
  tiers: Tier[];
  /**
   * En qué se miden los niveles: porcentaje o dinero por unidad.
   *
   * Opcional y ausente = "PERCENT". Las campañas guardadas antes de que esto
   * existiera no lo traen, y deben seguir leyéndose exactamente igual.
   */
  valueType?: TierValueType;

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
 * Replica EXACTAMENTE la regla de elegibilidad de la Function, incluida su
 * puerta de seguridad: solo una campaña de "toda la tienda" aplica sin lista;
 * si la lista está vacía sin serlo, la Function no descuenta nada, así que
 * aquí tampoco se le puede atribuir nada.
 *
 * Mantener las dos reglas en sintonía es lo que hace que Analytics refleje lo
 * que de verdad pasó en el checkout. Si divergen, la atribución miente.
 *
 * @param productGid formato `gid://shopify/Product/123`. El webhook manda el
 *        id numérico: hay que normalizarlo antes de llamar aquí.
 */
export function tieredAppliesToProduct(
  config: TieredCampaignConfig,
  productGid: string
): boolean {
  if ((config?.excludeProductIds ?? []).includes(productGid)) return false;
  if (config?.selectionMode === "all") return true;
  const included = config?.productIds ?? [];
  return included.includes(productGid);
}

export const DEFAULT_TIERS: Tier[] = [
  { minQty: 1, percent: 10 },
  { minQty: 2, percent: 15 },
  { minQty: 3, percent: 20 },
];

/** Etiqueta corta para la tabla del listado de campañas. */
export function tieredDiscountLabel(config: TieredCampaignConfig): string {
  const valueType = config?.valueType ?? "PERCENT";
  const esMonto = valueType === "AMOUNT";
  const tiers = normalizeTiers(config?.tiers, valueType);
  if (tiers.length === 0) return "—";
  // El mayor, no el último: un nivel al 0 (= "desde aquí, precio normal") puede
  // ir al final, y entonces el último no es el que más descuenta.
  const max = tiers.reduce((m, t) => {
    const v = (esMonto ? t.amount : t.percent) ?? 0;
    return v > m ? v : m;
  }, 0);
  const modo = config.mode === "INCREMENTAL" ? "incremental" : "uniforme";
  const tope = esMonto ? `$${max}` : `${max}%`;
  return `${tiers.length} ${tiers.length === 1 ? "nivel" : "niveles"} · hasta ${tope} (${modo})`;
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
 *
 * `scope` es el campo que autoriza descontar todo el catálogo. Va explícito
 * justamente para que la Function NUNCA tenga que deducirlo de una lista
 * vacía: ver el bloque de seguridad en `cart_lines_discounts_generate_run.ts`.
 */
export function toFunctionConfig(config: TieredCampaignConfig) {
  const scope: TieredScope = config.selectionMode === "all" ? "all" : "selected";
  const valueType = config.valueType ?? "PERCENT";
  return {
    mode: config.mode,
    // Se emite SIEMPRE, también en las campañas de porcentaje. Un metafield que
    // lo lleva explícito no depende de que el lector acierte con el valor por
    // defecto, que es justo el tipo de suposición que ya costó un incidente con
    // el `scope` inferido de una lista vacía.
    valueType,
    tiers: normalizeTiers(config.tiers, valueType),
    scope,
    productIds: scope === "all" ? [] : config.productIds ?? [],
    excludeProductIds: config.excludeProductIds ?? [],
    message: config.message || "Descuento por cantidad",
  };
}

// ─── N1: tope de tamaño ───────────────────────────────────────────────────────
//
// Shopify le entrega `null` a la Function cuando el valor del metafield pasa de
// 10.000 bytes: la campaña queda «Activa» y no descuenta nada, en silencio.
// Medido el 2026-11-16 en dev: 9.986 bytes descuenta, 10.012 ya no. Lo que
// manda es el TAMAÑO (productos + niveles + exclusiones + mensaje), no una
// cantidad fija de productos. Se deja un margen por debajo de lo medido.
export const TIERED_METAFIELD_MAX_BYTES = 9_900;

const bytesDe = (texto: string) => new TextEncoder().encode(texto).length;

/** Tamaño real, en bytes, de lo que se le escribe a la Function. */
export function tieredConfigBytes(config: TieredCampaignConfig): number {
  return bytesDe(JSON.stringify(toFunctionConfig(config)));
}

/** La selección no entra en lo que la Function puede leer. */
export class TieredDemasiadoGrandeError extends Error {}

/**
 * `null` si la campaña entra; si no, el texto para el comerciante, con cuántos
 * productos admite con los niveles que eligió. `config.productIds` tiene que
 * venir ya RESUELTO (los productos reales de la colección, etiqueta, etc.).
 */
export function mensajeTieredDemasiadoGrande(config: TieredCampaignConfig): string | null {
  if (tieredConfigBytes(config) <= TIERED_METAFIELD_MAX_BYTES) return null;

  const todaLaTienda = config.selectionMode === "all";
  const excluidos = config.excludeProductIds ?? [];
  // En «toda la tienda» lo único que crece es la lista de exclusiones.
  const lista = todaLaTienda ? excluidos : config.productIds ?? [];
  const sinLista = tieredConfigBytes(
    todaLaTienda ? { ...config, excludeProductIds: [] } : { ...config, productIds: [] }
  );
  // Cada producto ocupa su id, las comillas y la coma. Se cuenta con el id más
  // largo para no prometer un lugar que después no esté.
  const porProducto = lista.reduce((m, id) => Math.max(m, bytesDe(id)), 0) + 3;
  const maximo = Math.max(
    0,
    Math.min(lista.length - 1, Math.floor((TIERED_METAFIELD_MAX_BYTES - sinLista + 1) / porProducto))
  );

  const cuantos = normalizeTiers(config.tiers, config.valueType ?? "PERCENT").length;
  const niveles = cuantos === 1 ? "el nivel que elegiste" : `los ${cuantos} niveles que elegiste`;

  if (todaLaTienda)
    return (
      `Esta campaña supera el límite: excluye ${lista.length} productos y, con ${niveles}, ` +
      `admite hasta ${maximo} productos excluidos. Quita exclusiones o usa menos niveles.`
    );

  if (maximo === 0)
    return (
      `Esta campaña supera el límite: tiene ${excluidos.length} productos excluidos y ya no ` +
      `queda lugar para los productos con descuento. Quita exclusiones.`
    );

  return (
    `Esta campaña supera el límite: abarca ${lista.length} productos y, con ${niveles}, ` +
    `admite hasta ${maximo}. Reduce la selección o usa menos niveles.` +
    (excluidos.length > 0
      ? ` Los ${excluidos.length} productos excluidos también ocupan lugar: con menos exclusiones entran más productos.`
      : "")
  );
}
