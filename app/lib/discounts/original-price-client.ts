// Config, títulos y traducción al metafield de las campañas CODE_ORIGINAL_PRICE.
// Sin imports de servidor: lo usan el formulario y las rutas por igual.

import {
  MAX_ORIGINAL_PRICE_PERCENT,
  MIN_ORIGINAL_PRICE_PERCENT,
  type OriginalPriceScope,
  type ExclusionPorMonto,
} from "./original-price-calc.ts";

export { MAX_ORIGINAL_PRICE_PERCENT, MIN_ORIGINAL_PRICE_PERCENT };
export type { OriginalPriceScope };

/**
 * A qué productos aplica el cupón, tal como lo elige el merchant.
 *
 * Mismo vocabulario que Escalonado y BxGy —así el merchant aprende una sola
 * pantalla— pero solo con los tres modos que pidió Jonas y que la pantalla
 * nativa de Shopify también ofrece. Tags, proveedores y tipos de producto
 * quedan fuera a propósito: existen en Escalonado y añadirlos acá es un renglón
 * en `resolveOriginalPriceProductIds`, no un rediseño.
 */
export type OriginalPriceSelectionMode = "all" | "products" | "collections";

/** Qué requisito mínimo pide la campaña. Uno solo, como en Shopify. */
export type OriginalPriceMinimumType = "none" | "subtotal" | "quantity";

/**
 * Cómo se activa el descuento.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 NO ES SOLO UNA CASILLA: cambia la familia de mutaciones de Shopify.
 *
 *   CODE      → `discountCodeApp*`      · el comprador escribe un código
 *   AUTOMATIC → `discountAutomaticApp*` · se aplica solo, sin código
 *
 * Y arrastra una limitación de la API que NO se puede sortear (verificado por
 * introspección contra la tienda, 2026-09-06, API 2025-10):
 *
 *   `DiscountAutomaticAppInput` **no tiene** `usageLimit` ni
 *   `appliesOncePerCustomer`.
 *
 * Es lógico —no hay código que redimir, así que no hay nada que contar— pero
 * significa que **el límite de usos existe solo en el método de código**. El
 * formulario esconde esa sección cuando el método es automático y dice por qué,
 * en vez de mostrar campos que se guardarían y no harían nada.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type OriginalPriceMetodo = "CODE" | "AUTOMATIC";

/** El método por defecto: ausente = CODE, que es como nació el tipo. */
export const ORIGINAL_PRICE_METODO_POR_DEFECTO: OriginalPriceMetodo = "CODE";

export function originalPriceMetodo(
  config: OriginalPriceCampaignConfig
): OriginalPriceMetodo {
  return config.metodo === "AUTOMATIC" ? "AUTOMATIC" : "CODE";
}

