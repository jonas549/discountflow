// Parseo y validación del formulario de campañas CART_VALUE.
// Vive fuera de las rutas porque lo usan tanto la de creación como la de edición.

import type { CartValueFormErrors } from "../../components/CartValueCampaignForm";
import {
  normalizeCartValueTiers,
  validateCartValue,
  type CartValueType,
  type CartValueTier,
} from "./cart-value-calc.ts";
import {
  type CartValueCampaignConfig,
  CART_VALUE_DEFAULT_MESSAGE,
} from "./cart-value-client.ts";
import { es } from "../../i18n.ts";

export type ParsedCartValueForm = ReturnType<typeof parseCartValueForm>;

export function parseCartValueForm(fd: FormData) {
  const parse = <T,>(key: string, fallback: T): T => {
    try {
      return JSON.parse((fd.get(key) as string) || "null") ?? fallback;
    } catch {
      return fallback;
    }
  };

  const valueType = ((fd.get("valueType") as string) || "PERCENT") as CartValueType;

  return {
    name: (fd.get("name") as string | null)?.trim() ?? "",
    intent: (fd.get("intent") as "draft" | "activate") ?? "draft",
    valueType,
    message: (fd.get("message") as string | null)?.trim() ?? "",
    tiers: normalizeCartValueTiers(parse<CartValueTier[]>("tiersJson", []), valueType),
    /**
     * Los packs que anulan esta campaña. Llegan como JSON y no como checkboxes
     * sueltos para que la lista viaje entera: con `fd.getAll` una lista vacía y
     * un campo ausente son indistinguibles, y "el merchant quitó todas las
     * exclusiones" tiene que poder guardarse.
     */
    excludedPackCampaignIds: parse<string[]>("excludedPacksJson", []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    ),
    startsAt: (fd.get("startsAt") as string) || "",
    endsAt: (fd.get("endsAt") as string) || "",
  };
}

export function validateCartValueForm(f: ParsedCartValueForm): CartValueFormErrors {
  const errors: CartValueFormErrors = {};
  if (!f.name) errors.name = es.nuevoValorCarrito.errNombre;

  const v = validateCartValue(f.valueType, f.tiers);
  if (v.errors.length > 0) errors.tiers = v.errors.join(" ");

  if (f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt))
    errors.dates = es.nuevoValorCarrito.errFechas;

  return errors;
}

export function buildCartValueConfig(
  f: ParsedCartValueForm
): CartValueCampaignConfig {
  return {
    valueType: f.valueType,
    tiers: f.tiers,
    message: f.message || CART_VALUE_DEFAULT_MESSAGE,
    excludedPackCampaignIds: f.excludedPackCampaignIds,
  };
}
