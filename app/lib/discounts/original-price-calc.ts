// Calculadora pura del cupón que descuenta sobre el PRECIO ORIGINAL.
//
// SIN dependencias, a propósito: este módulo corre en DOS entornos distintos
//   1. el servidor / navegador del admin        → preview de la campaña
//   2. dentro de la Shopify Function (JS → Wasm) → cálculo real del checkout
// Por eso no puede importar nada de Node, Prisma, React ni Shopify.
//
// 🔴 AUNQUE VIVA EN app/, ESTE ARCHIVO SE COMPILA DENTRO DEL WASM.
//    Es la misma trampa de `tiered-calc.ts` y `pack-calc.ts`: cualquier cambio
//    aquí EXIGE desplegar la Function. Antes de decir "esto no toca la
//    Function", mirá si roza este archivo.
//
// ═══════════════════════════════════════════════════════════════════════════
// EL PROBLEMA QUE RESUELVE
//
// El merchant le da un cupón a un influencer. Si el producto ya está rebajado,
// Shopify calcula el cupón sobre el precio YA REBAJADO y el merchant regala dos
// veces:
//
//   Producto $100, hoy a $50 por una campaña del 50%. Cupón del 10%.
//   Shopify:  10% de $50  = $5   → queda en $45
//   Queremos: 10% de $100 = $10  → queda en $40
//
// La forma de conseguirlo es NO emitir un porcentaje. Se emite un MONTO FIJO
// por unidad, calculado por nosotros sobre el precio original. Shopify lo resta
// del precio actual y el resultado es el que el merchant quiere.
//
// ═══════════════════════════════════════════════════════════════════════════
// DE DÓNDE SALE EL PRECIO ORIGINAL
//
// Del PRECIO COMPARATIVO de la línea (`cost.compareAtAmountPerQuantity`), que
// el schema documenta como "el precio compareAt de una unidad antes de
// cualquier descuento". Decisión de producto del 2026-09-05: siempre ése, sin
// casilla ni excepciones.
//
// Cubre los dos casos que importan, y por el mismo campo:
//
//   · Rebaja de una campaña NUESTRA. `percentage.ts` y `range.ts` escriben
//     `compareAtPrice = precio original` al aplicar. Ya lo estábamos guardando
//     donde la Function puede leerlo; no hace falta ningún metafield.
//   · Rebaja MANUAL con precio comparativo puesto. Lo escribió el merchant.
//
// Y hay un tercer caso que no necesita nada: un descuento automático de Shopify
// o de otra app NO baja el precio de la línea, aplica una asignación encima. Ahí
// `amountPerQuantity` ya ES el original y el cálculo sale bien solo.
//
// Sin precio comparativo no hay original que valga: el precio actual ES el
// precio. El cupón se calcula sobre él, que es el comportamiento normal y el
// correcto (decisión de producto: ese caso no hay que protegerlo).
// ═══════════════════════════════════════════════════════════════════════════
//
// Dinero: en CENTAVOS enteros, para que no haya deriva de coma flotante
// (85,50 × 10% da 8,549999… en float64). Se vuelve a decimal solo al devolver.

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Una línea del carrito, con lo mínimo que hace falta para decidir. */
export type OriginalPriceLine = {
  lineId: string;
  /** Precio unitario ACTUAL, el que paga hoy el comprador. */
  unitPrice: number;
  /**
   * Precio comparativo unitario, o `null` si no hay.
   *
   * `null` es un estado legítimo y frecuente, no un error: el producto no está
   * rebajado, o el merchant no usa el campo, o Shopify lo oculta al comprador
   * (mercados, B2B — el schema dice que puede venir nulo).
   */
  compareAtUnitPrice: number | null;
  quantity: number;
  /**
   * Producto de la línea, para decidir si entra en el alcance de la campaña.
   *
   * Opcional porque el preview del admin no lo necesita: usa un ejemplo fijo y
   * no filtra nada. En la Function SIEMPRE viene, y su ausencia con
   * `scope: "selected"` deja la línea FUERA — ver `filtrarLineasEnAlcance`.
   */
  productId?: string | null;
};

/** Lo que hay que descontar en una línea. */
export type OriginalPriceLineResult = {
  lineId: string;
  /** Monto a descontar POR UNIDAD, en unidades de moneda. */
  discountPerUnit: number;
  /** Sobre qué precio se calculó. Sirve para explicarlo y para depurar. */
  basePrice: number;
  /** `true` si la base fue el precio comparativo; `false` si fue el actual. */
  usedCompareAt: boolean;
  /**
   * `true` si el descuento se recortó para no dejar la línea por debajo de
   * cero. Pasa con rebajas muy grandes: $100 de lista a $10, cupón del 20%,
   * daría $20 sobre una línea de $10.
   */
  clamped: boolean;
};

