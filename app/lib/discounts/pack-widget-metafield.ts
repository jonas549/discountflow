// Que va dentro del metafield que lee el bloque de tema, y como se arma.
//
// Modulo PURO a proposito: sin Prisma y sin Shopify, para que la decision de
// que datos viajan se pueda probar sola. Las llamadas viven en
// `pack-widget-metafield.server.ts`.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 QUÉ VA ACÁ Y QUÉ NO. ES LA DECISIÓN IMPORTANTE DE ESTE ARCHIVO.
//
// Va solo lo que cambia cuando el merchant EDITA la campaña: qué campaña, qué
// niveles, qué mínimo, y qué productos (por handle).
//
// NO van el precio, el título, la foto ni la variante. Esos los resuelve el
// propio Liquid con `all_products[handle]` en cada renderizado, así que salen
// siempre EN VIVO.
//
// El motivo no es estético. Hay reportes de que Shopify cachea los metafields
// de app en Liquid durante horas, sin invalidación fiable. Si el precio viviera
// acá, un cambio de precio del merchant podría tardar horas en verse en el
// widget. Con este reparto, lo peor que puede envejecer es "qué productos
// forman el pack" — y eso no puede cobrar de más: el dinero lo decide la
// Function leyendo el metafield DEL DESCUENTO en el checkout, que no pasa por
// esta caché. Un widget viejo ofrece un producto que ya no califica; no cobra
// mal.
// ═══════════════════════════════════════════════════════════════════════════

import type { PackWidgetPayload } from "./pack-client.ts";
import { MAX_PACK_CATALOG } from "./pack-validate.ts";

/**
 * Namespace reservado de la app. El mismo que el metafield del descuento.
 *
 * En Liquid se lee con `app.metafields.discountflow.pack_widget` (el prefijo
 * `$app:` desaparece) y, como respaldo, con
 * `shop.metafields["$app:discountflow"].pack_widget`. El bloque prueba las dos
 * formas porque la documentación oficial y los reportes de la comunidad no
 * coinciden en cuál funciona dentro de una theme app extension.
 */
export const PACK_WIDGET_NAMESPACE = "$app:discountflow";

/**
 * Guion bajo y no guion medio a propósito: con guion medio, Liquid obliga a la
 * sintaxis de corchetes en todos lados y el bloque se vuelve ilegible.
 */
export const PACK_WIDGET_KEY = "pack_widget";

/** Lo que el bloque necesita de un producto. El resto lo pone `all_products`. */
export type PackWidgetItemLiquid = {
  handle: string;
  productId: string;
  /** Solo significativo en modo PER_PRODUCT. */
  percent: number;
};

export type PackWidgetPackLiquid = {
  campaignId: string;
  heading: string;
  mode: string;
  tiers: Array<{ minProducts: number; percent: number }>;
  minProducts: number;
  attribute: string;
  currency: string;
  items: PackWidgetItemLiquid[];
};

export type PackWidgetMetafield = {
  /** Versión del formato. Si algún día cambia, el bloque viejo lo ignora. */
  v: 1;
  /** El pack que usa un bloque sin `campaign_id`. `null` si no hay ninguno. */
  default: string | null;
  packs: Record<string, PackWidgetPackLiquid>;
};

/** Traduce los payloads a la forma mínima que consume el Liquid. */
export function construirMetafieldDeWidget(
  payloads: PackWidgetPayload[]
): PackWidgetMetafield {
  const packs: Record<string, PackWidgetPackLiquid> = {};

  for (const p of payloads) {
    const items: PackWidgetItemLiquid[] = [];
    for (const it of p.items) {
      // Sin handle no hay forma de resolverlo en Liquid. Se descarta acá y no
      // en el bloque: mejor mostrar 19 productos correctos que un hueco.
      if (!it.handle) continue;
      items.push({
        handle: it.handle,
        productId: it.productId,
        percent: typeof it.percent === "number" ? it.percent : 0,
      });
      // 🔴 El corte duro. `all_products` solo resuelve 20 handles por página; el
      // formulario ya no deja pasar de MAX_PACK_CATALOG, pero una campaña
      // guardada ANTES de esa decisión puede tener 24.
      if (items.length >= MAX_PACK_CATALOG) break;
    }
    if (items.length === 0) continue;

    packs[p.campaignId] = {
      campaignId: p.campaignId,
      heading: p.heading,
      mode: p.mode,
      tiers: p.tiers,
      minProducts: p.minProducts,
      attribute: p.attribute,
      currency: p.currency,
      items,
    };
  }

  const ids = Object.keys(packs);
  return { v: 1, default: ids.length ? ids[0] : null, packs };
}

