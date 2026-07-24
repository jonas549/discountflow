// Parseo y validación del formulario de campañas escalonadas.
// Vive fuera de las rutas porque lo usan tanto la de creación como la de edición.

import type { TieredFormErrors } from "../../components/TieredCampaignForm";
import { normalizeTiers, validateTiers, type Tier, type TierMode } from "./tiered-calc";
import type { TieredCampaignConfig, TieredSelectionMode } from "./tiered-client";
import { es } from "../../i18n";

export type ParsedTieredForm = ReturnType<typeof parseTieredForm>;

export function parseTieredForm(fd: FormData) {
  const parse = <T,>(key: string, fallback: T): T => {
    try {
      return JSON.parse((fd.get(key) as string) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  };

  return {
    name: (fd.get("name") as string | null)?.trim() ?? "",
    intent: (fd.get("intent") as "draft" | "activate") ?? "draft",
    mode: ((fd.get("mode") as string) || "UNIFORM") as TierMode,
    selectionMode: ((fd.get("selectionMode") as string) || "products") as TieredSelectionMode,
    products: parse<Array<{ id: string }>>("productsJson", []),
    collectionIds: parse<string[]>("collectionIdsJson", []),
    tags: parse<string[]>("tagsJson", []),
    vendors: parse<string[]>("vendorsJson", []),
    types: parse<string[]>("typesJson", []),
    tiers: normalizeTiers(parse<Tier[]>("tiersJson", [])),
    startsAt: (fd.get("startsAt") as string) || "",
    endsAt: (fd.get("endsAt") as string) || "",
  };
}

export function validateTieredForm(f: ParsedTieredForm): TieredFormErrors {
  const errors: TieredFormErrors = {};
  if (!f.name) errors.name = es.nuevaTiered.errNombre;

  const hasSelection =
    f.selectionMode === "all" ||
    (f.selectionMode === "products" && f.products.length > 0) ||
    (f.selectionMode === "collections" && f.collectionIds.length > 0) ||
    (f.selectionMode === "tags" && f.tags.length > 0) ||
    (f.selectionMode === "vendors" && f.vendors.length > 0) ||
    (f.selectionMode === "productTypes" && f.types.length > 0);
  if (!hasSelection) errors.selection = es.nuevaTiered.errSeleccion;

  const tierValidation = validateTiers(f.tiers);
  if (tierValidation.errors.length > 0) errors.tiers = tierValidation.errors.join(" ");

  if (f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt))
    errors.dates = es.nuevaTiered.errFechas;

  return errors;
}

export function buildTieredConfig(f: ParsedTieredForm): TieredCampaignConfig {
  return {
    mode: f.mode,
    tiers: f.tiers,
    selectionMode: f.selectionMode,
    productIds: f.products.map((p) => p.id),
    collectionIds: f.collectionIds,
    rawItems:
      f.selectionMode === "tags"
        ? f.tags
        : f.selectionMode === "vendors"
        ? f.vendors
        : f.selectionMode === "productTypes"
        ? f.types
        : [],
    excludeProductIds: [],
    message: "Descuento por cantidad",
  };
}
