// Calculadora pura de packs armables (campañas PACK).
//
// SIN dependencias, a propósito: este módulo corre en TRES entornos distintos
//   1. el servidor / navegador del admin        → preview de la campaña
//   2. dentro de la Shopify Function (JS → Wasm) → cálculo real del checkout
//   3. el widget del bloque de tema (storefront) → el número que ve el comprador
// Por eso no puede importar nada de Node, Prisma, React ni Shopify.
//
// Es la ÚNICA fuente de verdad del cálculo. El widget NO lleva su propia copia
// escrita a mano: `scripts/build-pack-widget.mjs` compila este mismo archivo a
// `extensions/pack-widget/assets/pack-calc.js`. Si algún día el widget, el
// preview y el checkout muestran números distintos, es porque alguien rompió esa
// cadena.
//
// 🔴 AUNQUE VIVA EN app/, ESTE ARCHIVO SE COMPILA DENTRO DEL WASM.
//    La Function lo importa (`extensions/pack-discount/src/...run.ts`), así que
//    cualquier cambio aquí EXIGE desplegar la Function. Es la misma trampa que
//    tiene `tiered-calc.ts` y que ya mordió una vez en julio de 2026 con los
//    niveles al 0%. Antes de decir "esto no toca la Function", mirá si roza
//    este archivo.
//
// Dinero: el cálculo del ahorro se hace en CENTAVOS enteros para que no haya
// deriva de coma flotante (45,50 × 15% da 38,674999… en float64). Se vuelve a
// decimal solo al devolver.

// ─── Tipos ────────────────────────────────────────────────────────────────────

/**
 * Cómo se decide el descuento del pack.
 *
 *   PER_PRODUCT → cada producto curado trae su propio %. El pack es la excusa
 *                 para comprar varios; el descuento no depende del tamaño.
 *   PACK_SIZE   → el % lo decide CUÁNTOS PRODUCTOS DISTINTOS armó el comprador.
 *
 * Una campaña es entera de un modo. No se mezclan.
 */
export type PackMode = "PER_PRODUCT" | "PACK_SIZE";

/** Un producto del catálogo que curó el merchant. */
export type PackProduct = {
  productId: string;
  /**
   * Descuento de ESE producto, en %. Solo significativo en modo PER_PRODUCT.
   * En PACK_SIZE se ignora (el % sale del nivel alcanzado).
   */
  percent?: number;
};

/**
 * Un nivel del modo PACK_SIZE: "desde `minProducts` productos distintos, este %".
 *
 * ⚠️ `minProducts` cuenta PRODUCTOS DISTINTOS, no unidades. Es una decisión de
 * producto tomada el 2026-09-05: si contara unidades, este modo sería un
 * escalonado, y ese tipo de campaña ya existe. Dos unidades del mismo producto
 * NO alcanzan el nivel de 2 productos.
 */
export type PackTier = { minProducts: number; percent: number };

/** Línea del carrito YA identificada como parte del pack y presente en el catálogo. */
export type PackApplicableLine = {
  lineId: string;
  productId: string;
  /** Precio unitario en la moneda de presentación. Solo se usa para el preview. */
  unitPrice: number;
  quantity: number;
};

/** Descuento resuelto para una línea. */
export type PackLineResult = { lineId: string; percent: number };

/** Qué falta para llegar al siguiente nivel (modo PACK_SIZE). */
export type PackNextTier = {
  /** Cuántos productos distintos más hacen falta. Siempre >= 1. */
  productsNeeded: number;
  /** El % que se desbloquea al llegar. */
  percent: number;
};

export type PackNoDiscountReason =
  /** Config ilegible o incompleta. */
  | "NO_CONFIG"
  /** El comprador no llegó al mínimo de productos distintos. */
  | "BELOW_MINIMUM"
  /** Llegó al mínimo pero ningún producto tiene descuento > 0. */
  | "NOTHING_TO_DISCOUNT";

export type PackOutcome =
  | {
      applies: false;
      reason: PackNoDiscountReason;
      /** Productos distintos que el comprador tiene ahora mismo. */
      distinctProducts: number;
      /** Solo en PACK_SIZE y cuando la razón es BELOW_MINIMUM. */
      nextTier: PackNextTier | null;
    }
  | {
      applies: true;
      mode: PackMode;
      lines: PackLineResult[];
      distinctProducts: number;
      /** El % vigente. Solo en PACK_SIZE (en PER_PRODUCT cada línea tiene el suyo). */
      appliedPercent: number | null;
      /** Qué se desbloquea sumando productos. `null` si ya está en el tope. */
      nextTier: PackNextTier | null;
    };

// ─── Constantes ───────────────────────────────────────────────────────────────

/**
 * Mínimo duro del tipo de campaña: un "pack" de un solo producto no es un pack.
 *
 * En modo PER_PRODUCT es el mínimo efectivo (decisión de producto del
 * 2026-09-05). En modo PACK_SIZE el mínimo real lo fija el primer nivel, que
 * nunca puede estar por debajo de esto.
 */
export const MIN_PACK_PRODUCTS = 2;

