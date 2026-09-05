// Parseo y validación del formulario de campañas PACK.
// Vive fuera de las rutas porque lo usan tanto la de creación como la de edición.

import type { PackFormErrors } from "../../components/PackCampaignForm";
import {
  normalizePackCatalog,
  normalizePackTiers,
  type PackMode,
  type PackProduct,
  type PackTier,
} from "./pack-calc";
import { validatePack } from "./pack-validate";
import type { PackCampaignConfig, PackItemSnapshot } from "./pack-client";
import { PACK_DEFAULT_MESSAGE } from "./pack-client";
import { es } from "../../i18n";

/** Producto tal como lo maneja el formulario: el del picker + su porcentaje. */
export type PackFormProduct = {
  id: string;
  title: string;
  percent: number;
};

export type ParsedPackForm = ReturnType<typeof parsePackForm>;

export function parsePackForm(fd: FormData) {
  const parse = <T,>(key: string, fallback: T): T => {
    try {
      return JSON.parse((fd.get(key) as string) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  };

  const mode = ((fd.get("mode") as string) || "PER_PRODUCT") as PackMode;
  const products = parse<PackFormProduct[]>("productsJson", []);

  return {
    name: (fd.get("name") as string | null)?.trim() ?? "",
    intent: (fd.get("intent") as "draft" | "activate") ?? "draft",
    mode,
    heading: (fd.get("heading") as string | null)?.trim() ?? "",
    products,
    /**
     * El catálogo que consume el cálculo. En modo PACK_SIZE el porcentaje por
     * producto se descarta a propósito: el % lo decide el nivel alcanzado, y
     * dejarlo pasar al metafield haría creer que significa algo.
     */
    catalog: normalizePackCatalog(
      products.map((p): PackProduct =>
        mode === "PER_PRODUCT"
          ? { productId: p.id, percent: p.percent }
          : { productId: p.id }
      )
    ),
    tiers: normalizePackTiers(parse<PackTier[]>("tiersJson", [])),
    startsAt: (fd.get("startsAt") as string) || "",
    endsAt: (fd.get("endsAt") as string) || "",
  };
}

export function validatePackForm(f: ParsedPackForm): PackFormErrors {
  const errors: PackFormErrors = {};
  if (!f.name) errors.name = es.nuevoPack.errNombre;

  const v = validatePack(f.mode, f.catalog, f.tiers);
  if (v.errors.length > 0) {
    // El primer error habla de la selección de productos; el resto, de la
    // configuración del descuento. Se separan para que cada mensaje aparezca
    // junto al campo que lo provoca y no todos apilados arriba.
    const deSeleccion = v.errors.filter((e) => e.toLowerCase().includes("producto"));
    const deDescuento = v.errors.filter((e) => !deSeleccion.includes(e));
    if (deSeleccion.length) errors.selection = deSeleccion.join(" ");
    if (deDescuento.length) errors.discount = deDescuento.join(" ");
  }

  if (f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt))
    errors.dates = es.nuevoPack.errFechas;

  return errors;
}

/**
 * Arma la config que se guarda en la campaña.
 *
 * `items` (la foto de títulos, precios e imágenes) llega desde fuera porque
 * requiere una llamada a la Admin API y esta función tiene que poder correr sin
 * red — es la que usan la validación y los tests.
 */
export function buildPackConfig(
  f: ParsedPackForm,
  items: PackItemSnapshot[]
): PackCampaignConfig {
  const percentPorProducto = new Map(f.catalog.map((p) => [p.productId, p.percent]));

  return {
    mode: f.mode,
    products: f.catalog,
    tiers: f.mode === "PACK_SIZE" ? f.tiers : [],
    items: items.map((it) => ({
      ...it,
      // El % viaja también en la foto para que el widget no tenga que cruzar
      // dos listas para pintar "10% OFF" en cada tarjeta.
      percent: percentPorProducto.get(it.productId),
    })),
    heading: f.heading || es.nuevoPack.headingPorDefecto,
    message: PACK_DEFAULT_MESSAGE,
  };
}
