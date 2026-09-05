// Calculadora pura de descuentos por VALOR DE CARRITO.
//
// "Gastá $100 y ahorrás $10", con niveles escalonados por monto del carrito.
//
// SIN dependencias, a propósito: este módulo corre en DOS entornos
//   1. el servidor / navegador del admin       → preview de la campaña
//   2. dentro de la Shopify Function (JS → Wasm) → cálculo real del checkout
//
// 🔴 AUNQUE VIVA EN app/, ESTE ARCHIVO SE COMPILA DENTRO DEL WASM.
//    La Function lo importa (`extensions/order-discount/src/...run.ts`), así que
//    cualquier cambio aquí EXIGE desplegar la Function. Es la misma trampa de
//    `tiered-calc.ts` y `pack-calc.ts`.
//
// Dinero: en CENTAVOS enteros. 45,50 al 15% da 38,674999… en float64.

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** En qué se mide el descuento del nivel. Ortogonal al umbral. */
export type CartValueType = "PERCENT" | "AMOUNT";

/**
 * Un nivel: "desde `minSubtotal` de carrito, este descuento".
 *
 * `minSubtotal` va en unidades de moneda, no en centavos: es lo que el merchant
 * escribe en el formulario y lo que viaja en el metafield.
 */
export type CartValueTier = {
  minSubtotal: number;
  /** Descuento en % del subtotal. Se usa cuando el valueType es PERCENT. */
  percent?: number;
  /** Descuento en dinero. Se usa cuando el valueType es AMOUNT. */
  amount?: number;
};

/** Qué falta para el siguiente nivel. */
export type CartValueNextTier = {
  /** Cuánto más hay que gastar. Siempre > 0. */
  faltante: number;
  /** El umbral del nivel que se desbloquea. */
  minSubtotal: number;
  percent?: number;
  amount?: number;
};

export type CartValueNoDiscountReason =
  | "NO_CONFIG"
  /** El carrito no llega al primer umbral. */
  | "BELOW_FIRST_TIER"
  /** Llega, pero el nivel vigente descuenta 0. */
  | "TIER_AT_ZERO";

export type CartValueOutcome =
  | {
      applies: false;
      reason: CartValueNoDiscountReason;
      subtotal: number;
      nextTier: CartValueNextTier | null;
    }
  | {
      applies: true;
      /** Único discriminador de qué emitir. */
      emit: "PERCENTAGE" | "FIXED_AMOUNT";
      /** Solo con emit PERCENTAGE. */
      percent: number | null;
      /** Solo con emit FIXED_AMOUNT, ya recortado para no superar el subtotal. */
      amount: number | null;
      subtotal: number;
      /** El nivel que se aplicó. */
      tier: CartValueTier;
      nextTier: CartValueNextTier | null;
    };

// ─── Constantes ───────────────────────────────────────────────────────────────

export const MIN_CART_VALUE_PERCENT = 0;
export const MAX_CART_VALUE_PERCENT = 99;

/** Máximo de niveles. Más de esto nadie lo entiende ni lo configura bien. */
export const MAX_CART_VALUE_TIERS = 5;

// ─── Normalización ────────────────────────────────────────────────────────────

/**
 * Ordena y sanea los niveles.
 *
 * Descarta los no finitos, los negativos y los que no traen el campo de su tipo
 * — igual que `normalizeTiers` de los escalonados, y por el mismo motivo: un
 * nivel al que le falta su valor es basura, pero un nivel EN CERO es un
 * interruptor con significado ("desde aquí, sin descuento") y se conserva.
 *
 * Deduplica por umbral quedándose con el ÚLTIMO, que es el que el merchant
 * escribió más abajo en el formulario.
 */
