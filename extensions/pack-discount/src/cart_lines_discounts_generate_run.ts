// Function de packs armables (campañas PACK de DiscountFlow).
//
// La lógica de cálculo NO vive aquí: vive en app/lib/discounts/pack-calc.ts,
// que es el mismo módulo que usan el preview del admin y el widget de la
// tienda. Este archivo hace tres cosas: leer la configuración del metafield,
// decidir QUÉ LÍNEAS pertenecen al pack, y traducir el resultado al formato de
// la Discount Function API.
//
// Regla de oro (heredada de tiered-discount): NUNCA lanzar. Una Function que
// revienta puede romper el checkout del merchant. Ante cualquier duda se
// devuelve `{operations: []}`, que significa "no hay descuento".

import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountCandidate,
} from '../generated/api';

import {
  computePack,
  type PackMode,
  type PackProduct,
  type PackTier,
  type PackApplicableLine,
} from '../../../app/lib/discounts/pack-calc';

/** Config que la app escribe en el metafield del descuento al activar la campaña. */
type PackFunctionConfig = {
  /**
   * 🔴 La IDENTIDAD del pack, y la única defensa contra un carrito hostil.
   *
   * El widget escribe este mismo valor en la propiedad `_df_pack` de cada línea
   * que agrega. La Function solo considera las líneas cuyo `_df_pack` coincide
   * con este campo. Sin `campaignId` no se puede distinguir "el comprador armó
   * ESTE pack" de "alguien escribió cualquier cosa en la propiedad", así que su
   * ausencia es motivo de fail-closed.
   */
  campaignId?: string;
  mode?: PackMode;
  /**
   * El catálogo curado por el merchant, con el % de cada producto en modo
   * PER_PRODUCT. Es la segunda defensa: una línea que declare pertenecer al
   * pack pero cuyo producto no esté acá NO participa.
   */
  products?: PackProduct[];
  /** Niveles por cantidad de productos distintos. Solo en modo PACK_SIZE. */
  tiers?: PackTier[];
  /** Texto que ve el comprador en el carrito. */
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
    console.log('[pack] sin-descuento motivo=config-ilegible');
    return NO_DISCOUNT;
  }

  const catalogo = config.products ?? [];
  const idsDelCatalogo = new Set(catalogo.map((p) => p.productId));

  // ── Qué líneas pertenecen al pack ────────────────────────────────────────
  //
  // Dos condiciones, y las dos son de seguridad:
  //
  //   1. La línea declara `_df_pack` con el id de ESTA campaña. Lo escribe el
  //      widget al agregar al carrito.
  //   2. El producto de la línea está en el catálogo que curó el merchant.
  //
  // La (2) no es redundante: la propiedad de línea la controla el navegador del
  // comprador, así que cualquiera puede ponerle `_df_pack` a un producto que el
  // merchant nunca incluyó. El catálogo del metafield es la lista blanca.
  //
  // 🔴 Lo que NUNCA se lee de la línea es el PORCENTAJE. El descuento sale
  //    siempre de `config`. Si el porcentaje viajara en la propiedad, el
  //    comprador se fijaría su propio descuento editando el carrito.
  const applicable: PackApplicableLine[] = [];
  for (const line of input.cart.lines) {
    if (line.packRef?.value !== config.campaignId) continue;
    if (!('product' in line.merchandise)) continue;

    const productId = line.merchandise.product.id;
    if (!idsDelCatalogo.has(productId)) continue;

    const unitPrice = Number(line.cost.amountPerQuantity.amount);
    if (!Number.isFinite(unitPrice)) continue;

    applicable.push({
      lineId: line.id,
      productId,
      unitPrice,
      quantity: line.quantity,
    });
  }

  if (!applicable.length) return NO_DISCOUNT;

  const outcome = computePack(
    config.mode as PackMode,
    catalogo,
    config.tiers ?? [],
    applicable,
  );

  if (!outcome.applies) {
    // Diagnóstico compacto, a propósito sin volcar el carrito: estos logs no
    // llegan a Vercel (la Function corre en Shopify) y se leen con
    // `shopify app logs`. El caso que de verdad hace falta explicar es por qué
    // un pack que el comprador armó no rebajó nada.
    console.log(
      `[pack] sin-descuento motivo=${outcome.reason} productos=${outcome.distinctProducts}`,
    );
    return NO_DISCOUNT;
  }

  const message = config.message || 'Descuento por pack';

  // Los dos modos emiten PORCENTAJE:
  //   PER_PRODUCT → cada línea con el % de su producto
  //   PACK_SIZE   → todas las líneas con el % del nivel alcanzado
  // Por eso no hace falta el discriminador `emit` que sí necesitan los
  // escalonados (allí un uniforme puede producir importes).
  //
  // ⚠️ `percentage.value` se emite como NÚMERO y el tipo generado lo declara
  // `string` (el escalar Decimal). Eso produce un error de typecheck —el mismo,
  // exacto, que ya arrastra `tiered-discount`— y NO se enmascara con `as`,
  // porque este repo no lo hace en ningún sitio. Se deja como número a
  // propósito: es lo que las fixtures verifican contra el Wasm REAL, y es lo
  // que la Function de escalonados lleva emitiendo en producción desde julio de
  // 2026. Divergir en esto entre las dos Functions sería peor que el error de
  // tipos.
  const candidates: ProductDiscountCandidate[] = outcome.lines.map((l) => ({
    message,
    targets: [{cartLine: {id: l.lineId}}],
    value: {percentage: {value: l.percent}},
  }));

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // ALL, no First: cada candidate apunta a UNA línea distinta y todas
          // deben recibir su descuento. `First` aplicaría uno solo y descartaría
          // el resto — con un pack de 3 productos se descontaría uno. Es el
          // mismo razonamiento que hay en tiered-discount; no cambiar sin
          // releer esto.
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

/** Lee y valida mínimamente el metafield. Devuelve null si no es usable. */
function readConfig(input: CartInput): PackFunctionConfig | null {
  const raw = (input.discount.config?.jsonValue ??
    input.discount.configFallback?.jsonValue) as PackFunctionConfig | undefined;

  if (!raw) return null;

  // Sin identidad no hay forma de saber si las líneas son de este pack.
  if (typeof raw.campaignId !== 'string' || !raw.campaignId) return null;

  if (raw.mode !== 'PER_PRODUCT' && raw.mode !== 'PACK_SIZE') return null;
  if (!Array.isArray(raw.products) || raw.products.length === 0) return null;

  // En modo por tamaño, sin niveles no hay nada que resolver. `computePack` ya
  // lo trata, pero cortar acá evita recorrer el carrito para nada.
  if (raw.mode === 'PACK_SIZE' && (!Array.isArray(raw.tiers) || raw.tiers.length === 0))
    return null;

  return raw;
}
