// Function de descuentos por VALOR DE CARRITO (campañas CART_VALUE).
//
// La lógica de cálculo NO vive aquí: vive en app/lib/discounts/cart-value-calc.ts,
// que es el mismo módulo que usa el preview del admin. Este archivo lee la
// configuración del metafield, decide el subtotal contra el que se mide, y
// traduce el resultado al formato de la Discount Function API.
//
// Regla de oro (heredada de las otras dos Functions): NUNCA lanzar. Una Function
// que revienta puede romper el checkout del merchant. Ante cualquier duda se
// devuelve `{operations: []}`.

import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  OrderDiscountCandidate,
} from '../generated/api';

import {
  computeCartValue,
  type CartValueType,
  type CartValueTier,
} from '../../../app/lib/discounts/cart-value-calc';

/** Config que la app escribe en el metafield del descuento al activar la campaña. */
type CartValueFunctionConfig = {
  /** En qué se mide el descuento: porcentaje del carrito o dinero. */
  valueType?: CartValueType;
  /** Niveles por monto de carrito. */
  tiers?: CartValueTier[];
  /** Texto que ve el comprador en el carrito. */
  message?: string;
  /**
   * Campanas de PACK cuya presencia en el carrito anula este descuento.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * 🔴 POR QUE EXISTE, Y POR QUE NO ALCANZABA CON `combinesWith`
   *
   * `combinesWith` solo ofrece dos comportamientos: los dos descuentos se
   * suman, o NO se suman y Shopify elige uno con su propio criterio, sin
   * decirselo a nadie. Eso segundo es lo que paso el 2026-09-05 en dev: un
   * pack de $278 aplico su 30% y el descuento por monto de compra, que a
   * $194,60 tenia que dar $25, desaparecio sin dejar rastro.
   *
   * Decision de producto: el merchant decide quien gana, no Shopify. Asi que
   * los dos descuentos se declaran combinables —para que Shopify no descarte
   * nada por su cuenta— y la exclusion se evalua ACA, donde se puede registrar
   * el motivo.
   *
   * ⚠️ Solo funciona contra PACKS, y es una limitacion real: una linea del
   * carrito solo lleva marca de campana si la puso el widget de packs
   * (`_df_pack`). Una campana escalonada o de porcentaje no marca nada, asi que
   * desde aca no hay forma de saber si esta aplicando.
   * ═════════════════════════════════════════════════════════════════════════
   */
  excludeIfPackIds?: string[];
};

