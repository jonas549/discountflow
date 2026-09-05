// Gestión de campañas CART_VALUE ("gastá $100 y ahorrás $10") vía Functions.
//
// Mismo patrón que TIERED y PACK: no se tocan precios de variantes, se crea un
// descuento automático de app que apunta a la Function `order-discount`, y la
// configuración viaja en un metafield del descuento.
//
// La diferencia está en la CLASE: éste es el primer descuento de la app de clase
// ORDER, no PRODUCT. Se aplica al subtotal del carrito entero, no a líneas.

import { prisma } from "../db";
import { runDiscountMutation, type AdminClient } from "./discount-mutation";
import { getDiscountFunctionId, CART_VALUE_FUNCTION_HANDLE } from "./function-id";
import {
  type CartValueCampaignConfig,
  toCartValueFunctionConfig,
  cartValueDiscountTitle,
  CART_VALUE_METAFIELD_KEY,
} from "./cart-value-client";

/**
 * Namespace PLANO a propósito: MetafieldInput solo admite alfanuméricos,
 * guiones y guiones bajos, así que "$app:discountflow" podría ser rechazado.
 * La Function lee los dos (ver su input query).
 */
const METAFIELD_NAMESPACE = "discountflow";

/**
 * Con qué otros descuentos automáticos convive el descuento por monto.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 `productDiscounts: true` NO ES UN "que se sumen todos".
 *
 * Es lo que hace falta para que Shopify NO descarte este descuento por su
 * cuenta cuando en el carrito hay un pack o un escalonado. Sin esto, la
 * decisión de quién gana la toma Shopify, en silencio — que es exactamente el
 * fallo medido el 2026-09-05: un pack aplicó su 30% y este descuento
 * desapareció sin dejar rastro en ningún lado.
 *
 * Quién gana lo decide el MERCHANT, con la exclusión entre campañas
 * (`excludedPackCampaignIds`), y la Function registra el motivo cuando no
 * aplica. `combinesWith` deja pasar; la exclusión decide.
 *
 * `orderDiscounts: false`: dos descuentos de orden a la vez sí serían un
 * descuento sobre el descuento del mismo eje. No se ofrece.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const COMBINACION_DEL_VALOR_DE_CARRITO = {
  orderDiscounts: false,
  productDiscounts: true,
  shippingDiscounts: false,
};

/** El ID de la Function de valor de carrito en esta tienda. */
export async function getCartValueFunctionId(admin: AdminClient): Promise<string> {
  return getDiscountFunctionId(admin, CART_VALUE_FUNCTION_HANDLE, {
    // `false`, igual que packs: con tres Functions instaladas, "es la única de
    // descuento" no identifica a nadie, y acertar por descarte enganchando la
    // Function equivocada es peor que fallar.
    allowSingleFunctionFallback: false,
  });
}

export async function createCartValueDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  config: CartValueCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<string> {
  const functionId = await getCartValueFunctionId(admin);
  const functionConfig = toCartValueFunctionConfig(config);

  const result = await runDiscountMutation(
    admin,
    `#graphql
    mutation CreateCartValue($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      discount: {
        title: cartValueDiscountTitle(campaignName),
        functionId,
        startsAt: (startsAt ?? new Date()).toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        // 🔴 ORDER, no PRODUCT. La Function lo comprueba y se niega a descontar
        // si no coincide: un descuento creado con la clase equivocada no
        // aplicaría nada, en silencio.
        discountClasses: ["ORDER"],
        combinesWith: COMBINACION_DEL_VALOR_DE_CARRITO,
        metafields: [
          {
            namespace: METAFIELD_NAMESPACE,
            key: CART_VALUE_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(functionConfig),
          },
        ],
      },
    },
    "discountAutomaticAppCreate"
  );

  const shopifyDiscountId = (
    result.automaticAppDiscount as { discountId?: string } | undefined
  )?.discountId;

  if (!shopifyDiscountId) throw new Error("Shopify no retornó un ID de descuento");

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      config: {
        ...config,
        shopifyDiscountId,
        functionId,
      } as unknown as Record<string, unknown>,
    },
  });

  return shopifyDiscountId;
}

/** Reescribe título, fechas, combinación y metafield de un descuento existente. */
export async function updateCartValueDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  shopifyDiscountId: string,
  config: CartValueCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<void> {
  const functionConfig = toCartValueFunctionConfig(config);

  await runDiscountMutation(
    admin,
    `#graphql
    mutation UpdateCartValue($id: ID!, $discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      id: shopifyDiscountId,
      discount: {
        title: cartValueDiscountTitle(campaignName),
        startsAt: (startsAt ?? new Date()).toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        // Se reescribe también al actualizar, por el mismo motivo que en packs:
        // si no, un descuento creado con una combinación vieja se quedaría con
        // ella para siempre.
        combinesWith: COMBINACION_DEL_VALOR_DE_CARRITO,
        metafields: [
          {
            namespace: METAFIELD_NAMESPACE,
            key: CART_VALUE_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(functionConfig),
          },
        ],
      },
    },
    "discountAutomaticAppUpdate"
  );

  void campaignId;
}

// ─── Activar / pausar / eliminar ─────────────────────────────────────────────

export async function activateCartValueDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation ActivateCartValue($id: ID!) {
      discountAutomaticActivate(id: $id) { userErrors { field message } }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticActivate"
  );
}

export async function deactivateCartValueDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeactivateCartValue($id: ID!) {
      discountAutomaticDeactivate(id: $id) { userErrors { field message } }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticDeactivate"
  );
}

export async function deleteCartValueDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeleteCartValue($id: ID!) {
      discountAutomaticDelete(id: $id) { userErrors { field message } }
    }`,
    { id: shopifyDiscountId },
    "discountAutomaticDelete"
  );
}