export function normalizeCartValueTiers(
  raw: unknown,
  valueType: CartValueType
): CartValueTier[] {
  if (!Array.isArray(raw)) return [];

  const porUmbral = new Map<number, CartValueTier>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as CartValueTier;

    if (typeof t.minSubtotal !== "number" || !Number.isFinite(t.minSubtotal)) continue;
    if (t.minSubtotal < 0) continue;

    if (valueType === "PERCENT") {
      if (typeof t.percent !== "number" || !Number.isFinite(t.percent)) continue;
      if (t.percent < 0) continue;
      porUmbral.set(t.minSubtotal, {
        minSubtotal: t.minSubtotal,
        percent: Math.min(t.percent, MAX_CART_VALUE_PERCENT),
      });
    } else {
      if (typeof t.amount !== "number" || !Number.isFinite(t.amount)) continue;
      if (t.amount < 0) continue;
      porUmbral.set(t.minSubtotal, { minSubtotal: t.minSubtotal, amount: t.amount });
    }
  }

  return [...porUmbral.values()].sort((a, b) => a.minSubtotal - b.minSubtotal);
}

/** El nivel vigente para un subtotal, o `null` si no llega al primero. */
export function resolveCartValueTier(
  tiers: CartValueTier[],
  subtotal: number
): CartValueTier | null {
  let vigente: CartValueTier | null = null;
  for (const t of tiers) {
    if (subtotal >= t.minSubtotal) vigente = t;
    else break;
  }
  return vigente;
}

/** El siguiente nivel por encima del vigente, o `null` si ya está en el tope. */
export function resolveNextCartValueTier(
  tiers: CartValueTier[],
  subtotal: number
): CartValueNextTier | null {
  for (const t of tiers) {
    if (t.minSubtotal > subtotal) {
      return {
        faltante: redondearCentavos(t.minSubtotal - subtotal),
        minSubtotal: t.minSubtotal,
        percent: t.percent,
        amount: t.amount,
      };
    }
  }
  return null;
}

// ─── Dinero ───────────────────────────────────────────────────────────────────

const aCentavos = (n: number) => Math.round(n * 100);
const redondearCentavos = (n: number) => Math.round(n * 100) / 100;

/**
 * Cuánto descuenta un nivel sobre un subtotal, en unidades de moneda.
 *
 * ⚠️ `Math.round(x * 100) / 100` sobre el resultado NO basta: hay que pasar a
 * centavos ANTES de multiplicar. Es la lección del medio centavo del 2026-08-08.
 */
export function cartValueDiscount(
  tier: CartValueTier,
  valueType: CartValueType,
  subtotal: number
): number {
  const subtotalCents = aCentavos(subtotal);
  if (subtotalCents <= 0) return 0;

  if (valueType === "PERCENT") {
    const pct = tier.percent ?? 0;
    if (pct <= 0) return 0;
    return Math.round((subtotalCents * pct) / 100) / 100;
  }

  const amountCents = aCentavos(tier.amount ?? 0);
  if (amountCents <= 0) return 0;
  // 🔴 Nunca más que el subtotal: un descuento mayor dejaría el pedido en
  // negativo o en cero. El formulario ya avisa, pero la Function no puede
  // confiar en que el metafield venga bien — puede ser de una campaña vieja.
  return Math.min(amountCents, subtotalCents) / 100;
}

// ─── El cálculo ───────────────────────────────────────────────────────────────

/**
 * Resuelve el descuento por valor de carrito.
 *
 * 🔴 SOBRE QUÉ SUBTOTAL SE MIDE — decisión de producto del 2026-09-05 (opción B)
 *
 * Se mide sobre el subtotal YA REBAJADO: un carrito de $110 con $15 de descuento
 * de producto vale $95 y NO llega al umbral de $100.
 *
 * Tres razones: es lo que hace Shopify de forma nativa (el orden de cálculo es
 * producto → orden, y un descuento de orden opera sobre el subtotal revisado);
 * protege el margen, que es el fallo caro cuando dos campañas se apilan; y
 * coincide con el número que el comprador ve en pantalla.
 *
 * Esta función NO decide qué subtotal es ése: lo recibe. Quién lo elige es el
 * llamador —la Function lo toma de `cart.cost.subtotalAmount`— justamente para
 * que la regla se pueda probar sin un carrito.
 */
