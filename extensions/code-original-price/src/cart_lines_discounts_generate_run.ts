// Function del cupón que descuenta sobre el PRECIO ORIGINAL.
//
// La lógica de cálculo NO vive aquí: vive en
// app/lib/discounts/original-price-calc.ts, que es el mismo módulo que usa el
// preview del admin. Este archivo lee la configuración del metafield, traduce
// las líneas del carrito y devuelve el resultado en el formato de la Discount
// Function API.
//
// Regla de oro (heredada de las otras tres): NUNCA lanzar. Una Function que
// revienta puede romper el checkout del merchant. Ante cualquier duda se
// devuelve `{operations: []}`.

import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountCandidate,
} from '../generated/api';

import {
  computeOriginalPriceDiscount,
  type OriginalPriceLine,
} from '../../../app/lib/discounts/original-price-calc';

/** Config que la app escribe en el metafield del descuento al activar la campaña. */
type OriginalPriceFunctionConfig = {
  /** El porcentaje del cupón. 10 = 10% sobre el precio original. */
  percent?: number;
  /** Texto que ve el comprador en el carrito. */
  message?: string;
  /**
   * Campanas de PACK cuya presencia en el carrito anula este cupon.
   *
   * Mismo mecanismo y mismo motivo que en `order-discount`: `combinesWith` solo
   * ofrece "se suman" o "no se suman y Shopify elige en silencio", y lo segundo
   * es el fallo que se elimino el 2026-09-05. La decision de quien gana se toma
   * aca, donde se puede registrar el motivo.
   */
  excludeIfPackIds?: string[];
};

const NO_DISCOUNT: CartLinesDiscountsGenerateRunResult = {operations: []};

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  // Clase PRODUCT: el cupón descuenta líneas, no el subtotal del carrito. Si el
  // descuento se creara con la clase equivocada no aplicaría nada, en silencio;
  // este guard lo convierte en un log.
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    console.log(
      `[original-price] sin-descuento motivo=clase-incorrecta clases=${input.discount.discountClasses.join(',')}`,
    );
    return NO_DISCOUNT;
  }

  const config = readConfig(input);
  if (!config) {
    console.log('[original-price] sin-descuento motivo=config-ilegible');
    return NO_DISCOUNT;
  }

  // ── Exclusion entre campanas ─────────────────────────────────────────────
  //
  // Antes de calcular nada. Y se dice POR QUE, que es la mitad del punto: el
  // fallo que motivo este mecanismo era mudo.
  const excluidos = Array.isArray(config.excludeIfPackIds) ? config.excludeIfPackIds : [];
  if (excluidos.length > 0) {
    for (const line of input.cart.lines) {
      const packId = line.packId?.value;
      if (packId && excluidos.indexOf(packId) !== -1) {
        console.log(
          `[original-price] sin-descuento motivo=excluido-por-campana pack=${packId}`,
        );
        return NO_DISCOUNT;
      }
    }
  }

  // ── Traducción de las líneas ─────────────────────────────────────────────
  const lineas: OriginalPriceLine[] = [];
  for (const line of input.cart.lines) {
    const unitPrice = Number(line.cost.amountPerQuantity.amount);
    if (!Number.isFinite(unitPrice)) continue;

    // `compareAtAmountPerQuantity` es nullable en el schema y su ausencia es un
    // estado legítimo, no un error. El cálculo sabe qué hacer con `null`.
    const compareAtRaw = line.cost.compareAtAmountPerQuantity?.amount;
    const compareAt = compareAtRaw == null ? null : Number(compareAtRaw);

    lineas.push({
      lineId: line.id,
      unitPrice,
      compareAtUnitPrice:
        compareAt !== null && Number.isFinite(compareAt) ? compareAt : null,
      quantity: line.quantity,
    });
  }

  const outcome = computeOriginalPriceDiscount(config.percent ?? 0, lineas);

  // ── 🔴 EL DIAGNÓSTICO ────────────────────────────────────────────────────
  //
  // Registra cuántas líneas usaron el precio comparativo y cuántas cayeron al
  // precio actual. Es la única forma de contestar, con una tienda real
  // delante, la pregunta de si el compare-at está donde creemos que está —
  // sin tener que reproducir el carrito.
  let conComparativo = 0;
  let recortadas = 0;
  if (outcome.applies) {
    for (const l of outcome.lines) {
      if (l.usedCompareAt) conComparativo++;
      if (l.clamped) recortadas++;
    }
  }
  console.log(
    `[original-price] lineas=${lineas.length} conComparativo=${conComparativo} ` +
      `recortadas=${recortadas} resultado=${
        outcome.applies
          ? 'ahorro=' + outcome.totalSavings.toFixed(2) + ' extra=' + outcome.extraVsPercent.toFixed(2)
          : 'SIN-DESCUENTO:' + outcome.reason
      }`,
  );

  if (!outcome.applies) return NO_DISCOUNT;

  const message = config.message || 'Descuento sobre el precio original';

  // 🔴 UN CANDIDATO POR LÍNEA, CON MONTO FIJO POR UNIDAD.
  //
  // El monto fijo es TODO el tipo de campaña: si emitiéramos un porcentaje,
  // Shopify lo calcularía sobre el precio ya rebajado y estaríamos donde
  // empezamos. `appliesToEachItem: true` hace que el monto sea POR UNIDAD y no
  // una vez por línea — sin eso, comprar tres unidades descontaría una.
  //
  // ⚠️ El valor va como NÚMERO y el tipo generado lo declara `string` (el
  // escalar Decimal). Produce el MISMO error de typecheck que ya arrastran las
  // otras tres Functions y NO se enmascara con `as`: se deja a propósito, que
  // es lo que las fixtures verifican contra el Wasm real.
  const candidates: ProductDiscountCandidate[] = outcome.lines.map((l) => ({
    message,
    targets: [{cartLine: {id: l.lineId}}],
    value: {fixedAmount: {amount: l.discountPerUnit, appliesToEachItem: true}},
  }));

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // `All`: cada candidato apunta a UNA línea distinta, así que no
          // compiten entre sí — son el mismo cupón repartido. Con `Maximum`
          // Shopify elegiría uno solo y el resto de las líneas se quedaría sin
          // descuento.
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

/** Lee y valida mínimamente el metafield. Devuelve null si no es usable. */
function readConfig(input: CartInput): OriginalPriceFunctionConfig | null {
  const raw = (input.discount.config?.jsonValue ??
    input.discount.configFallback?.jsonValue) as
    | OriginalPriceFunctionConfig
    | undefined;

  if (!raw) return null;
  if (typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) return null;
  if (raw.percent <= 0) return null;

  return raw;
}
