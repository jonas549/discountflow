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
// 🔴 AUNQUE VIVA EN app/, ESTE ARCHIVO SE COMPILA DENTRO DEL WASM.
//    La Function lo importa (`extensions/tiered-discount/src/...run.ts`), así que
//    cualquier cambio aquí EXIGE desplegar la Function. Ya mordió una vez: los
//    niveles al 0% se entregaron con la premisa "no toca la Function" y era falsa.
//
// Dinero: todo el cálculo interno se hace en CENTAVOS enteros para que no
// haya deriva de coma flotante. Se vuelve a decimal solo al devolver.

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type TierMode = "UNIFORM" | "INCREMENTAL";

/**
 * En qué unidad se expresa el descuento de los niveles.
 *
 * Es un eje ORTOGONAL a `TierMode`: el modo dice cómo se REPARTE el descuento
 * (a todas las unidades o según la posición de cada una) y esto dice en qué se
 * MIDE (porcentaje o dinero). Las cuatro combinaciones son válidas.
 *
 * Una campaña es entera de un tipo: no se mezclan niveles en % con niveles en
 * dinero. Simplifica la validación y es lo que el merchant espera al leerla.
 *
 * ⚠️ Ausente = "PERCENT". Es lo que mantiene vivas las campañas creadas antes de
 *    que esto existiera: su metafield no trae el campo.
 */
export type TierValueType = "PERCENT" | "AMOUNT";

/**
 * Un nivel de la curva: "desde `minQty` unidades, este descuento".
 *
 * Solo uno de los dos campos de valor es significativo, según el `TierValueType`
 * de la campaña. Ambos son opcionales porque un nivel en dinero no tiene
 * porcentaje, y al revés — modelarlo con los dos obligatorios sería mentir.
 */
