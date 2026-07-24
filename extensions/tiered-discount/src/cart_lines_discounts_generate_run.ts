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
  /** Productos a los que aplica. Lista VACÍA = toda la tienda. */
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

  const applicable: ApplicableLine[] = [];
  for (const line of input.cart.lines) {
    // Las líneas que no son variantes de producto (ej. tarjetas de regalo
    // personalizadas) no participan.
    if (!('product' in line.merchandise)) continue;

    const productId = line.merchandise.product.id;
    if (excludeIds.has(productId)) continue;
    // includeIds vacío = campaña de toda la tienda.
    if (includeIds.size > 0 && !includeIds.has(productId)) continue;

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