export const MIN_PACK_PERCENT = 0;
export const MAX_PACK_PERCENT = 99;

/* El tope de productos del catálogo (`MAX_PACK_CATALOG`) NO vive acá a
 * propósito: está en `pack-validate.ts`. Este archivo se compila DENTRO del
 * Wasm de la Function, así que tocarlo obliga a desplegar la Function; y ese
 * tope es del widget y del formulario, no del descuento. Ver el comentario de
 * `pack-validate.ts`. */

/** Máximo de niveles en modo PACK_SIZE. Más de esto nadie lo entiende. */
export const MAX_PACK_TIERS = 5;

// ─── Normalización ────────────────────────────────────────────────────────────

/**
 * Deja el catálogo en un estado usable y determinista.
 *
 * Descarta entradas sin `productId` y deduplica por producto (la primera gana).
 * NO descarta los que tienen 0%: un 0% es un interruptor con significado —
 * "este producto entra al pack pero no rebaja" — y en modo PACK_SIZE el campo
 * ni siquiera se mira.
 */
export function normalizePackCatalog(raw: unknown): PackProduct[] {
  if (!Array.isArray(raw)) return [];
  const vistos = new Set<string>();
  const out: PackProduct[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const productId = (item as PackProduct).productId;
    if (typeof productId !== "string" || !productId) continue;
    if (vistos.has(productId)) continue;
    vistos.add(productId);

    const percentRaw = (item as PackProduct).percent;
    const percent =
      typeof percentRaw === "number" && Number.isFinite(percentRaw) && percentRaw >= 0
        ? Math.min(percentRaw, MAX_PACK_PERCENT)
        : undefined;

    out.push(percent === undefined ? { productId } : { productId, percent });
  }

  return out;
}

/**
 * Ordena y sanea los niveles del modo PACK_SIZE.
 *
 * Descarta los no finitos, los negativos y los que piden menos productos que el
 * mínimo duro. Deduplica por `minProducts` quedándose con el ÚLTIMO (el que
 * escribió el merchant más abajo en el formulario, que es el que ve como
 * definitivo). Conserva los 0%.
 */
export function normalizePackTiers(raw: unknown): PackTier[] {
  if (!Array.isArray(raw)) return [];

  const porMin = new Map<number, number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { minProducts, percent } = item as PackTier;
    if (typeof minProducts !== "number" || !Number.isFinite(minProducts)) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    if (minProducts < MIN_PACK_PRODUCTS) continue;
    if (percent < MIN_PACK_PERCENT) continue;
    porMin.set(Math.floor(minProducts), Math.min(percent, MAX_PACK_PERCENT));
  }

  return [...porMin.entries()]
    .map(([minProducts, percent]) => ({ minProducts, percent }))
    .sort((a, b) => a.minProducts - b.minProducts);
}

/**
 * El nivel vigente para una cantidad de productos distintos, o `null` si todavía
 * no llegó al primero. Asume niveles ya normalizados (ordenados ascendente).
 */
export function resolvePackTier(
  tiers: PackTier[],
  distinctProducts: number
): PackTier | null {
  let vigente: PackTier | null = null;
  for (const t of tiers) {
    if (distinctProducts >= t.minProducts) vigente = t;
    else break;
  }
  return vigente;
}

/**
 * El siguiente nivel por encima del vigente, expresado como "te faltan N".
 * `null` si ya está en el tope.
 */
export function resolveNextPackTier(
  tiers: PackTier[],
  distinctProducts: number
): PackNextTier | null {
  for (const t of tiers) {
    if (t.minProducts > distinctProducts) {
      return {
        productsNeeded: t.minProducts - distinctProducts,
        percent: t.percent,
      };
    }
  }
  return null;
}

/** El mínimo real de productos para que la campaña aplique. */
export function packMinimumProducts(mode: PackMode, tiers: PackTier[]): number {
  if (mode === "PER_PRODUCT") return MIN_PACK_PRODUCTS;
  return tiers.length ? tiers[0].minProducts : MIN_PACK_PRODUCTS;
}

// ─── El cálculo ───────────────────────────────────────────────────────────────

/**
 * Resuelve el descuento del pack.
 *
 * `lines` ya viene filtrada por el llamador: son las líneas que declaran
 * pertenecer al pack Y cuyo producto está en el catálogo curado. Ese filtro es
 * la frontera de seguridad y vive fuera de acá a propósito — esta función no
 * sabe de carritos ni de atributos, solo de números.
 *
 * 🔴 El porcentaje SIEMPRE sale de la configuración del merchant, nunca de la
 *    línea del carrito. Si algún día alguien le pasa un % que viene del
 *    navegador, el comprador se fija su propio descuento.
 */