export type Tier = {
  minQty: number;
  /** Descuento en % de la unidad. Se usa cuando el valueType es PERCENT. */
  percent?: number;
  /** Descuento en dinero POR UNIDAD. Se usa cuando el valueType es AMOUNT. */
  amount?: number;
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

/**
 * `emit` dice QUÉ tiene que generar la Function, y es el único campo por el que
 * debe ramificar. Antes ramificaba por `mode`, y eso dejó de ser suficiente en
 * cuanto UNIFORM pudo producir importes además de porcentajes.
 *
 *   UNIFORM     + PERCENT →  PERCENTAGE     (un % por línea)
 *   UNIFORM     + AMOUNT  →  FIXED_AMOUNT   (dinero × unidades de la línea)
 *   INCREMENTAL + PERCENT →  FIXED_AMOUNT   (suma de las unidades de la línea)
 *   INCREMENTAL + AMOUNT  →  FIXED_AMOUNT   (ídem)
 */
export type TieredOutcome =
  | { applies: false; reason: NoDiscountReason }
  | {
      applies: true;
      emit: "PERCENTAGE";
      mode: "UNIFORM";
      valueType: "PERCENT";
      totalQuantity: number;
      tier: Tier;
      lines: UniformLineResult[];
    }
  | {
      applies: true;
      emit: "FIXED_AMOUNT";
      mode: TierMode;
      valueType: TierValueType;
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

/** Mismo criterio que el porcentaje: 0 significa "desde aquí, precio normal". */
export const MIN_TIER_AMOUNT = 0;

/**
 * Suelo del precio tras descontar, en centavos. Igual que `MIN_PRICE` en
 * range.ts y en el motor de jobs: por debajo de esto no se baja un precio.
 */
const MIN_RESULTING_CENTS = 1;

// ─── Helpers de dinero ────────────────────────────────────────────────────────

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

// ─── Tiers ────────────────────────────────────────────────────────────────────

/**
 * El campo de valor tal cual viene, SIN rellenar el hueco.
 *
 * La diferencia con `tierValue` importa y no es cosmética: un nivel al 0 es un
 * interruptor con significado ("desde aquí, precio normal") y se conserva,
 * mientras que un nivel SIN el campo que le toca es basura para este tipo de
 * campaña y hay que descartarlo. Si se tratara la ausencia como un 0, un tier
 * incompleto dejaría de descartarse y pasaría a cortar el descuento de las
 * unidades siguientes — un cambio de comportamiento silencioso sobre las
 * campañas que ya existen.
 */
function rawTierValue(tier: Tier, valueType: TierValueType): number | undefined {
  return valueType === "AMOUNT" ? tier.amount : tier.percent;
}

/** El valor de un nivel YA normalizado, donde el campo siempre está presente. */
function tierValue(tier: Tier, valueType: TierValueType): number {
  return rawTierValue(tier, valueType) ?? 0;
}

/**
 * Deja los tiers en forma canónica: descarta basura, ordena ascendente por
 * minQty y colapsa duplicados (gana el último declarado).
 *
 * ⚠️ Un nivel al 0 SE CONSERVA. Antes se descartaba junto con la basura
 * (`percent <= 0`), y ese descarte no era neutral: al desaparecer el nivel, las
 * unidades que le correspondían HEREDABAN el valor del nivel anterior. Un
 * "desde 3 unidades, 0%" acababa descontando lo mismo que el nivel de 2.
 *
 * El 0 es un interruptor con significado propio —"desde aquí, precio normal"—
 * y solo funciona si sobrevive hasta `valuesByUnitIndex`. Lo que sí se descarta
 * es lo que no es un valor: negativos y no finitos.
 *
 * `valueType` decide QUÉ campo se mira. Por defecto PERCENT, que es lo que
 * mantiene funcionando a las campañas anteriores a los montos y a todos los
 * llamadores que no lo pasan.
 */
export function normalizeTiers(
  tiers: Tier[] | null | undefined,
  valueType: TierValueType = "PERCENT"
): Tier[] {
  const byQty = new Map<number, Tier>();
  for (const t of tiers ?? []) {
    if (!t) continue;
    if (!Number.isFinite(t.minQty)) continue;
    // Ausente o no numérico → fuera. Idéntico al `!Number.isFinite(t.percent)`
    // de antes, y es lo que hace que una campaña de montos leída como si fuera
    // de porcentajes se quede sin niveles en vez de aplicar ceros.
    const value = rawTierValue(t, valueType);
    if (value === undefined || !Number.isFinite(value)) continue;
    const minQty = Math.floor(t.minQty);
    if (minQty < 1 || value < 0) continue;
    byQty.set(
      minQty,
      valueType === "AMOUNT" ? { minQty, amount: value } : { minQty, percent: value }
    );
  }
  return [...byQty.values()].sort((a, b) => a.minQty - b.minQty);
}

/** Tier vigente para una cantidad dada: el de mayor minQty que la cantidad alcanza. */
export function resolveTier(
  tiers: Tier[] | null | undefined,
  quantity: number,
  valueType: TierValueType = "PERCENT"
): Tier | null {
  return resolveTierSorted(normalizeTiers(tiers, valueType), quantity);
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
 * Valor que le toca a cada unidad según su posición (1ª, 2ª, 3ª…).
 * Una sola pasada O(n) — importa porque esto corre dentro del presupuesto de
 * instrucciones de la Function.
 *
 * Las unidades que superan el último tier conservan el valor del último tier.
 */
function valuesByUnitIndex(
  sorted: Tier[],
  unitCount: number,
  valueType: TierValueType
): number[] {
  const out: number[] = new Array(unitCount).fill(0);
  let tierIdx = 0;
  let current = 0;
  for (let position = 1; position <= unitCount; position++) {
    while (tierIdx < sorted.length && sorted[tierIdx].minQty <= position) {
      current = tierValue(sorted[tierIdx], valueType);
      tierIdx++;
    }
    out[position - 1] = current;
  }
  return out;
}

/**
 * Descuento en centavos que le corresponde a UNA unidad, o 0 si no descuenta.
 *
 * 🔴 La regla del monto que se pasa de precio: si el descuento en dinero deja el
 * precio en cero o en negativo, esa unidad NO descuenta — nada, sin descuento
 * parcial ni recorte al mínimo. Es el mismo criterio que Rango de precio, que
 * ante un precio fijo mayor o igual al original se salta la variante entera
 * (`campaign-ops.ts` → `priceFor`, rama `fixedPrice`).
 *
 * En UNIFORM todas las unidades de una línea comparten precio y valor, así que
 * esto se reduce exactamente a "ese producto no descuenta". En INCREMENTAL cada
 * unidad tiene su propio valor, y se evalúa unidad a unidad: un nivel alto no
 * puede tumbar el descuento legítimo de las unidades anteriores.
 */
function unitDiscountCents(
  unitCents: number,
  value: number,
  valueType: TierValueType
): number {
  if (value <= 0) return 0;

  if (valueType === "PERCENT") {
    const discount = Math.round((unitCents * value) / 100);
    return discount > 0 ? discount : 0;
  }

  const discount = toCents(value);
  if (discount <= 0) return 0;
  // Dejaría el precio en cero o negativo → esta unidad no participa.
  if (unitCents - discount < MIN_RESULTING_CENTS) return 0;
  return discount;
}

// ─── Cálculo ──────────────────────────────────────────────────────────────────

/**
 * Punto de entrada único. Recibe las líneas YA filtradas como aplicables y
 * devuelve qué descuento aplicar a cada una.
 *
 * `valueType` por defecto es PERCENT: así los llamadores antiguos —y el
 * metafield de las campañas ya creadas, que no trae el campo— siguen dando
 * exactamente el mismo resultado que antes de que existieran los montos.
 */
export function computeTiered(
  mode: TierMode,
  tiers: Tier[] | null | undefined,
  lines: ApplicableLine[] | null | undefined,
  valueType: TierValueType = "PERCENT"
): TieredOutcome {
  const sorted = normalizeTiers(tiers, valueType);
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
    ? computeUniform(sorted, valid, totalQuantity, valueType)
    : computeIncremental(sorted, valid, totalQuantity, valueType);
}

/** MODO A — al alcanzar el tier, TODAS las unidades aplicables reciben ese valor. */
function computeUniform(
  sorted: Tier[],
  lines: ApplicableLine[],
  totalQuantity: number,
  valueType: TierValueType
): TieredOutcome {
  const tier = resolveTierSorted(sorted, totalQuantity);
  if (!tier) return { applies: false, reason: "below-first-tier" };

  const value = tierValue(tier, valueType);

  // Un nivel al 0 significa "sin descuento", así que no hay nada que emitir.
  // Sin este corte se generaría un descuento de valor 0 y el comprador vería
  // una línea de "-$0.00" en su carrito.
  if (value <= 0) return { applies: false, reason: "zero-discount" };

  // ── Porcentaje: se emite el % tal cual, como siempre ──────────────────────
  if (valueType === "PERCENT") {
    return {
      applies: true,
      emit: "PERCENTAGE",
      mode: "UNIFORM",
      valueType: "PERCENT",
      totalQuantity,
      tier,
      lines: lines.map((l) => ({ lineId: l.lineId, percent: value })),
    };
  }

  // ── Monto: el valor es POR UNIDAD, así que la línea recibe valor × unidades ──
  // Las líneas cuyo precio unitario no aguanta el descuento quedan fuera
  // enteras: es el "ese producto no descuenta" de la regla de producto.
  const result: IncrementalLineResult[] = [];
  let totalCents = 0;
  for (const line of lines) {
    const perUnit = unitDiscountCents(toCents(line.unitPrice), value, "AMOUNT");
    if (perUnit <= 0) continue;
    const lineCents = perUnit * Math.floor(line.quantity);
    totalCents += lineCents;
    result.push({ lineId: line.lineId, discountAmount: fromCents(lineCents) });
  }

  if (totalCents === 0) return { applies: false, reason: "zero-discount" };

  return {
    applies: true,
    emit: "FIXED_AMOUNT",
    mode: "UNIFORM",
    valueType: "AMOUNT",
    totalQuantity,
    totalDiscount: fromCents(totalCents),
    lines: result,
  };
}

/**
 * MODO B — cada unidad individual tiene su propio valor, según su posición.
 *
 * REGLA DE PRODUCTO (decidida 2026-07-24): el descuento más alto va a la unidad
 * MÁS BARATA. Como los tiers crecen con la cantidad, basta con ordenar las
 * unidades de más cara a más barata: la que queda al final de la fila —la más
 * barata— recibe el valor más alto.
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
  totalQuantity: number,
  valueType: TierValueType
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

  const values = valuesByUnitIndex(sorted, units.length, valueType);

  const discountByLine = new Map<string, number>();
  let totalCents = 0;
  for (let i = 0; i < units.length; i++) {
    const discount = unitDiscountCents(units[i].cents, values[i], valueType);
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
    emit: "FIXED_AMOUNT",
    mode: "INCREMENTAL",
    valueType,
    totalQuantity,
    totalDiscount: fromCents(totalCents),
    lines: result,
  };
}

// ─── Validación (para el formulario del admin) ────────────────────────────────

export type TierValidation = { errors: string[]; warnings: string[] };

/**
 * Contexto opcional del formulario.
 *
 * `unitPrice` permite avisar de los montos que se pasan del precio, que es el
 * único momento en que ese fallo se puede detectar ANTES de que un comprador se
 * encuentre con un producto que no descuenta. Sin precio no se puede saber, y
 * entonces simplemente no se avisa: es mejor no decir nada que inventar.
 */
export type TierValidationContext = {
  valueType?: TierValueType;
  unitPrice?: number;
};

export function validateTiers(
  tiers: Tier[] | null | undefined,
  ctx: TierValidationContext = {}
): TierValidation {
  const valueType = ctx.valueType ?? "PERCENT";
  const esMonto = valueType === "AMOUNT";
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

    const value = tierValue(t, valueType);
    if (esMonto) {
      if (!Number.isFinite(value) || value < MIN_TIER_AMOUNT) {
        errors.push("El monto de cada nivel debe ser 0 o mayor.");
      }
    } else if (
      !Number.isFinite(value) ||
      value < MIN_TIER_PERCENT ||
      value > MAX_TIER_PERCENT
    ) {
      errors.push(
        `El descuento de cada nivel debe estar entre ${MIN_TIER_PERCENT}% y ${MAX_TIER_PERCENT}%.`
      );
    }
  }

  const sorted = normalizeTiers(list, valueType);

  // Todos los niveles a 0 = una campaña que no descuenta nada. Se bloquea aquí
  // porque es una línea y evita una campaña activa y muda; un 0 suelto entre
  // niveles con descuento es legítimo y no se toca.
  if (sorted.length > 0 && sorted.every((t) => tierValue(t, valueType) === 0)) {
    errors.push(
      esMonto
        ? "Al menos un nivel debe tener un monto mayor que 0."
        : "Al menos un nivel debe tener un descuento mayor que 0%."
    );
  }

  // Montos que se pasan del precio: esas unidades no descontarían nada. Solo se
  // puede comprobar si el formulario nos dio un precio de referencia.
  if (esMonto && Number.isFinite(ctx.unitPrice ?? NaN)) {
    const unitCents = toCents(ctx.unitPrice as number);
    const excedidos = sorted.filter(
      (t) =>
        tierValue(t, valueType) > 0 &&
        unitDiscountCents(unitCents, tierValue(t, valueType), "AMOUNT") === 0
    );
    if (excedidos.length === sorted.filter((t) => tierValue(t, valueType) > 0).length) {
      errors.push(
        "Ningún nivel puede aplicarse: todos los montos igualan o superan el precio del producto de referencia."
      );
    } else if (excedidos.length > 0) {
      warnings.push(
        `Los niveles de ${excedidos
          .map((t) => t.minQty)
          .join(", ")} unidades no se aplicarán a productos de este precio: el monto iguala o supera el precio.`
      );
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = tierValue(sorted[i - 1], valueType);
    const curr = tierValue(sorted[i], valueType);
    if (curr < prev) {
      warnings.push(
        curr === 0
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
  /** Valor del nivel vigente a esa cantidad (% o monto, según la campaña). */
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
 * mentir — incluido el caso del monto que se pasa del precio, que aquí aparece
 * como un ahorro de 0 igual que le pasaría al comprador.
 */
export function buildPreviewRows(
  mode: TierMode,
  tiers: Tier[] | null | undefined,
  unitPrice: number,
  valueType: TierValueType = "PERCENT"
): PreviewRow[] {
  const sorted = normalizeTiers(tiers, valueType);
  if (sorted.length === 0) return [];

  const quantities = sorted.map((t) => t.minQty);
  const lastQty = quantities[quantities.length - 1];
  quantities.push(lastQty + 1); // fila "N+1" → el tope se mantiene

  return quantities.map((quantity, idx) => {
    const outcome = computeTiered(
      mode,
      sorted,
      [{ lineId: "preview", unitPrice, quantity }],
      valueType
    );

    const subtotalCents = toCents(unitPrice) * quantity;
    let savedCents = 0;
    if (outcome.applies) {
      savedCents =
        outcome.emit === "PERCENTAGE"
          ? Math.round((subtotalCents * outcome.tier.percent!) / 100)
          : toCents(outcome.totalDiscount);
    }

    return {
      quantity,
      percent: tierValue(resolveTierSorted(sorted, quantity) ?? { minQty: 0 }, valueType),
      subtotal: fromCents(subtotalCents),
      saved: fromCents(savedCents),
      total: fromCents(subtotalCents - savedCents),
      isBeyondLastTier: idx === quantities.length - 1,
    };
  });
}