export type OriginalPriceNoDiscountReason =
  /** Config ilegible o incompleta. */
  | "NO_CONFIG"
  /** El porcentaje es 0: no hay nada que descontar. */
  | "ZERO_PERCENT"
  /** Ninguna línea quedó con descuento > 0. */
  | "NOTHING_TO_DISCOUNT"
  /** Ninguna línea del carrito entra en el alcance de la campaña. */
  | "OUT_OF_SCOPE"
  /** El carrito no llega al monto mínimo de compra que pidió el merchant. */
  | "BELOW_MIN_SUBTOTAL"
  /** El carrito no llega a la cantidad mínima de artículos. */
  | "BELOW_MIN_QUANTITY"
  /** El merchant excluyó este cupón cuando aplica un descuento por monto. */
  | "EXCLUDED_BY_CART_VALUE";

export type OriginalPriceOutcome =
  | { applies: false; reason: OriginalPriceNoDiscountReason }
  | {
      applies: true;
      lines: OriginalPriceLineResult[];
      /** Lo que ahorra el comprador en total, en unidades de moneda. */
      totalSavings: number;
      /**
       * Cuánto MÁS ahorra que con un cupón normal de Shopify. Es el número que
       * justifica el tipo de campaña, y el que el preview del admin muestra.
       */
      extraVsPercent: number;
    };

/**
 * A qué productos aplica el cupón.
 *
 * 🔴 Mismo vocabulario y misma regla que la Function de escalonados, y por el
 * mismo motivo: `"all"` es lo ÚNICO que autoriza descontar el catálogo entero.
 * Una lista de productos vacía significa "no descuentes nada", NUNCA
 * "descontá todo" — es el bug latente que se blindó el 2026-07-28 con una
 * colección vacía, y no se vuelve a abrir.
 */
export type OriginalPriceScope = "all" | "selected";

/** Requisitos que el carrito tiene que cumplir para que el cupón aplique. */
export type OriginalPriceMinimums = {
  /**
   * Monto mínimo, medido sobre las líneas EN ALCANCE y al precio de hoy.
   * `null` = sin mínimo.
   *
   * Las dos decisiones están copiadas del comportamiento NATIVO de Shopify,
   * que es con lo que el merchant compara:
   *
   *   · "Si el descuento aplica a un producto o colección concretos, solo esos
   *     artículos cuentan para el mínimo" (ayuda de Shopify). Por eso se mide
   *     sobre las líneas en alcance y no sobre el carrito entero.
   *   · Se mide sobre el precio ACTUAL, no sobre el comparativo: es lo que el
   *     comprador ve en su carrito. Medirlo sobre el original haría que un
   *     carrito de $80 "llegara" a un mínimo de $100 sin explicación posible.
   */
  minSubtotal?: number | null;
  /** Cantidad mínima de artículos en alcance. `null` = sin mínimo. */
  minQuantity?: number | null;
};

/**
 * Reparte las líneas del carrito entre las que entran en el alcance y las que
 * no, y avisa cuando la config no es segura.
 *
 * 🔴 FALLA CERRADO. Si `scope` no es `"all"` y no hay lista de productos, no
 * devuelve todas las líneas: devuelve ninguna y un motivo. Los tres casos que
 * llegan acá con la lista vacía son (1) una campaña mal guardada, (2) una
 * colección que se quedó sin productos y (3) un metafield viejo escrito antes
 * de que existiera `scope` — y en los tres, descontar todo el catálogo es el
 * peor resultado posible.
 */
export function filtrarLineasEnAlcance(
  lines: OriginalPriceLine[],
  scope: OriginalPriceScope | undefined,
  productIds: string[] | undefined
): { enAlcance: OriginalPriceLine[]; motivo: "scope-vacio-sin-all" | null } {
  const todas = Array.isArray(lines) ? lines : [];
  const incluidos = new Set(
    (Array.isArray(productIds) ? productIds : []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    )
  );

  if (scope === "all") return { enAlcance: todas, motivo: null };

  if (incluidos.size === 0) return { enAlcance: [], motivo: "scope-vacio-sin-all" };

  const enAlcance = todas.filter(
    (l) =>
      typeof l?.productId === "string" &&
      l.productId.length > 0 &&
      incluidos.has(l.productId)
  );
  return { enAlcance, motivo: null };
}

/**
 * Comprueba los requisitos mínimos sobre las líneas EN ALCANCE.
 *
 * Separado del cálculo para que el formulario del admin pueda decir si un
 * carrito calificaría con exactamente la misma cuenta que hace el checkout.
 */
