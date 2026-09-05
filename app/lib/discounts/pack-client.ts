// Helpers client-safe para campañas PACK (sin imports de servidor).

import type { PackMode, PackProduct, PackTier } from "./pack-calc";
import {
  normalizePackCatalog,
  normalizePackTiers,
  packMinimumProducts,
  MIN_PACK_PRODUCTS,
} from "./pack-calc";

export type { PackMode, PackProduct, PackTier };

/**
 * 🔴 La clave de la propiedad de línea con la que el widget marca lo que agrega
 * al carrito.
 *
 * Tiene que coincidir EXACTAMENTE con la que pide la input query de la Function
 * (`extensions/pack-discount/src/cart_lines_discounts_generate_run.graphql`).
 * `attribute` exige la clave escrita a mano y no existe forma de listar los
 * atributos, así que si estas dos se desincronizan la Function deja de ver las
 * líneas y el pack no descuenta — sin ningún error.
 *
 * El guion bajo inicial no es decorativo: Shopify oculta al comprador las
 * propiedades que empiezan con `_`, pero las conserva visibles en la página de
 * detalles del pedido en el admin, que es donde hacen falta para soporte.
 */
export const PACK_LINE_ATTRIBUTE = "_df_pack";

export const PACK_METAFIELD_NAMESPACE = "$app:discountflow";
export const PACK_METAFIELD_KEY = "pack-config";

/**
 * Foto de un producto del pack, guardada al guardar la campaña.
 *
 * Existe para que el widget pueda pintarse SIN llamar a la Admin API en cada
 * carga de página de la tienda: el app proxy la sirve directamente desde
 * Postgres. El precio de acá es una foto y puede quedar viejo si el merchant lo
 * cambia; por eso el widget lo refresca contra `/products/{handle}.js`, que es
 * del propio storefront y va por CDN.
 *
 * ⚠️ El precio de esta foto NUNCA decide dinero. El descuento lo calcula la
 * Function sobre el precio real del carrito.
 */
export type PackItemSnapshot = {
  productId: string;
  handle: string;
  title: string;
  /** Primera variante disponible. Es la que el widget agrega al carrito. */
  variantId: string;
  /** Precio unitario en la moneda de la tienda, al momento de guardar. */
  price: number;
  image: string | null;
  /** % de este producto. Solo significativo en modo PER_PRODUCT. */
  percent?: number;
};

export type PackCampaignConfig = {
  mode: PackMode;
  /** El catálogo curado, en la forma que consume el cálculo. */
  products: PackProduct[];
  /** Niveles por cantidad de productos distintos. Solo en modo PACK_SIZE. */
  tiers: PackTier[];
  /** Datos de presentación del catálogo. No participa del cálculo. */
  items: PackItemSnapshot[];

  /** Encabezado que muestra el widget en la tienda. */
  heading?: string;
  /** Texto que ve el comprador en el carrito. */
  message?: string;

  // Handles de Shopify — se llenan al activar la campaña
  shopifyDiscountId?: string;
  functionId?: string;
};

export const PACK_TITLE_PREFIX = "[DiscountFlow] ";

export function packDiscountTitle(campaignName: string): string {
  return `${PACK_TITLE_PREFIX}${campaignName}`;
}

/**
 * Texto que ve el comprador y que Shopify publica como `title` de la
 * `discount_application`. El default debe seguir al de la Function
 * (`cart_lines_discounts_generate_run.ts`).
 */
export const PACK_DEFAULT_MESSAGE = "Descuento por pack";

export const DEFAULT_PACK_TIERS: PackTier[] = [
  { minProducts: 2, percent: 10 },
  { minProducts: 3, percent: 20 },
  { minProducts: 4, percent: 30 },
];