/** `true` si esta campaña usa un código que el comprador tiene que escribir. */
export function originalPriceUsaCodigo(config: OriginalPriceCampaignConfig): boolean {
  return originalPriceMetodo(config) === "CODE";
}

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

  /**
   * Campañas de MONTO DE COMPRA cuya aplicación anula este cupón.
   *
   * 🔴 Es la única exclusión que hace algo de verdad, y hay una razón medida
   * detrás. `combinesWith` es bilateral, y esta es la matriz de la app:
   *
   *   Cupón           PRODUCT  order:true   product:true
   *   Monto de compra ORDER    order:false  product:true   → 🟢 conviven
   *   Pack            PRODUCT  order:true   product:false  → ✗ no conviven
   *   Escalonado      PRODUCT  order:false  product:false  → ✗ no conviven
   *   BxGy            PRODUCT  order:false  product:false  → ✗ no conviven
   *
   * O sea que el cupón solo puede sumarse con el descuento por monto de compra
   * —confirmado en un pedido real el 2026-09-06, −$10,80 y −$3,46 en dos líneas
   * separadas— y es el único caso en el que el merchant tiene algo que decidir.
   */
  excludedCartValueCampaignIds?: string[];

  /** Código o automático. Ausente = CODE. Ver `OriginalPriceMetodo`. */
  metodo?: OriginalPriceMetodo;

  // ─── A qué aplica ─────────────────────────────────────────────────────────
  //
  // 🔴 Shopify NO tiene dónde guardar esto en un descuento de app: el input
  // `DiscountCodeAppInput` no lleva `customerGets` ni nada parecido (verificado
  // por introspección contra la tienda, 2026-09-06). El alcance lo decide
  // NUESTRA Function leyendo el metafield, igual que en Escalonado.

  /**
   * Ausente = `"all"`, y solo por compatibilidad: las campañas guardadas antes
   * de que esto existiera aplicaban a todo, y tienen que seguir haciéndolo.
   *
   * ⚠️ Esa tolerancia vive ACÁ y solo acá. Lo que viaja al metafield es un
   * `scope` explícito, y la Function falla cerrado si no lo encuentra.
   */
  selectionMode?: OriginalPriceSelectionMode;
  /** Productos a los que aplica. Se resuelven al guardar. */
  productIds?: string[];
  /** Solo para reconstruir el formulario al editar; el metafield lleva productos. */
  collectionIds?: string[];

  // ─── Límite de usos ───────────────────────────────────────────────────────
  //
  // 🟢 Estos dos SÍ son nativos de Shopify (`usageLimit` y
  // `appliesOncePerCustomer`) y los hace cumplir él, antes de que la Function
  // llegue a correr. Se guardan también acá para poder repintar el formulario.

  /** Veces que se puede usar el código en total. `null` = sin límite. */
  usageLimit?: number | null;
  /** Un uso por cliente. Shopify lo controla por email o teléfono. */
  oncePerCustomer?: boolean;

  // ─── Requisitos mínimos de compra ─────────────────────────────────────────
  //
  // 🔴 TAMPOCO son nativos en los descuentos de app: `minimumRequirement` no
  // existe en `DiscountCodeAppInput` (existe en `DiscountCodeBasicInput`, que
  // es el de los descuentos nativos). Los comprueba nuestra Function.

  minimumType?: OriginalPriceMinimumType;
  /** Monto mínimo cuando `minimumType` es `"subtotal"`. */
  minSubtotal?: number | null;
  /** Cantidad mínima cuando `minimumType` es `"quantity"`. */
  minQuantity?: number | null;

  // Handles de Shopify — se llenan al activar la campaña.
  shopifyDiscountId?: string;
  functionId?: string;
};

/**
 * ¿Los ajustes dejan al cupón sin ninguna situación en la que pueda aplicar?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 EL BUG DEL 2026-09-06, Y POR QUÉ ESTO TIENE QUE ESTAR EN LA PANTALLA
 *
 * La campaña «TEst cupon» quedó guardada con:
 *
 *   · mínimo de compra           → $120
 *   · excluir «Monto de compra QA» → esa campaña descuenta desde $50
 *
 * El mínimo se mide sobre las líneas EN ALCANCE, que son un subconjunto del
 * carrito. Así que para aplicar hacía falta, a la vez:
 *
 *   subtotal del carrito >= 120   (para pasar el mínimo)
 *   subtotal del carrito <  50    (para que la otra campaña no esté aplicando)
 *
 * **Imposible.** El cupón no podía aplicar en ningún carrito, y la app lo
 * guardó sin decir una palabra. Jonas —que especificó la feature— no pudo
 * distinguir «excluido a propósito» de «roto», y con razón: no había ninguna
 * señal. La lógica funcionaba; lo que faltaba era decirlo.
 *
 * La condición es exactamente `mínimo >= el umbral más bajo de las excluidas`.
 * Se devuelve la campaña culpable para poder nombrarla.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function exclusionQueAnulaElCupon(
  config: Pick<OriginalPriceCampaignConfig, "minimumType" | "minSubtotal">,
  montosExcluidos: Array<{ id: string; name: string; minSubtotal: number }>
): { name: string; minSubtotal: number } | null {
  if ((config.minimumType ?? "none") !== "subtotal") return null;

  const minimo = config.minSubtotal;
  if (typeof minimo !== "number" || !Number.isFinite(minimo) || minimo <= 0) return null;

  let culpable: { name: string; minSubtotal: number } | null = null;
  for (const m of montosExcluidos) {
    if (!m || typeof m.minSubtotal !== "number" || m.minSubtotal <= 0) continue;
    // `>=`: si el mínimo es 50 y la otra descuenta desde 50, cualquier carrito
    // que pase el mínimo ya la tiene aplicando.
    if (minimo >= m.minSubtotal) {
      if (!culpable || m.minSubtotal < culpable.minSubtotal)
        culpable = { name: m.name, minSubtotal: m.minSubtotal };
    }
  }
  return culpable;
}

/**
 * El alcance que viaja al metafield.
 *
 * Traduce el modo del formulario al vocabulario de la Function. Es una función
 * y no un campo guardado para que no puedan divergir: si el merchant cambia de
 * "colecciones" a "toda la tienda", el `scope` cambia con él sin que nadie
 * tenga que acordarse de actualizar un segundo campo.
 */
