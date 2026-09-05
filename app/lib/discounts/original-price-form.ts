// Parseo y validación del formulario de campañas CODE_ORIGINAL_PRICE.
// Vive fuera de las rutas porque lo usan tanto la de creación como la de edición.

import type { OriginalPriceFormErrors } from "../../components/OriginalPriceCampaignForm";
import { validateOriginalPrice } from "./original-price-calc.ts";
import {
  type OriginalPriceCampaignConfig,
  normalizeDiscountCode,
  ORIGINAL_PRICE_DEFAULT_MESSAGE,
} from "./original-price-client.ts";
import { es } from "../../i18n.ts";

export type ParsedOriginalPriceForm = ReturnType<typeof parseOriginalPriceForm>;

export function parseOriginalPriceForm(fd: FormData) {
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
    /** Se normaliza acá, una sola vez: lo que se guarda y lo que va a Shopify
     *  tienen que ser exactamente la misma cadena, o la atribución del pedido
     *  no cruza y el merchant ve cero ventas sin ningún error a la vista. */
    code: normalizeDiscountCode((fd.get("code") as string) || ""),
    percent: Number((fd.get("percent") as string) || 0),
    message: (fd.get("message") as string | null)?.trim() ?? "",
    excludedPackCampaignIds: parse<string[]>("excludedPacksJson", []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    ),
    startsAt: (fd.get("startsAt") as string) || "",
    endsAt: (fd.get("endsAt") as string) || "",
  };
}

/**
 * Qué puede llevar un código de descuento.
 *
 * Shopify acepta bastante más, pero un código con espacios o acentos es un
 * código que el influencer va a dictar mal por teléfono y el comprador va a
 * escribir mal. Se restringe a lo que se puede leer en voz alta.
 */
const CODIGO_VALIDO = /^[A-Z0-9._-]{3,64}$/;

export function validateOriginalPriceForm(
  f: ParsedOriginalPriceForm
): OriginalPriceFormErrors {
  const errors: OriginalPriceFormErrors = {};
  const t = es.nuevoCupon;

  if (!f.name) errors.name = t.errNombre;

  if (!f.code) errors.code = t.errCodigoVacio;
  else if (!CODIGO_VALIDO.test(f.code)) errors.code = t.errCodigoFormato;

  const v = validateOriginalPrice(f.percent);
  if (v.errors.length > 0) errors.percent = v.errors.join(" ");

  if (f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt))
    errors.dates = t.errFechas;

  return errors;
}

export function buildOriginalPriceConfig(
  f: ParsedOriginalPriceForm
): OriginalPriceCampaignConfig {
  return {
    percent: f.percent,
    code: f.code,
    message: f.message || ORIGINAL_PRICE_DEFAULT_MESSAGE,
    excludedPackCampaignIds: f.excludedPackCampaignIds,
  };
}