export function comprobarMinimos(
  lines: OriginalPriceLine[],
  min: OriginalPriceMinimums | undefined
): { ok: true } | { ok: false; reason: "BELOW_MIN_SUBTOTAL" | "BELOW_MIN_QUANTITY" } {
  const minSubtotal =
    typeof min?.minSubtotal === "number" &&
    Number.isFinite(min.minSubtotal) &&
    min.minSubtotal > 0
      ? min.minSubtotal
      : null;
  const minQuantity =
    typeof min?.minQuantity === "number" &&
    Number.isFinite(min.minQuantity) &&
    min.minQuantity > 0
      ? Math.floor(min.minQuantity)
      : null;

  if (minSubtotal === null && minQuantity === null) return { ok: true };

  let subtotalCents = 0;
  let unidades = 0;
  for (const l of lines) {
    if (!l || typeof l.unitPrice !== "number" || !Number.isFinite(l.unitPrice)) continue;
    if (l.unitPrice <= 0) continue;
    const qty =
      typeof l.quantity === "number" && Number.isFinite(l.quantity) && l.quantity > 0
        ? Math.floor(l.quantity)
        : 1;
    subtotalCents += toCents(l.unitPrice) * qty;
    unidades += qty;
  }

  // En centavos, no en decimales: un carrito de $99,99 no puede "llegar" a un
  // mínimo de $100 por la deriva de la coma flotante.
  if (minSubtotal !== null && subtotalCents < toCents(minSubtotal))
    return { ok: false, reason: "BELOW_MIN_SUBTOTAL" };
  if (minQuantity !== null && unidades < minQuantity)
    return { ok: false, reason: "BELOW_MIN_QUANTITY" };

  return { ok: true };
}

/**
 * Una campaña de monto de compra que el merchant excluyó, con lo justo para
 * saber si está aplicando.
 */
export type ExclusionPorMonto = {
  campaignId: string;
  /** El umbral MÁS BAJO de esa campaña. Por encima, descuenta siempre. */
  minSubtotal: number;
};

/**
 * ¿Está aplicando alguna de las campañas de monto de compra que el merchant
 * excluyó?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 POR QUÉ SE RECALCULA EN VEZ DE MIRAR QUÉ APLICÓ
 *
 * La Discount Function API ofrece `cart.discountApplications` y
 * `cart.lines[].discountAllocations`, que traen los descuentos ya aplicados y
 * permiten leerles el metafield. Sería el camino elegante: mirar la realidad en
 * vez de deducirla.
 *
 * No se usa, y el motivo es que **no está confirmado que un descuento generado
 * por otra Function en la misma pasada de evaluación aparezca ahí**. Si no
 * apareciera, la casilla del merchant no haría nada y NADIE se enteraría — el
 * descuento se aplicaría doble y el fallo sería mudo. Es exactamente la familia
 * de fallo que este repo ya pagó cuatro veces.
 *
 * Recalcular no tiene esa duda. Y no es una aproximación: se compara contra
 * `cart.cost.subtotalAmount`, que es **el mismísimo campo** que lee la Function
 * de monto de compra para decidir, en el mismo instante y con el mismo valor.
 * Si esa Function descuenta, este número dice que descuenta.
 *
 * ⚠️ Lo que sí implica: el umbral viaja como una FOTO en el metafield del cupón.
 * Si el merchant cambia los niveles de la campaña de monto, hay que volver a
 * guardar el cupón para que la foto se actualice. El formulario lo dice.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function evaluarExclusionPorMonto(
  subtotal: number | null | undefined,
  exclusiones: ExclusionPorMonto[] | undefined
): { excluido: false } | { excluido: true; campaignId: string; minSubtotal: number } {
  const lista = Array.isArray(exclusiones) ? exclusiones : [];
  if (lista.length === 0) return { excluido: false };

  // Sin subtotal legible no se puede afirmar que la otra campaña esté
  // aplicando. La duda deja pasar el cupón: el merchant pidió quitarlo en un
  // caso concreto, y ante la incertidumbre lo que se respeta es el
  // comportamiento por defecto, que es que el cupón funcione.
  if (typeof subtotal !== "number" || !Number.isFinite(subtotal)) {
    return { excluido: false };
  }

  const subtotalCents = toCents(subtotal);

  for (const ex of lista) {
    if (!ex || typeof ex.minSubtotal !== "number" || !Number.isFinite(ex.minSubtotal)) continue;
    if (ex.minSubtotal <= 0) continue;
    // En centavos y con `>=`, igual que `cart-value-calc`: un carrito de $100
    // exactos SÍ alcanza un umbral de $100, y $99,99 no.
    if (subtotalCents >= toCents(ex.minSubtotal)) {
      return {
        excluido: true,
        campaignId: typeof ex.campaignId === "string" ? ex.campaignId : "",
        minSubtotal: ex.minSubtotal,
      };
    }
  }

  return { excluido: false };
}

// ─── Constantes ───────────────────────────────────────────────────────────────

export const MIN_ORIGINAL_PRICE_PERCENT = 1;
export const MAX_ORIGINAL_PRICE_PERCENT = 99;

// ─── Dinero ───────────────────────────────────────────────────────────────────

function toCents(v: number): number {
  return Math.round(v * 100);
}

function applyPercentCents(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}

// ─── Cálculo ──────────────────────────────────────────────────────────────────

/**
 * La base de una línea: el precio comparativo si sirve, si no el actual.
 *
 * Se exige que el comparativo sea MAYOR que el precio actual. Un comparativo
 * igual o menor no describe ninguna rebaja —es dato viejo o mal cargado— y
 * usarlo daría un descuento menor que el normal, que es lo contrario de lo que
 * el merchant pidió.
 */