export function originalPriceScope(
  config: OriginalPriceCampaignConfig
): OriginalPriceScope {
  return (config.selectionMode ?? "all") === "all" ? "all" : "selected";
}

/** El mínimo efectivo, ya resuelto: solo el que el merchant eligió cuenta. */
export function originalPriceMinimos(config: OriginalPriceCampaignConfig): {
  minSubtotal: number | null;
  minQuantity: number | null;
} {
  const tipo = config.minimumType ?? "none";
  return {
    minSubtotal:
      tipo === "subtotal" && typeof config.minSubtotal === "number"
        ? config.minSubtotal
        : null,
    minQuantity:
      tipo === "quantity" && typeof config.minQuantity === "number"
        ? config.minQuantity
        : null,
  };
}

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

/**
 * A cuántos productos aplica, para la columna del listado.
 *
 * 🔴 EXISTE PORQUE EL LISTADO IMPRIMÍA LA CADENA `"Toda la tienda"` A MANO.
 *
 * Era cierto hasta el 2026-09-05, cuando el cupón no tenía alcance y aplicaba
 * a todo. Al agregarle «A qué aplica» esa constante se quedó, y el listado
 * empezó a contradecir al formulario: la campaña «TEst cupon» decía
 * «Colecciones → Camisas» al editarla y «Toda la tienda» en la lista.
 *
 * Es la misma familia que el `?? type` de `tipoLabel`: un valor escrito a mano
 * que era verdad cuando se escribió y que nadie recuerda cuando la feature
 * crece. Ahora sale de la config, que es la única fuente.
 */
export function originalPriceProductsLabel(
  config: OriginalPriceCampaignConfig
): string {
  const modo = config?.selectionMode ?? "all";
  if (modo === "all") return "Toda la tienda";

  const count = config?.productIds?.length ?? 0;

  // Igual que en Escalonado: por colección los productos se resuelven al
  // guardar, y un borrador todavía no los tiene. "0" haría pensar que no aplica
  // a nada; "—" dice que todavía no se sabe.
  if (count === 0) return "—";

  return String(count);
}

/** Resumen de una línea para el listado de campañas. */
export function originalPriceLabel(config: OriginalPriceCampaignConfig): string {
  const pct = typeof config.percent === "number" ? config.percent : 0;
  const base = `${pct}% sobre el precio original`;
  // El método se dice en la etiqueta: dos campañas del mismo % que se activan de
  // formas distintas son dos cosas distintas, y en el listado no hay otro sitio
  // donde se vea.
  return originalPriceUsaCodigo(config) ? base : `${base} · automático`;
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
  config: OriginalPriceCampaignConfig,
  /**
   * Los umbrales de las campañas de monto de compra excluidas, resueltos por el
   * servidor (la config solo guarda IDs; el umbral vive en la OTRA campaña).
   *
   * Se pasa como argumento en vez de leerse de la config para que esta función
   * siga siendo pura: la usan el formulario y las rutas por igual.
   */
  exclusionesPorMonto?: ExclusionPorMonto[]
): {
  percent: number;
  message: string;
  excludeIfPackIds: string[];
  excludeIfCartValue: ExclusionPorMonto[];
  scope: OriginalPriceScope;
  productIds: string[];
  minSubtotal: number | null;
  minQuantity: number | null;
} {
  const scope = originalPriceScope(config);
  const minimos = originalPriceMinimos(config);

  return {
    percent: config.percent,
    message: originalPriceDiscountMessage(config),
    excludeIfPackIds: config.excludedPackCampaignIds ?? [],

    // Solo los que el merchant marcó Y que el servidor pudo resolver. Un ID sin
    // umbral no viaja: una entrada sin `minSubtotal` no se puede evaluar y
    // quedaría como una exclusión que no excluye.
    excludeIfCartValue: (exclusionesPorMonto ?? []).filter(
      (e) => e && typeof e.minSubtotal === "number" && e.minSubtotal > 0
    ),

    // 🔴 `scope` va SIEMPRE explícito, y con `"all"` la lista se manda vacía a
    // propósito: si mandáramos los productos igual, un merchant que pasa de
    // "productos" a "toda la tienda" dejaría en el metafield una lista que la
    // Function podría usar. Un solo campo decide, y está escrito.
    scope,
    productIds: scope === "all" ? [] : config.productIds ?? [],

    minSubtotal: minimos.minSubtotal,
    minQuantity: minimos.minQuantity,
  };
}