/** Etiqueta corta para la columna "Descuento" del listado de campañas. */
export function packDiscountLabel(config: PackCampaignConfig): string {
  if (config?.mode === "PACK_SIZE") {
    const tiers = normalizePackTiers(config?.tiers);
    if (tiers.length === 0) return "—";
    const max = tiers.reduce((m, t) => (t.percent > m ? t.percent : m), 0);
    return `${tiers.length} ${tiers.length === 1 ? "nivel" : "niveles"} · hasta ${max}% (por tamaño)`;
  }

  const catalogo = normalizePackCatalog(config?.products);
  const conDescuento = catalogo.filter((p) => (p.percent ?? 0) > 0);
  if (conDescuento.length === 0) return "—";
  const max = conDescuento.reduce((m, p) => Math.max(m, p.percent ?? 0), 0);
  const min = conDescuento.reduce((m, p) => Math.min(m, p.percent ?? 0), 100);
  const rango = min === max ? `${max}%` : `${min}–${max}%`;
  return `${catalogo.length} productos · ${rango} (por producto)`;
}

/**
 * Texto de la columna "Productos" del listado.
 *
 * PACK no crea filas en `CampaignProduct` —igual que BXGY y TIERED—, así que el
 * `_count.products` del listado siempre da 0 y el número real sale del config.
 */
export function packProductsLabel(config: PackCampaignConfig): string {
  const n = config?.products?.length ?? 0;
  return n === 0 ? "—" : String(n);
}

/** Cuántos productos distintos hace falta armar para que el pack empiece a rebajar. */
export function packMinimum(config: PackCampaignConfig): number {
  return packMinimumProducts(
    config?.mode ?? "PER_PRODUCT",
    normalizePackTiers(config?.tiers)
  );
}

/**
 * ¿Pudo esta campaña haber descontado una línea con este producto?
 *
 * Replica la regla de elegibilidad de la Function en lo que se puede replicar
 * desde fuera del carrito: la pertenencia al catálogo curado. Lo que NO se puede
 * replicar es la propiedad `_df_pack` de la línea, que el webhook de pedidos sí
 * recibe (`line_item.properties`) y debe comprobar por su cuenta.
 */
export function packAppliesToProduct(
  config: PackCampaignConfig,
  productGid: string
): boolean {
  return (config?.products ?? []).some((p) => p.productId === productGid);
}

/**
 * Recorta la config a lo que la Function necesita leer del metafield.
 *
 * Lo que se queda fuera a propósito: `items` (títulos, imágenes y precios son
 * presentación, no cálculo) y los handles de Shopify. Un metafield más chico es
 * un metafield que no se acerca a ningún tope.
 *
 * `campaignId` es obligatorio y va explícito: es la identidad contra la que la
 * Function compara la propiedad `_df_pack` de cada línea, y sin él la Function
 * hace fail-closed.
 */
export function toPackFunctionConfig(
  campaignId: string,
  config: PackCampaignConfig
) {
  const mode: PackMode = config.mode === "PACK_SIZE" ? "PACK_SIZE" : "PER_PRODUCT";
  return {
    campaignId,
    mode,
    products: normalizePackCatalog(config.products),
    tiers: mode === "PACK_SIZE" ? normalizePackTiers(config.tiers) : [],
    message: config.message || PACK_DEFAULT_MESSAGE,
  };
}

/**
 * Lo que el app proxy le entrega al widget de la tienda.
 *
 * Es deliberadamente distinto del config de la Function: acá SÍ van los datos de
 * presentación, y NO va nada que el navegador no deba poder cambiar de sitio.
 * Los porcentajes viajan porque el widget tiene que poder mostrar el ahorro,
 * pero el que decide en el checkout es el metafield, no esto.
 */
export type PackWidgetPayload = {
  campaignId: string;
  heading: string;
  mode: PackMode;
  tiers: PackTier[];
  minProducts: number;
  attribute: string;
  currency: string;
  items: PackItemSnapshot[];
};

export const MIN_PACK_PRODUCTS_EXPORT = MIN_PACK_PRODUCTS;
