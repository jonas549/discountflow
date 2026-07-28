// Calculadora pura de descuentos escalonados (campañas TIERED).
//
// SIN dependencias, a propósito: este módulo corre en DOS entornos distintos
//   1. el servidor / navegador del admin  → preview de la campaña
//   2. dentro de la Shopify Function (JS → Wasm) → cálculo real del checkout
// Por eso no puede importar nada de Node, Prisma, React ni Shopify.
//
// Es la ÚNICA fuente de verdad del cálculo. Si algún día el preview y el
// checkout muestran números distintos, es porque alguien dejó de usar este
// archivo en uno de los dos lados.
//
// Dinero: todo el cálculo interno se hace en CENTAVOS enteros para que no
// haya deriva de coma flotante. Se vuelve a decimal solo al devolver.

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type TierMode = "UNIFORM" | "INCREMENTAL";

/** Un nivel de la curva: "desde `minQty` unidades, `percent`% de descuento". */
export type Tier = {
  minQty: number;
  percent: number;
};

/** Línea del carrito YA filtrada como aplicable a la campaña. */
export type ApplicableLine = {
  lineId: string;
  /** Precio unitario en la moneda de presentación del carrito. */
  unitPrice: number;
  quantity: number;
};

export type UniformLineResult = { lineId: string; percent: number };
export type IncrementalLineResult = { lineId: string; discountAmount: number };

export type NoDiscountReason =
  | "no-tiers"
  | "no-lines"
  | "below-first-tier"
  | "zero-discount";

export type TieredOutcome =
  | { applies: false; reason: NoDiscountReason }
  | {
      applies: true;
      mode: "UNIFORM";
      totalQuantity: number;
      tier: Tier;
      lines: UniformLineResult[];
    }
  | {
      applies: true;
      mode: "INCREMENTAL";
      totalQuantity: number;
      totalDiscount: number;
      lines: IncrementalLineResult[];
    };

/**
 * 0 es un valor VÁLIDO y significativo: "desde esta cantidad, sin descuento".
 * Sirve para dejar la primera unidad a precio normal (1ª 0%, 2ª 10%…) y para
 * cortar el descuento a partir de cierta cantidad.
 */
export const MIN_TIER_PERCENT = 0;
export const MAX_TIER_PERCENT = 99;

// ─── Helpers de dinero ────────────────────────────────────────────────────────

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

// ─── Tiers ────────────────────────────────────────────────────────────────────

/**
 * Deja los tiers en forma canónica: descarta basura, ordena ascendente por
 * minQty y colapsa duplicados (gana el último declarado).
 *
 * ⚠️ Un nivel al 0% SE CONSERVA. Antes se descartaba junto con la basura
 * (`percent <= 0`), y ese descarte no era neutral: al desaparecer el nivel, las
 * unidades que le correspondían HEREDABAN el porcentaje del nivel anterior. Un
 * "desde 3 unidades, 0%" acababa descontando lo mismo que el nivel de 2.
 *
 * El 0 es un interruptor con significado propio —"desde aquí, precio normal"—
 * y solo funciona si sobrevive hasta `percentsByUnitIndex`. Lo que sí se
 * descarta es lo que no es un porcentaje: negativos y valores no finitos.
 */
export function normalizeTiers(tiers: Tier[] | null | undefined): Tier[] {
  const byQty = new Map<number, Tier>();
  for (const t of tiers ?? []) {
    if (!t) continue;
    if (!Number.isFinite(t.minQty) || !Number.isFinite(t.percent)) continue;
    const minQty = Math.floor(t.minQty);
    if (minQty < 1 || t.percent < 0) continue;
    byQty.set(minQty, { minQty, percent: t.percent });
  }
  return [...byQty.values()].sort((a, b) => a.minQty - b.minQty);
}

/** Tier vigente para una cantidad dada: el de mayor minQty que la cantidad alcanza. */
export function resolveTier(
  tiers: Tier[] | null | undefined,
  quantity: number
): Tier | null {
  return resolveTierSorted(normalizeTiers(tiers), quantity);
}

function resolveTierSorted(sorted: Tier[], quantity: number): Tier | null {
  let found: Tier | null = null;
  for (const t of sorted) {
    if (t.minQty > quantity) break;
    found = t;
  }
  return found;
}

/**
 * Porcentaje que le toca a cada unidad según su posición (1ª, 2ª, 3ª…).
 * Una sola pasada O(n) — importa porque esto corre dentro del presupuesto de
 * instrucciones de la Function.
 *
 * Las unidades que superan el último tier conservan el % del último tier.
 */