const NO_DISCOUNT: CartLinesDiscountsGenerateRunResult = {operations: []};

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  // ⚠️ Esta Function emite descuentos de ORDEN, no de producto. Las otras dos
  // de la app comprueban `DiscountClass.Product`; ésta comprueba Order. Si el
  // descuento se creara con la clase equivocada, no aplicaría nada — en
  // silencio, que es justo lo que este guard convierte en un log.
  if (!input.discount.discountClasses.includes(DiscountClass.Order)) {
    console.log(
      `[cart-value] sin-descuento motivo=clase-incorrecta clases=${input.discount.discountClasses.join(',')}`,
    );
    return NO_DISCOUNT;
  }

  const config = readConfig(input);
  if (!config) {
    console.log('[cart-value] sin-descuento motivo=config-ilegible');
    return NO_DISCOUNT;
  }

  const valueType: CartValueType = config.valueType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';

  // ── Exclusion entre campanas ─────────────────────────────────────────────
  //
  // Antes de calcular nada: si el comprador tiene en el carrito un pack que el
  // merchant marco como excluyente, este descuento no aplica. Y se dice por que,
  // que es la mitad del punto: el fallo anterior era MUDO.
  const excluidos = Array.isArray(config.excludeIfPackIds) ? config.excludeIfPackIds : [];
  if (excluidos.length > 0) {
    for (const line of input.cart.lines) {
      const packId = line.packId?.value;
      if (packId && excluidos.indexOf(packId) !== -1) {
        console.log(
          `[cart-value] sin-descuento motivo=excluido-por-campana pack=${packId}`,
        );
        return NO_DISCOUNT;
      }
    }
  }

  // ── El subtotal contra el que se mide el umbral ──────────────────────────
  //
  // Decisión de producto del 2026-09-05, opción B: el subtotal YA REBAJADO.
  // `cart.cost.subtotalAmount` es "before taxes and cart-level discounts", o sea
  // con los descuentos de producto ya dentro.
  const subtotal = Number(input.cart.cost.subtotalAmount.amount);
  if (!Number.isFinite(subtotal)) {
    console.log('[cart-value] sin-descuento motivo=subtotal-ilegible');
    return NO_DISCOUNT;
  }

  const outcome = computeCartValue(valueType, config.tiers ?? [], subtotal);

  // ── 🔴 EL DIAGNÓSTICO QUE RESPONDE LA PREGUNTA DEL UMBRAL ────────────────
  //
  // La documentación del schema se contradice sobre si el subtotal incluye o no
  // los descuentos de producto. En vez de elegir una lectura y esperar, se
  // registran los TRES números en cada ejecución. La primera prueba con un
  // carrito mixto —un pack o un escalonado encima— los muestra distintos y
  // zanja la cuestión con datos.
  //
  // Quitar este log solo cuando esa pregunta esté cerrada.
  let sumaPorUnidad = 0;
  let sumaTotales = 0;
  for (const line of input.cart.lines) {
    const unidad = Number(line.cost.amountPerQuantity.amount);
    if (Number.isFinite(unidad)) sumaPorUnidad += unidad * line.quantity;
    const total = Number(line.cost.totalAmount.amount);
    if (Number.isFinite(total)) sumaTotales += total;
  }
  console.log(
    `[cart-value] subtotalDeShopify=${subtotal} sumaPorUnidad=${sumaPorUnidad.toFixed(2)} ` +
      `sumaTotalesDeLinea=${sumaTotales.toFixed(2)} resultado=${
        outcome.applies ? outcome.emit : 'SIN-DESCUENTO:' + outcome.reason
      }`,
  );

  if (!outcome.applies) return NO_DISCOUNT;

  const message = config.message || 'Descuento por monto de compra';

  // ⚠️ El valor se emite como NÚMERO y el tipo generado lo declara `string` (el
  // escalar Decimal). Produce un error de typecheck — el MISMO, exacto, que ya
  // arrastran `tiered-discount` y `pack-discount` — y NO se enmascara con
  // `as`, porque este repo no lo hace en ningún sitio. Se deja como número a
  // propósito: es lo que las 12 fixtures verifican contra el Wasm REAL.
  const candidate: OrderDiscountCandidate = {
    message,
    targets: [{orderSubtotal: {excludedCartLineIds: []}}],
    value:
      outcome.emit === 'PERCENTAGE'
        ? {percentage: {value: outcome.percent ?? 0}}
        : {fixedAmount: {amount: outcome.amount ?? 0}},
  };

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [candidate],
          // 🔴 UN SOLO candidate y `First`, NO varios con `Maximum`.
          //
          // El nivel lo resolvemos nosotros en `computeCartValue`. La alternativa
          // era emitir un candidate por nivel con su `condition` y dejar que
          // Shopify eligiera con `Maximum`, pero el schema documenta `First`
          // como "el primero CUYAS CONDICIONES SE CUMPLEN" y `Maximum` solo como
          // "el que ofrece la mayor reducción", sin mencionar las condiciones.
          // Si `Maximum` las ignorase, aplicaría el nivel de $70 a un carrito de
          // $50. No se apuesta a una semántica ambigua cuando la alternativa es
          // determinista y está cubierta por fixtures.
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}

/** Lee y valida mínimamente el metafield. Devuelve null si no es usable. */
function readConfig(input: CartInput): CartValueFunctionConfig | null {
  const raw = (input.discount.config?.jsonValue ??
    input.discount.configFallback?.jsonValue) as
    | CartValueFunctionConfig
    | undefined;

  if (!raw) return null;
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) return null;

  return raw;
}
