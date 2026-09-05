// Validación del formulario de packs. NO entra en el Wasm.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ ESTO NO ESTÁ EN pack-calc.ts
//
// `pack-calc.ts` se compila DENTRO de la Function: cualquier cambio ahí obliga
// a desplegar la Function contra la app de producción. La validación del
// formulario y el tope del catálogo no tienen nada que ver con el dinero — son
// del admin y del widget — y no había ninguna razón para que compartieran ese
// riesgo. Vivían ahí por inercia.
//
// La Function NO importa este archivo (solo importa `computePack` y tipos), así
// que a partir de acá el tope del catálogo se puede mover sin tocar el Wasm.
// ═══════════════════════════════════════════════════════════════════════════

import {
  MIN_PACK_PRODUCTS,
  MAX_PACK_TIERS,
  type PackMode,
  type PackProduct,
  type PackTier,
} from "./pack-calc.ts";

/**
 * Tope de productos que el merchant puede curar en un pack.
 *
 * 🔴 20, y el número NO es estético: es el límite duro del objeto `all_products`
 * de Liquid, que solo resuelve 20 handles distintos por página. El bloque del
 * tema pinta el catálogo en el servidor leyendo `all_products[handle]` para
 * tener el precio y la foto EN VIVO — que es lo que eliminó el «Cargando tu
 * pack…» — y con 21 productos el número 21 saldría vacío.
 *
 * Antes eran 24, elegidos solo por legibilidad. Bajarlo fue una decisión de
 * producto del 2026-09-05: un primer pintado completo vale más que cuatro
 * productos más en una lista que ya era larga.
 *
 * ⚠️ El límite de `all_products` es POR PÁGINA, no por bloque: si el tema del
 * merchant ya usa `all_products` en otra sección, el cupo se comparte. El
 * bloque cuenta cuántos productos resolvió y, si le faltan, el widget los
 * completa contra el app proxy sin mostrar ningún estado de carga.
 */
export const MAX_PACK_CATALOG = 20;

// ─── Validación ──────────────────────────────────────────────────────────────

export type PackValidation = { errors: string[]; warnings: string[] };

export function validatePack(
  mode: PackMode,
  catalog: PackProduct[],
  tiers: PackTier[]
): PackValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (catalog.length === 0) {
    errors.push("Elegí al menos un producto para el pack.");
  } else if (catalog.length < MIN_PACK_PRODUCTS) {
    errors.push(
      `Un pack necesita al menos ${MIN_PACK_PRODUCTS} productos para que el comprador pueda armarlo.`
    );
  }

  if (catalog.length > MAX_PACK_CATALOG) {
    errors.push(
      `El pack admite hasta ${MAX_PACK_CATALOG} productos. Elegiste ${catalog.length}.`
    );
  }

  if (mode === "PER_PRODUCT") {
    const conDescuento = catalog.filter((p) => (p.percent ?? 0) > 0);
    if (conDescuento.length === 0)
      errors.push("Ningún producto tiene descuento: el pack no rebajaría nada.");
    else if (conDescuento.length < catalog.length)
      warnings.push(
        `${catalog.length - conDescuento.length} de ${catalog.length} productos están al 0%: entran al pack pero no rebajan.`
      );
  } else {
    if (tiers.length === 0) {
      errors.push("Agregá al menos un nivel de descuento por tamaño del pack.");
    } else {
      if (tiers.length > MAX_PACK_TIERS)
        errors.push(`Máximo ${MAX_PACK_TIERS} niveles. Definiste ${tiers.length}.`);
      if (tiers.every((t) => t.percent <= 0))
        errors.push("Todos los niveles están al 0%: el pack no rebajaría nada.");

      const tope = tiers[tiers.length - 1];
      if (tope.minProducts > catalog.length)
        warnings.push(
          `El nivel de ${tope.minProducts} productos es inalcanzable: el pack solo ofrece ${catalog.length}.`
        );

      for (let i = 1; i < tiers.length; i++) {
        if (tiers[i].percent < tiers[i - 1].percent) {
          warnings.push(
            `El nivel de ${tiers[i].minProducts} productos descuenta menos que el anterior. Revisá que sea intencional.`
          );
          break;
        }
      }
    }
  }

  return { errors, warnings };
}