function percentsByUnitIndex(sorted: Tier[], unitCount: number): number[] {
  const out: number[] = new Array(unitCount).fill(0);
  let tierIdx = 0;
  let current = 0;
  for (let position = 1; position <= unitCount; position++) {
    while (tierIdx < sorted.length && sorted[tierIdx].minQty <= position) {
      current = sorted[tierIdx].percent;
      tierIdx++;
    }
    out[position - 1] = current;
  }
  return out;
}

// ─── Cálculo ──────────────────────────────────────────────────────────────────

/**
 * Punto de entrada único. Recibe las líneas YA filtradas como aplicables y
 * devuelve qué descuento aplicar a cada una.
 *
 *  - UNIFORM     → un % por línea (se traduce a `percentage` en la Function)
 *  - INCREMENTAL → un importe por línea (se traduce a `fixedAmount`)
 */
export function computeTiered(
  mode: TierMode,
  tiers: Tier[] | null | undefined,
  lines: ApplicableLine[] | null | undefined
): TieredOutcome {
  const sorted = normalizeTiers(tiers);
  if (sorted.length === 0) return { applies: false, reason: "no-tiers" };

  const valid = (lines ?? []).filter(
    (l) =>
      !!l &&
      Number.isFinite(l.unitPrice) &&
      l.unitPrice >= 0 &&
      Number.isFinite(l.quantity) &&
      Math.floor(l.quantity) >= 1
  );
  if (valid.length === 0) return { applies: false, reason: "no-lines" };

  const totalQuantity = valid.reduce((sum, l) => sum + Math.floor(l.quantity), 0);
  if (totalQuantity < sorted[0].minQty)
    return { applies: false, reason: "below-first-tier" };

  return mode === "UNIFORM"
    ? computeUniform(sorted, valid, totalQuantity)
    : computeIncremental(sorted, valid, totalQuantity);
}

/** MODO A — al alcanzar el tier, TODAS las unidades aplicables reciben ese %. */
function computeUniform(
  sorted: Tier[],
  lines: ApplicableLine[],
  totalQuantity: number
): TieredOutcome {
  const tier = resolveTierSorted(sorted, totalQuantity);
  if (!tier) return { applies: false, reason: "below-first-tier" };

  // Un nivel al 0% significa "sin descuento", así que no hay nada que emitir.
  // Sin este corte se generaría un descuento de valor 0 y el comprador vería
  // una línea de "-$0.00" en su carrito. El modo INCREMENTAL ya se protege por
  // su cuenta (descarta las unidades al 0% y aborta si el total queda a cero).
  if (tier.percent <= 0) return { applies: false, reason: "zero-discount" };

  return {
    applies: true,
    mode: "UNIFORM",
    totalQuantity,
    tier,
    lines: lines.map((l) => ({ lineId: l.lineId, percent: tier.percent })),
  };
}

/**
 * MODO B — cada unidad individual tiene su propio %, según su posición.
 *
 * REGLA DE PRODUCTO (decidida 2026-07-24): el % más alto va a la unidad MÁS
 * BARATA. Como los tiers crecen con la cantidad, basta con ordenar las
 * unidades de más cara a más barata: la que queda al final de la fila —la más
 * barata— recibe el porcentaje más alto.
 *
 * Empate de precio → desempate estable por lineId, para que el preview del
 * admin y el checkout produzcan SIEMPRE el mismo número.
 *
 * No se emite un descuento por unidad: se suma el dinero por línea y se emite
 * un único importe por línea. Así se evita depender de cómo Shopify resuelve
 * varios targets solapados sobre la misma línea del carrito.
 */
function computeIncremental(
  sorted: Tier[],
  lines: ApplicableLine[],
  totalQuantity: number
): TieredOutcome {
  const units: Array<{ lineId: string; cents: number }> = [];
  for (const line of lines) {
    const cents = toCents(line.unitPrice);
    const qty = Math.floor(line.quantity);
    for (let i = 0; i < qty; i++) units.push({ lineId: line.lineId, cents });
  }

  units.sort((a, b) => {
    if (b.cents !== a.cents) return b.cents - a.cents;
    return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
  });

  const percents = percentsByUnitIndex(sorted, units.length);

  const discountByLine = new Map<string, number>();
  let totalCents = 0;
  for (let i = 0; i < units.length; i++) {
    const percent = percents[i];
    if (percent <= 0) continue;
    const discount = Math.round((units[i].cents * percent) / 100);
    if (discount <= 0) continue;
    discountByLine.set(
      units[i].lineId,
      (discountByLine.get(units[i].lineId) ?? 0) + discount
    );
    totalCents += discount;
  }

  if (totalCents === 0) return { applies: false, reason: "zero-discount" };

  // Se devuelve en el orden original de las líneas del carrito.
  const seen = new Set<string>();
  const result: IncrementalLineResult[] = [];
  for (const line of lines) {
    if (seen.has(line.lineId)) continue;
    seen.add(line.lineId);
    const cents = discountByLine.get(line.lineId);
    if (cents && cents > 0)
      result.push({ lineId: line.lineId, discountAmount: fromCents(cents) });
  }

  return {
    applies: true,
    mode: "INCREMENTAL",
    totalQuantity,
    totalDiscount: fromCents(totalCents),
    lines: result,
  };
}

