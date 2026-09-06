// Parseo y validación del formulario de campañas CODE_ORIGINAL_PRICE.
// Vive fuera de las rutas porque lo usan tanto la de creación como la de edición.

import type { OriginalPriceFormErrors } from "../../components/OriginalPriceCampaignForm";
import { validateOriginalPrice } from "./original-price-calc.ts";
import {
  type OriginalPriceCampaignConfig,
  type OriginalPriceSelectionMode,
  type OriginalPriceMinimumType,
  type OriginalPriceMetodo,
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
    /** Código o automático. Cambia la familia de mutaciones de Shopify. */
    metodo: leerMetodo(fd.get("metodo")),

    excludedPackCampaignIds: parse<string[]>("excludedPacksJson", []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    ),
    excludedCartValueCampaignIds: parse<string[]>("excludedMontosJson", []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    ),

    // ── A qué aplica ────────────────────────────────────────────────────────
    selectionMode: leerModo(fd.get("selectionMode")),
    /** Lo que eligió el merchant. Las colecciones se expanden al guardar. */
    productIds: parse<Array<{ id: string }>>("productsJson", [])
      .map((p) => p?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
    collectionIds: parse<string[]>("collectionIdsJson", []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    ),

    // ── Límite de usos ──────────────────────────────────────────────────────
    //
    // La casilla y el número van separados a propósito: si el merchant escribe
    // 200, destilda la casilla y guarda, tiene que quedar SIN límite. Deducir
    // el límite de que el campo tenga un número dejaría los 200 aplicando.
    limitarUsos: fd.get("limitarUsos") === "on",
    usageLimit: leerEntero(fd.get("usageLimit")),
    oncePerCustomer: fd.get("oncePerCustomer") === "on",

    // ── Requisitos mínimos ──────────────────────────────────────────────────
    minimumType: leerTipoMinimo(fd.get("minimumType")),
    minSubtotal: leerDecimal(fd.get("minSubtotal")),
    minQuantity: leerEntero(fd.get("minQuantity")),

    startsAt: (fd.get("startsAt") as string) || "",
    endsAt: (fd.get("endsAt") as string) || "",
  };
}

/**
 * Los tres lectores de abajo devuelven `null` ante cualquier cosa que no sea un
 * número usable, en vez de `NaN` o `0`.
 *
 * `Number("")` es 0 y `Number("hola")` es NaN, y los dos habrían pasado por un
 * `typeof === "number"`. Un mínimo de 0 no es "sin mínimo": es un mínimo que
 * siempre se cumple, y la diferencia se nota cuando el merchant borra el campo.
 */