export function computePack(
  mode: PackMode,
  catalog: PackProduct[],
  tiers: PackTier[],
  lines: PackApplicableLine[]
): PackOutcome {
  const distinctProducts = new Set(lines.map((l) => l.productId)).size;
  const minimo = packMinimumProducts(mode, tiers);

  if (mode === "PACK_SIZE" && tiers.length === 0)
    return { applies: false, reason: "NO_CONFIG", distinctProducts, nextTier: null };

  if (distinctProducts < minimo) {
    return {
      applies: false,
      reason: "BELOW_MINIMUM",
      distinctProducts,
      // En PER_PRODUCT no hay niveles, pero sí hay un "te falta 1 para que
      // arranque": se expresa con el mismo tipo para que el widget y el aviso
      // del carrito no necesiten dos caminos.
      nextTier:
        mode === "PACK_SIZE"
          ? resolveNextPackTier(tiers, distinctProducts)
          : { productsNeeded: minimo - distinctProducts, percent: 0 },
    };
  }

  const percentPorProducto = new Map<string, number>();
  for (const p of catalog) percentPorProducto.set(p.productId, p.percent ?? 0);

  let resultado: PackLineResult[];
  let appliedPercent: number | null = null;

  if (mode === "PER_PRODUCT") {
    resultado = [];
    for (const line of lines) {
      const percent = percentPorProducto.get(line.productId) ?? 0;
      // Un 0% no se emite: Shopify pintaría "-$0.00" en el carrito, que el
      // comprador lee como un error. Es la misma decisión que ya se tomó en
      // `computeUniform` de los escalonados el 2026-07-28.
      if (percent <= 0) continue;
      resultado.push({ lineId: line.lineId, percent });
    }
  } else {
    const tier = resolvePackTier(tiers, distinctProducts);
    const percent = tier?.percent ?? 0;
    appliedPercent = percent;
    resultado =
      percent > 0 ? lines.map((l) => ({ lineId: l.lineId, percent })) : [];
  }

  if (resultado.length === 0)
    return {
      applies: false,
      reason: "NOTHING_TO_DISCOUNT",
      distinctProducts,
      nextTier: null,
    };

  return {
    applies: true,
    mode,
    lines: resultado,
    distinctProducts,
    appliedPercent,
    nextTier:
      mode === "PACK_SIZE" ? resolveNextPackTier(tiers, distinctProducts) : null,
  };
}

// ─── Dinero (preview y widget) ────────────────────────────────────────────────

/**
 * Ahorro de una línea, en centavos enteros.
 *
 * ⚠️ `Math.round(x * 100) / 100` NO sirve: hereda el error de origen del float.
 * Hay que pasar a centavos ANTES de multiplicar. Es la lección del medio centavo
 * perdido del 2026-08-08 (45,50 al 15% daba 38,67 en vez de 38,68).
 */
export function savingsCents(
  unitPrice: number,
  quantity: number,
  percent: number
): number {
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 0;
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  const totalCents = Math.round(unitPrice * 100) * Math.floor(quantity);
  return Math.round((totalCents * percent) / 100);
}

export type PackPreviewRow = {
  productId: string;
  lineId: string;
  percent: number;
  /** Ahorro de la línea, en unidades de moneda (no centavos). */
  savings: number;
};

export type PackPreview = {
  applies: boolean;
  reason: PackNoDiscountReason | null;
  distinctProducts: number;
  appliedPercent: number | null;
  nextTier: PackNextTier | null;
  rows: PackPreviewRow[];
  /** Suma de precios sin descuento. */
  subtotal: number;
  /** Suma de los ahorros. */
  savings: number;
  /** `subtotal - savings`. */
  total: number;
};

/**
 * Construye la vista que consumen el preview del admin Y el widget de la tienda.
 *
 * Que sea la misma función es el punto: el número que ve el merchant al crear la
 * campaña y el que ve el comprador en la tienda salen de acá, y el que se cobra
 * sale de `computePack` — que es lo que esta función usa por dentro.
 */
export function buildPackPreview(
  mode: PackMode,
  catalog: PackProduct[],
  tiers: PackTier[],
  lines: PackApplicableLine[]
): PackPreview {
  const outcome = computePack(mode, catalog, tiers, lines);

  let subtotalCents = 0;
  for (const l of lines) {
    subtotalCents += Math.round(l.unitPrice * 100) * Math.floor(l.quantity);
  }

  if (!outcome.applies) {
    return {
      applies: false,
      reason: outcome.reason,
      distinctProducts: outcome.distinctProducts,
      appliedPercent: null,
      nextTier: outcome.nextTier,
      rows: [],
      subtotal: subtotalCents / 100,
      savings: 0,
      total: subtotalCents / 100,
    };
  }

  const porLinea = new Map(lines.map((l) => [l.lineId, l]));
  let savingsTotalCents = 0;
  const rows: PackPreviewRow[] = [];

  for (const r of outcome.lines) {
    const line = porLinea.get(r.lineId);
    if (!line) continue;
    const cents = savingsCents(line.unitPrice, line.quantity, r.percent);
    savingsTotalCents += cents;
    rows.push({
      productId: line.productId,
      lineId: r.lineId,
      percent: r.percent,
      savings: cents / 100,
    });
  }

  return {
    applies: true,
    reason: null,
    distinctProducts: outcome.distinctProducts,
    appliedPercent: outcome.appliedPercent,
    nextTier: outcome.nextTier,
    rows,
    subtotal: subtotalCents / 100,
    savings: savingsTotalCents / 100,
    total: (subtotalCents - savingsTotalCents) / 100,
  };
}