export function computeCartValue(
  valueType: CartValueType,
  tiers: CartValueTier[],
  subtotal: number
): CartValueOutcome {
  const normalizados = normalizeCartValueTiers(tiers, valueType);

  if (normalizados.length === 0)
    return { applies: false, reason: "NO_CONFIG", subtotal, nextTier: null };

  if (!Number.isFinite(subtotal) || subtotal <= 0)
    return {
      applies: false,
      reason: "BELOW_FIRST_TIER",
      subtotal: 0,
      nextTier: resolveNextCartValueTier(normalizados, 0),
    };

  const tier = resolveCartValueTier(normalizados, subtotal);
  if (!tier)
    return {
      applies: false,
      reason: "BELOW_FIRST_TIER",
      subtotal,
      nextTier: resolveNextCartValueTier(normalizados, subtotal),
    };

  const descuento = cartValueDiscount(tier, valueType, subtotal);
  if (descuento <= 0)
    return {
      applies: false,
      // El nivel existe y se alcanzó, pero descuenta 0. Se distingue de "no
      // llegó" a propósito: son dos cosas distintas para quien depure, y emitir
      // un descuento de valor cero le mostraría "-$0.00" al comprador.
      reason: "TIER_AT_ZERO",
      subtotal,
      nextTier: resolveNextCartValueTier(normalizados, subtotal),
    };

  return {
    applies: true,
    emit: valueType === "PERCENT" ? "PERCENTAGE" : "FIXED_AMOUNT",
    percent: valueType === "PERCENT" ? tier.percent ?? 0 : null,
    amount: valueType === "AMOUNT" ? descuento : null,
    subtotal,
    tier,
    nextTier: resolveNextCartValueTier(normalizados, subtotal),
  };
}

/** Lo que ahorra el carrito con este outcome, en unidades de moneda. */
export function cartValueSavings(
  outcome: CartValueOutcome,
  valueType: CartValueType
): number {
  if (!outcome.applies) return 0;
  return cartValueDiscount(outcome.tier, valueType, outcome.subtotal);
}

// ─── Validación (formulario del admin) ────────────────────────────────────────

export type CartValueValidation = { errors: string[]; warnings: string[] };

export function validateCartValue(
  valueType: CartValueType,
  tiers: CartValueTier[]
): CartValueValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalizados = normalizeCartValueTiers(tiers, valueType);

  if (normalizados.length === 0) {
    errors.push("Agregá al menos un nivel de descuento.");
    return { errors, warnings };
  }

  if (normalizados.length > MAX_CART_VALUE_TIERS)
    errors.push(
      `Máximo ${MAX_CART_VALUE_TIERS} niveles. Definiste ${normalizados.length}.`
    );

  const valorDe = (t: CartValueTier) =>
    valueType === "PERCENT" ? t.percent ?? 0 : t.amount ?? 0;

  if (normalizados.every((t) => valorDe(t) <= 0))
    errors.push("Todos los niveles están en cero: la campaña no descontaría nada.");

  if (normalizados[0].minSubtotal <= 0)
    warnings.push(
      "El primer nivel arranca en 0: el descuento aplicaría a cualquier carrito, por chico que sea."
    );

  for (let i = 1; i < normalizados.length; i++) {
    if (valorDe(normalizados[i]) < valorDe(normalizados[i - 1])) {
      warnings.push(
        `El nivel de ${normalizados[i].minSubtotal} descuenta menos que el anterior. Revisá que sea intencional.`
      );
      break;
    }
  }

  if (valueType === "AMOUNT") {
    // 🔴 Un monto mayor o igual que su propio umbral deja el carrito en cero (o
    // lo dejaría en negativo si no se recortara). "Gastá $50 y ahorrá $70" no es
    // una oferta, es un regalo con pasos de más.
    for (const t of normalizados) {
      if ((t.amount ?? 0) >= t.minSubtotal && t.minSubtotal > 0) {
        errors.push(
          `El nivel de ${t.minSubtotal} descuenta ${t.amount}, que iguala o supera su propio umbral: el carrito quedaría en cero.`
        );
        break;
      }
    }
  }

  return { errors, warnings };
}
