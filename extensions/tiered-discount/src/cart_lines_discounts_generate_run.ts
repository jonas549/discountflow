// Function de descuentos escalonados (campañas TIERED de DiscountFlow).
//
// La lógica de cálculo NO vive aquí: vive en app/lib/discounts/tiered-calc.ts,
// que es el mismo módulo que usa el preview del admin. Este archivo solo hace
// tres cosas: leer la configuración del metafield, filtrar las líneas
// aplicables y traducir el resultado al formato de la Discount Function API.
//
// Regla de oro: NUNCA lanzar. Una Function que revienta puede romper el
// checkout del merchant. Ante cualquier duda se devuelve `{operations: []}`,
// que simplemente significa "no hay descuento".

import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountCandidate,
} from '../generated/api';

import {
  computeTiered,
  type TierMode,
  type Tier,
  type ApplicableLine,
} from '../../../app/lib/discounts/tiered-calc';

/** Config que la app escribe en el metafield del descuento al activar la campaña. */
type TieredFunctionConfig = {
  mode: TierMode;
  tiers: Tier[];
  /**
   * Alcance EXPLÍCITO de la campaña. Es el único campo que autoriza descontar
   * todo el catálogo.
   *
   *   "all"      → toda la tienda; `productIds` se ignora.
   *   "selected" → solo los `productIds` listados.
   *
   * Antes no existía y "toda la tienda" se INFERÍA de que `productIds` viniera
   * vacío. Esa inferencia es peligrosa porque una lista vacía tiene dos
   * orígenes indistinguibles: el merchant eligió "toda la tienda", o la
   * resolución de su colección/tag falló y devolvió cero. El segundo caso
   * convertía un fallo silencioso en un descuento a TODO el catálogo.
   */
  scope?: 'all' | 'selected';
  /** Productos a los que aplica cuando `scope` es "selected". */
  productIds?: string[];
  excludeProductIds?: string[];
  /** Texto que ve el cliente en el carrito. */
  message?: string;
};

