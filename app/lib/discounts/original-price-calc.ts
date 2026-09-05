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
  | "NOTHING_TO_DISCOUNT";

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
  lines: OriginalPriceLine[]
): OriginalPriceOutcome {
  if (typeof percent !== "number" || !Number.isFinite(percent))
    return { applies: false, reason: "NO_CONFIG" };
  if (percent <= 0) return { applies: false, reason: "ZERO_PERCENT" };

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
