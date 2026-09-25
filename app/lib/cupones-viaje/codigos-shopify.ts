// Los códigos NATIVOS de Shopify detrás de cada cupón de viaje.
//
// Son plomería interna: el merchant crea y edita cupones en DiscountFlow y no se
// entera de que existen. El comprador tampoco los escribe — los aplica el widget.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ UN CÓDIGO NATIVO (`discountCodeBasic*`) Y NO UNA FUNCTION
//
// El caso Pago total es un descuento de monto fijo sobre ciertas variantes, y
// eso Shopify lo sabe hacer solo. Verificado por introspección contra la tienda
// de dev (2026-09-25, API 2025-10):
//
//   · `DiscountProductsInput.productVariantsToAdd` existe → el descuento se
//     puede limitar a las variantes «Pago total» y NO tocar las de «Reserva».
//   · `DiscountAmountInput { amount, appliesOnEachItem }` → monto fijo, y
//     `appliesOnEachItem: false` lo aplica una vez por pedido.
//   · `usageLimit` → Shopify frena el código en el checkout al agotarse.
//
// Sin Function no hay Wasm que recompilar ni app version que sacar: todo esto
// despliega solo con Vercel y no toca a las tiendas que ya están en producción.
// ═══════════════════════════════════════════════════════════════════════════

import { runDiscountMutation, type AdminClient } from "../discounts/discount-mutation.ts";
import { esDescuentoInexistente } from "../discounts/original-price-client.ts";
import { POR_PASAJERO } from "./cupones-viaje.ts";

export type DatosDelCodigo = {
  title: string;
  code: string;
  /** En unidades de la moneda de la tienda. */
  amount: number;
  /** Solo las variantes «Pago total». */
  variantIds: string[];
  usageLimit: number;
};

/**
 * Con qué convive el cupón.
 *
 * 🟡 Todo en `false` salvo el envío. Un viaje de $4.000.000 con un cupón de la
 * agencia no debería sumarse a otro código de producto u orden sin que alguien
 * lo haya decidido: si el comprador trae otro código, Shopify se queda con el
 * mejor de los dos. Cambiarlo es decisión de la agencia, no un detalle técnico.
 */
const COMBINACION = { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true };

function inputDelCodigo(d: DatosDelCodigo) {
  if (d.variantIds.length === 0)
    // Un código sin variantes sería un descuento sobre NADA, o peor: según la
    // versión de la API, sobre todo. Se corta antes de llegar a Shopify.
    throw new Error("El viaje no tiene variantes de «Pago total»: no hay a qué aplicar el cupón.");

  return {
    title: d.title,
    code: d.code,
    startsAt: new Date().toISOString(),
    endsAt: null,
    usageLimit: d.usageLimit,
    appliesOncePerCustomer: false,
    // 🔴 OBLIGATORIO. Sin él Shopify rechaza con «Context can't be blank»
    // (medido contra la tienda de dev el 2026-09-25). Reemplaza al deprecado
    // `customerSelection`; forma verificada por introspección:
    // `DiscountContextInput.all: DiscountBuyerSelection` con el único valor ALL.
    context: { all: "ALL" },
    combinesWith: COMBINACION,
    customerGets: {
      value: {
        discountAmount: {
          amount: d.amount.toFixed(2),
          // true = el monto se descuenta en CADA artículo (por pasajero);
          // false lo repartiría una sola vez entre todos. Ver `POR_PASAJERO`.
          appliesOnEachItem: POR_PASAJERO,
        },
      },
      items: { products: { productVariantsToAdd: d.variantIds } },
    },
  };
}

export async function crearCodigo(admin: AdminClient, d: DatosDelCodigo): Promise<string> {
  const r = await runDiscountMutation(
    admin,
    `#graphql
    mutation CrearCuponDeViaje($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    { basicCodeDiscount: inputDelCodigo(d) },
    "discountCodeBasicCreate"
  );
  const id = (r.codeDiscountNode as { id?: string } | undefined)?.id;
  if (!id) throw new Error("Shopify no devolvió el id del código del cupón.");
  return id;
}

/**
 * Reescribe monto, variantes y límite.
 *
 * 🔴 Las variantes se reescriben enteras: se QUITAN las que ya no son de Pago
 * total antes de agregar las de hoy. Si solo se agregaran, una variante que el
 * merchant pasó a «Reserva» seguiría recibiendo el descuento real.
 */
export async function actualizarCodigo(
  admin: AdminClient,
  id: string,
  d: DatosDelCodigo,
  variantesAnteriores: string[]
): Promise<void> {
  const input = inputDelCodigo(d);
  const quitar = variantesAnteriores.filter((v) => !d.variantIds.includes(v));
  if (quitar.length > 0)
    (input.customerGets.items.products as Record<string, unknown>).productVariantsToRemove = quitar;
  // `startsAt` no se toca al actualizar: moverlo a "ahora" no cambia nada útil
  // y deja el historial del descuento con una fecha falsa.
  const { startsAt: _startsAt, ...sinFecha } = input;
  await runDiscountMutation(
    admin,
    `#graphql
    mutation ActualizarCuponDeViaje($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    { id, basicCodeDiscount: sinFecha },
    "discountCodeBasicUpdate"
  );
}

async function operar(
  admin: AdminClient,
  id: string,
  mutacion: "discountCodeActivate" | "discountCodeDeactivate" | "discountCodeDelete",
  toleraAusencia: boolean
): Promise<void> {
  try {
    await runDiscountMutation(
      admin,
      `#graphql
      mutation OperarCuponDeViaje($id: ID!) {
        ${mutacion}(id: $id) { userErrors { field message } }
      }`,
      { id },
      mutacion
    );
  } catch (err) {
    // Desactivar o borrar algo que ya no existe cumple el objetivo: que el
    // código no descuente. Activarlo NO — ahí el error tiene que salir, o la
    // app mostraría un cupón publicado que en el checkout no existe.
    if (toleraAusencia && esDescuentoInexistente(err)) {
      console.warn(`[cupones-viaje] ${mutacion}: ${id} ya no existe en Shopify; se da por hecho.`);
      return;
    }
    throw err;
  }
}

export const activarCodigo = (admin: AdminClient, id: string) =>
  operar(admin, id, "discountCodeActivate", false);
export const desactivarCodigo = (admin: AdminClient, id: string) =>
  operar(admin, id, "discountCodeDeactivate", true);
export const eliminarCodigo = (admin: AdminClient, id: string) =>
  operar(admin, id, "discountCodeDelete", true);