const NO_DISCOUNT: CartLinesDiscountsGenerateRunResult = {operations: []};

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.lines.length) return NO_DISCOUNT;

  // Esta Function solo emite descuentos de producto.
  if (!input.discount.discountClasses.includes(DiscountClass.Product))
    return NO_DISCOUNT;

  const config = readConfig(input);
  if (!config) {
    // TEMPORAL [tiered-debug] — el caso "no hay config" es el que explica que
    // el descuento no se aplique a NADA (config vacía aplicaría a TODO).
    console.log(
      '[tiered-debug] fn SIN-CONFIG',
      JSON.stringify({
        lineasCarrito: input.cart.lines.length,
        discountClasses: input.discount.discountClasses,
        metafieldAppNamespace: !!input.discount.config,
        metafieldNamespacePlano: !!input.discount.configFallback,
      })
    );
    return NO_DISCOUNT;
  }

  const includeIds = new Set(config.productIds ?? []);
  const excludeIds = new Set(config.excludeProductIds ?? []);

  // ── Puerta de seguridad: descontar TODO el catálogo exige permiso explícito ──
  //
  // Solo `scope: "all"` autoriza aplicar a toda la tienda. Cualquier otro caso
  // con la lista de inclusión vacía se trata como "no hay nada que descontar",
  // NO como "descuéntalo todo".
  //
  // Esto cubre las tres formas de llegar aquí con la lista vacía:
  //   1. La colección del merchant está vacía o se quedó sin productos.
  //   2. La resolución contra la Admin API falló y devolvió cero productos.
  //   3. Un metafield antiguo, escrito antes de que existiera `scope`.
  //
  // El caso (3) merece una nota: una campaña de "toda la tienda" creada con el
  // formato viejo deja de aplicar hasta que la app reescriba su metafield (lo
  // hace al guardar la campaña). Es deliberado. Dejar de descontar es un fallo
  // que el merchant ve y reporta; descontar el catálogo entero por error le
  // cuesta dinero en silencio. Ante la duda, se elige el fallo visible.
  const aplicaATodaLaTienda = config.scope === 'all';
  if (!aplicaATodaLaTienda && includeIds.size === 0) {
    console.log(
      '[tiered-debug] fn SIN-PRODUCTOS-ELEGIBLES',
      JSON.stringify({
        motivo:
          'lista de inclusion vacia sin scope "all" — no se descuenta nada (proteccion)',
        scope: config.scope ?? null,
        lineasCarrito: input.cart.lines.length,
      })
    );
    return NO_DISCOUNT;
  }

  const applicable: ApplicableLine[] = [];
  for (const line of input.cart.lines) {
    // Las líneas que no son variantes de producto (ej. tarjetas de regalo
    // personalizadas) no participan.
    if (!('product' in line.merchandise)) continue;

    const productId = line.merchandise.product.id;
    if (excludeIds.has(productId)) continue;
    // Con scope "all" no hay lista que consultar: participan todas las líneas.
    if (!aplicaATodaLaTienda && !includeIds.has(productId)) continue;

    const unitPrice = Number(line.cost.amountPerQuantity.amount);
    if (!Number.isFinite(unitPrice)) continue;

    applicable.push({lineId: line.id, unitPrice, quantity: line.quantity});
  }

  const outcome = computeTiered(config.mode, config.tiers, applicable);

  // TEMPORAL [tiered-debug] — estos logs NO llegan a Vercel: la Function corre
  // en Shopify. Se leen con `shopify app logs` o en el Partner Dashboard.
  console.log(
    '[tiered-debug] fn',
    JSON.stringify({
      lineasCarrito: input.cart.lines.length,
      discountClasses: input.discount.discountClasses,
      configLeida: true,
      modo: config.mode,
      tiers: config.tiers?.length ?? 0,
      scope: config.scope ?? null,
      aplicaATodaLaTienda,
      includeIds: includeIds.size,
      excludeIds: excludeIds.size,
      lineasAplicables: applicable.length,
      productIdsDelCarrito: input.cart.lines
        .map((l) => ('product' in l.merchandise ? l.merchandise.product.id : null))
        .filter(Boolean),
      resultado: outcome.applies ? outcome.mode : `SIN-DESCUENTO:${outcome.reason}`,
    })
  );

  if (!outcome.applies) return NO_DISCOUNT;

  const message = config.message || 'Descuento por cantidad';

  const candidates: ProductDiscountCandidate[] =
    outcome.mode === 'UNIFORM'
      ? outcome.lines.map((l) => ({
          message,
          targets: [{cartLine: {id: l.lineId}}],
          value: {percentage: {value: l.percent}},
        }))
      : outcome.lines.map((l) => ({
          message,
          targets: [{cartLine: {id: l.lineId}}],
          // El importe ya viene calculado para la línea completa, por eso
          // appliesToEachItem se queda en false (el valor por defecto).
          value: {fixedAmount: {amount: l.discountAmount}},
        }));

  if (!candidates.length) return NO_DISCOUNT;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // ALL, no First: cada candidate apunta a UNA línea distinta y todas
          // deben recibir su descuento. `First` aplica un solo candidate y
          // descarta el resto — con un carrito de 3 líneas elegibles solo se
          // descontaba una. No cambiar sin releer esto.
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

/** Lee y valida mínimamente el metafield. Devuelve null si no es usable. */
function readConfig(input: CartInput): TieredFunctionConfig | null {
  // Se acepta el namespace reservado de la app o el plano, el que exista.
  const raw = (input.discount.config?.jsonValue ??
    input.discount.configFallback?.jsonValue) as
    | TieredFunctionConfig
    | undefined;

  if (!raw) return null;
  if (raw.mode !== 'UNIFORM' && raw.mode !== 'INCREMENTAL') return null;
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) return null;

  return raw;
}