function leerEntero(raw: FormDataEntryValue | null): number | null {
  const txt = String(raw ?? "").trim();
  if (!txt) return null;
  const n = Number(txt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function leerDecimal(raw: FormDataEntryValue | null): number | null {
  // Se acepta la coma además del punto: el merchant chileno escribe "1.000,50"
  // y "50,5", y `Number` no entiende ninguno de los dos.
  const txt = String(raw ?? "").trim().replace(/\s/g, "");
  if (!txt) return null;
  const normalizado = txt.includes(",") ? txt.replace(/\./g, "").replace(",", ".") : txt;
  const n = Number(normalizado);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/** Método desconocido = CODE: es como nació el tipo y como están las guardadas. */
function leerMetodo(raw: FormDataEntryValue | null): OriginalPriceMetodo {
  return String(raw ?? "") === "AUTOMATIC" ? "AUTOMATIC" : "CODE";
}

/** Modo desconocido = "all": es lo que hacían las campañas sin este campo. */
function leerModo(raw: FormDataEntryValue | null): OriginalPriceSelectionMode {
  const v = String(raw ?? "");
  return v === "products" || v === "collections" ? v : "all";
}

function leerTipoMinimo(raw: FormDataEntryValue | null): OriginalPriceMinimumType {
  const v = String(raw ?? "");
  return v === "subtotal" || v === "quantity" ? v : "none";
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

  // 🔴 El código solo se exige —y solo se valida— en el método de CÓDIGO. En el
  // automático no hay campo que llenar, y exigirlo dejaría el formulario
  // trancado con un error sobre algo que el merchant no ve.
  if (f.metodo === "CODE") {
    if (!f.code) errors.code = t.errCodigoVacio;
    else if (!CODIGO_VALIDO.test(f.code)) errors.code = t.errCodigoFormato;
  }

  const v = validateOriginalPrice(f.percent);
  if (v.errors.length > 0) errors.percent = v.errors.join(" ");

  if (f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt))
    errors.dates = t.errFechas;

  // ── A qué aplica ──────────────────────────────────────────────────────────
  //
  // Se comprueba acá y no solo al guardar: `resolveOriginalPriceProductIds`
  // también lanza, pero un error de formulario se pinta junto al campo y uno de
  // Shopify sale de banner rojo arriba. El merchant necesita el primero.
  if (f.selectionMode === "products" && f.productIds.length === 0)
    errors.selection = t.errSinProductos;
  if (f.selectionMode === "collections" && f.collectionIds.length === 0)
    errors.selection = t.errSinColecciones;

  // ── Límite de usos ────────────────────────────────────────────────────────
  //
  // Solo existe en el método de código: `DiscountAutomaticAppInput` no tiene
  // `usageLimit` ni `appliesOncePerCustomer` (verificado por introspección).
  if (f.metodo === "CODE" && f.limitarUsos && f.usageLimit === null)
    errors.usageLimit = t.errUsosVacio;

  // ── Requisitos mínimos ────────────────────────────────────────────────────
  if (f.minimumType === "subtotal" && f.minSubtotal === null)
    errors.minimum = t.errMinMontoVacio;
  if (f.minimumType === "quantity" && f.minQuantity === null)
    errors.minimum = t.errMinCantidadVacia;

  return errors;
}

export function buildOriginalPriceConfig(
  f: ParsedOriginalPriceForm
): OriginalPriceCampaignConfig {
  const usaCodigo = f.metodo === "CODE";

  return {
    percent: f.percent,
    metodo: f.metodo,
    /**
     * 🔴 EL CÓDIGO SE CONSERVA SIEMPRE, TAMBIÉN EN AUTOMÁTICO.
     *
     * Antes se guardaba vacío al pasar a automático, con el razonamiento de que
     * el listado no mostrara un chip con un código que no existe en Shopify.
     * Estaba mal por dos motivos:
     *
     *   1. Ese problema ya está resuelto donde corresponde: el listado mira el
     *      MÉTODO antes de pintar el chip, no si el código está vacío.
     *   2. Borrarlo destruye lo que el merchant escribió. Cambiar de método es
     *      una prueba reversible ("¿y si lo pongo automático?"); volver atrás
     *      tenía que devolverle su código, y en cambio se lo perdía sin avisar.
     *
     * La config guarda lo que el merchant escribió. Qué se le manda a Shopify
     * lo decide la mutación, y la automática no manda `code` porque ese campo
     * no existe en `DiscountAutomaticAppInput`. Son dos cosas distintas y ahora
     * están separadas.
     */
    code: f.code,
    message: f.message || ORIGINAL_PRICE_DEFAULT_MESSAGE,
    excludedPackCampaignIds: f.excludedPackCampaignIds,
    excludedCartValueCampaignIds: f.excludedCartValueCampaignIds,

    selectionMode: f.selectionMode,
    // Con "toda la tienda" no se arrastra la selección anterior. Guardarla
    // "por si vuelve" es lo que deja una lista viva detrás de un scope que dice
    // otra cosa; si el merchant vuelve a "productos", la elige de nuevo.
    productIds: f.selectionMode === "products" ? f.productIds : [],
    collectionIds: f.selectionMode === "collections" ? f.collectionIds : [],

    // Los dos límites solo viajan en el método de código. En automático se
    // guardan en null para que, si el merchant cambia de método y vuelve, no
    // reaparezca un límite que la pantalla no le mostró.
    usageLimit: usaCodigo && f.limitarUsos ? f.usageLimit : null,
    oncePerCustomer: usaCodigo ? f.oncePerCustomer : false,

    minimumType: f.minimumType,
    minSubtotal: f.minimumType === "subtotal" ? f.minSubtotal : null,
    minQuantity: f.minimumType === "quantity" ? f.minQuantity : null,
  };
}
