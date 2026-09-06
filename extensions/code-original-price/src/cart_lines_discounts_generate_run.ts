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
  filtrarLineasEnAlcance,
  evaluarExclusionPorMonto,
  type OriginalPriceLine,
  type OriginalPriceScope,
  type ExclusionPorMonto,
  type OriginalPriceModo,
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

  /**
   * A que productos aplica.
   *
   * 🔴 "all" es lo UNICO que autoriza descontar el catalogo entero. Sin el, una
   * lista vacia significa "no descuentes nada" — ver `filtrarLineasEnAlcance`,
   * que es donde vive la regla y donde esta probada.
   */
  scope?: OriginalPriceScope;
  productIds?: string[];

  /**
   * Requisitos minimos de compra.
   *
   * 🔴 NO son nativos en un descuento de app: `minimumRequirement` no existe en
   * `DiscountCodeAppInput` (verificado por introspeccion contra la tienda el
   * 2026-09-06). Shopify acepta el codigo y nos toca a nosotros negarnos.
   */
  minSubtotal?: number | null;
  minQuantity?: number | null;

  /**
   * Campanas de MONTO DE COMPRA cuya aplicacion anula este cupon, con su
   * umbral mas bajo.
   *
   * 🔴 Es la UNICA exclusion entre campanas que hace algo de verdad. Por
   * `combinesWith` —que es bilateral— el cupon no puede convivir con un pack,
   * ni con un escalonado, ni con un BxGy: los tres declaran
   * `productDiscounts: false` y Shopify descarta al cupon antes de que esta
   * Function llegue a opinar. Con el monto de compra si convive (confirmado en
   * un pedido real el 2026-09-06), y ahi el merchant decide.
   */
  excludeIfCartValue?: ExclusionPorMonto[];

  /**
   * Reemplazar la oferta del producto o sumarse a ella.
   *
   * 🔴 Ausente = "SUMA". Es lo que hacian las campanas guardadas antes de que
   * el modo existiera, y cambiarles el dinero en silencio seria inaceptable.
   */
  modo?: OriginalPriceModo;
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

  // ── Exclusion por MONTO DE COMPRA ────────────────────────────────────────
  //
  // Antes de calcular nada, como la de packs, y con su propio motivo en el log.
  const exclusionMonto = evaluarExclusionPorMonto(
    Number(input.cart.cost?.subtotalAmount?.amount),
    config.excludeIfCartValue,
  );
  if (exclusionMonto.excluido) {
    console.log(
      '[original-price] sin-descuento motivo=excluido-por-monto-de-compra ' +
        `campana=${exclusionMonto.campaignId} umbral=${exclusionMonto.minSubtotal} ` +
        `subtotal=${input.cart.cost?.subtotalAmount?.amount ?? 'null'}`,
    );
    return NO_DISCOUNT;
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

    // El producto de la linea. `merchandise` es una union: una linea puede ser
    // una `CustomProduct` sin producto detras, y ahi no hay ID que comparar.
    // Se deja `null` y `filtrarLineasEnAlcance` la manda FUERA del alcance,
    // que es el lado seguro de la duda.
    const merchandise = line.merchandise as
      | {__typename?: string; product?: {id?: string} | null}
      | null
      | undefined;
    const productId = merchandise?.product?.id ?? null;

    lineas.push({
      lineId: line.id,
      unitPrice,
      compareAtUnitPrice:
        compareAt !== null && Number.isFinite(compareAt) ? compareAt : null,
      quantity: line.quantity,
      productId,
    });
  }

  // ── Alcance ───────────────────────────────────────────────────────────────
  //
  // Antes del dinero, y con su propio log: "no aplico porque este producto no
  // esta en la campana" y "no aplico porque no hay precio comparativo" son dos
  // preguntas distintas, y con un solo motivo se busca en el sitio equivocado.
  const {enAlcance, motivo} = filtrarLineasEnAlcance(
    lineas,
    config.scope,
    config.productIds,
  );

  if (motivo === 'scope-vacio-sin-all') {
    console.log(
      '[original-price] sin-descuento motivo=alcance-vacio-sin-all ' +
        'detalle=lista-de-productos-vacia-sin-scope-all-no-se-descuenta-nada-proteccion ' +
        `scope=${config.scope ?? 'null'}`,
    );
    return NO_DISCOUNT;
  }

  if (enAlcance.length === 0) {
    console.log(
      `[original-price] sin-descuento motivo=fuera-de-alcance lineas=${lineas.length} ` +
        `productosDeLaCampana=${(config.productIds ?? []).length}`,
    );
    return NO_DISCOUNT;
  }

  const outcome = computeOriginalPriceDiscount(config.percent ?? 0, enAlcance, {
    modo: config.modo,
    minSubtotal: config.minSubtotal,
    minQuantity: config.minQuantity,
  });

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
    `[original-price] modo=${config.modo ?? 'SUMA(default)'} ` +
      `lineas=${lineas.length} enAlcance=${enAlcance.length} ` +
      `scope=${config.scope ?? 'null'} exclMonto=${(config.excludeIfCartValue ?? []).length} ` +
      `minSubtotal=${config.minSubtotal ?? '-'} ` +
      `minQuantity=${config.minQuantity ?? '-'} conComparativo=${conComparativo} ` +
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