export function resolveBasePrice(line: OriginalPriceLine): {
  basePrice: number;
  usedCompareAt: boolean;
} {
  const compareAt = line.compareAtUnitPrice;
  if (
    typeof compareAt === "number" &&
    Number.isFinite(compareAt) &&
    compareAt > line.unitPrice
  ) {
    return { basePrice: compareAt, usedCompareAt: true };
  }
  return { basePrice: line.unitPrice, usedCompareAt: false };
}

/**
 * Resuelve el cupón para un conjunto de líneas.
 *
 * `percent` es el del cupón (10 = 10%). Las líneas que llegan acá ya están
 * filtradas por quien llama: esta función no decide a QUÉ productos aplica.
 */
export function computeOriginalPriceDiscount(
  percent: number,
  lines: OriginalPriceLine[],
  minimos?: OriginalPriceMinimums
): OriginalPriceOutcome {
  if (typeof percent !== "number" || !Number.isFinite(percent))
    return { applies: false, reason: "NO_CONFIG" };
  if (percent <= 0) return { applies: false, reason: "ZERO_PERCENT" };

  // Los mínimos se comprueban ANTES de calcular un solo peso, y sobre las
  // líneas que ya vienen filtradas por alcance. Así el motivo que queda en el
  // log es el de verdad y no "NOTHING_TO_DISCOUNT", que no explica nada.
  const minimo = comprobarMinimos(lines, minimos);
  if (!minimo.ok) return { applies: false, reason: minimo.reason };

  const pct = Math.min(percent, MAX_ORIGINAL_PRICE_PERCENT);

  const out: OriginalPriceLineResult[] = [];
  let savingsCents = 0;
  let normalCents = 0;

  for (const line of lines) {
    if (!line || typeof line.lineId !== "string" || !line.lineId) continue;
    if (typeof line.unitPrice !== "number" || !Number.isFinite(line.unitPrice)) continue;
    if (line.unitPrice <= 0) continue;

    const qty =
      typeof line.quantity === "number" && Number.isFinite(line.quantity) && line.quantity > 0
        ? Math.floor(line.quantity)
        : 1;

    const { basePrice, usedCompareAt } = resolveBasePrice(line);

    const unitCents = toCents(line.unitPrice);
    let descuentoCents = applyPercentCents(toCents(basePrice), pct);

    // 🔴 El recorte. Un descuento mayor que el precio de la línea dejaría el
    // total en negativo. Shopify lo rechazaría o lo recortaría por su cuenta;
    // recortarlo acá lo hace explícito y visible en el preview del admin.
    const clamped = descuentoCents > unitCents;
    if (clamped) descuentoCents = unitCents;

    if (descuentoCents <= 0) continue;

    out.push({
      lineId: line.lineId,
      discountPerUnit: descuentoCents / 100,
      basePrice,
      usedCompareAt,
      clamped,
    });

    savingsCents += descuentoCents * qty;
    // Lo que habría descontado un cupón normal de Shopify: el % sobre el precio
    // actual. La diferencia es lo que aporta este tipo de campaña.
    normalCents += applyPercentCents(unitCents, pct) * qty;
  }

  if (out.length === 0) return { applies: false, reason: "NOTHING_TO_DISCOUNT" };

  return {
    applies: true,
    lines: out,
    totalSavings: savingsCents / 100,
    extraVsPercent: (savingsCents - normalCents) / 100,
  };
}

// ─── Validación (formulario del admin) ────────────────────────────────────────

export type OriginalPriceValidation = { errors: string[]; warnings: string[] };

export function validateOriginalPrice(percent: number): OriginalPriceValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0) {
    errors.push("Poné un porcentaje de descuento mayor que 0.");
  } else if (percent > MAX_ORIGINAL_PRICE_PERCENT) {
    errors.push(`El descuento máximo es ${MAX_ORIGINAL_PRICE_PERCENT}%.`);
  } else if (percent >= 50) {
    warnings.push(
      `Un ${percent}% sobre el precio original es mucho: en un producto ya rebajado ` +
        "puede dejar la línea en cero. El descuento se recorta para no pasarse, " +
        "pero conviene revisarlo."
    );
  }

  return { errors, warnings };
}