// ─── Validación (para el formulario del admin) ────────────────────────────────

export type TierValidation = { errors: string[]; warnings: string[] };

export function validateTiers(tiers: Tier[] | null | undefined): TierValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const list = tiers ?? [];

  if (list.length === 0) {
    errors.push("Agrega al menos un nivel de descuento.");
    return { errors, warnings };
  }

  const seenQty = new Set<number>();
  for (const t of list) {
    if (!Number.isInteger(t.minQty) || t.minQty < 1) {
      errors.push("La cantidad de cada nivel debe ser un número entero de 1 o más.");
    } else if (seenQty.has(t.minQty)) {
      errors.push(`Hay más de un nivel con la misma cantidad (${t.minQty}).`);
    } else {
      seenQty.add(t.minQty);
    }

    if (
      !Number.isFinite(t.percent) ||
      t.percent < MIN_TIER_PERCENT ||
      t.percent > MAX_TIER_PERCENT
    ) {
      errors.push(
        `El descuento de cada nivel debe estar entre ${MIN_TIER_PERCENT}% y ${MAX_TIER_PERCENT}%.`
      );
    }
  }

  const sorted = normalizeTiers(list);

  // Todos los niveles al 0% = una campaña que no descuenta nada. Se bloquea
  // aquí porque es una línea y evita una campaña activa y muda; un 0% suelto
  // entre niveles con descuento es legítimo y no se toca.
  if (sorted.length > 0 && sorted.every((t) => t.percent === 0)) {
    errors.push("Al menos un nivel debe tener un descuento mayor que 0%.");
  }

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].percent < sorted[i - 1].percent) {
      warnings.push(
        sorted[i].percent === 0
          ? `Desde ${sorted[i].minQty} unidades no se aplica descuento. ¿Es intencional?`
          : `El nivel de ${sorted[i].minQty} unidades descuenta menos que el de ${sorted[i - 1].minQty}. ¿Es intencional?`
      );
    }
  }

  // Sin duplicar mensajes idénticos.
  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}

// ─── Preview del admin ────────────────────────────────────────────────────────

export type PreviewRow = {
  quantity: number;
  /** % del nivel vigente a esa cantidad (el que aplica a la última unidad). */
  percent: number;
  subtotal: number;
  saved: number;
  total: number;
  /** true en la fila extra que demuestra que el último nivel se mantiene. */
  isBeyondLastTier: boolean;
};

/**
 * Construye la tabla del preview llamando al MISMO computeTiered que usará el
 * checkout. No replica la lógica: la ejecuta. Por eso el preview no puede
 * mentir.
 */
export function buildPreviewRows(
  mode: TierMode,
  tiers: Tier[] | null | undefined,
  unitPrice: number
): PreviewRow[] {
  const sorted = normalizeTiers(tiers);
  if (sorted.length === 0) return [];

  const quantities = sorted.map((t) => t.minQty);
  const lastQty = quantities[quantities.length - 1];
  quantities.push(lastQty + 1); // fila "N+1" → el tope se mantiene

  return quantities.map((quantity, idx) => {
    const outcome = computeTiered(mode, sorted, [
      { lineId: "preview", unitPrice, quantity },
    ]);

    const subtotalCents = toCents(unitPrice) * quantity;
    let savedCents = 0;
    if (outcome.applies) {
      savedCents =
        outcome.mode === "UNIFORM"
          ? Math.round((subtotalCents * outcome.tier.percent) / 100)
          : toCents(outcome.totalDiscount);
    }

    return {
      quantity,
      percent: resolveTierSorted(sorted, quantity)?.percent ?? 0,
      subtotal: fromCents(subtotalCents),
      saved: fromCents(savedCents),
      total: fromCents(subtotalCents - savedCents),
      isBeyondLastTier: idx === quantities.length - 1,
    };
  });
}
