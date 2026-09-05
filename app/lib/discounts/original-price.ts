// Gestión de campañas CODE_ORIGINAL_PRICE (cupón sobre el precio original).
//
// 🔴 ES EL PRIMER DESCUENTO DE CÓDIGO DE LA APP.
//
// Los otros cuatro tipos crean descuentos AUTOMÁTICOS
// (`discountAutomaticApp*`). Éste crea uno de CÓDIGO (`discountCodeApp*`), que
// es otra familia de mutaciones: el comprador tiene que escribir el código para
// que aplique. Los nombres se parecen lo suficiente como para copiar el
// equivocado, así que están escritos completos y sin abreviar.

import { prisma } from "../db";
import { runDiscountMutation, type AdminClient } from "./discount-mutation";
import { getDiscountFunctionId, ORIGINAL_PRICE_FUNCTION_HANDLE } from "./function-id";
import {
  type OriginalPriceCampaignConfig,
  toOriginalPriceFunctionConfig,
  originalPriceDiscountTitle,
  normalizeDiscountCode,
  ORIGINAL_PRICE_METAFIELD_KEY,
} from "./original-price-client";

/**
 * Namespace PLANO a propósito: MetafieldInput solo admite alfanuméricos,
 * guiones y guiones bajos, así que "$app:discountflow" podría ser rechazado.
 * La Function lee los dos (ver su input query).
 */
const METAFIELD_NAMESPACE = "discountflow";

/**
 * Con qué otros descuentos convive el cupón.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 LOS DOS EN `true` NO ES "que se sumen todos".
 *
 * Es lo que hace falta para que Shopify NO descarte el cupón por su cuenta
 * cuando en el carrito hay un pack, un escalonado o un descuento por monto.
 * Sin esto, la decisión de quién gana la toma Shopify en silencio — que es
 * exactamente el fallo medido el 2026-09-05, cuando un pack hizo desaparecer
 * el descuento por monto sin dejar rastro.
 *
 * Quién gana lo decide el MERCHANT con la exclusión entre campañas
 * (`excludedPackCampaignIds`), y la Function registra el motivo cuando no
 * aplica. `combinesWith` deja pasar; la exclusión decide.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const COMBINACION_DEL_CUPON = {
  orderDiscounts: true,
  productDiscounts: true,
  shippingDiscounts: false,
};

/** El ID de la Function del cupón en esta tienda. */
export async function getOriginalPriceFunctionId(admin: AdminClient): Promise<string> {
  return getDiscountFunctionId(admin, ORIGINAL_PRICE_FUNCTION_HANDLE, {
    // `false`, igual que packs y valor de carrito: con cuatro Functions
    // instaladas, "es la única de descuento" no identifica a nadie, y acertar
    // por descarte enganchando la Function equivocada es peor que fallar.
    allowSingleFunctionFallback: false,
  });
}

/**
 * Traduce el error de Shopify cuando el código ya existe.
 *
 * Sin esto el merchant lee un mensaje de la API sobre un campo que no vio en
 * ninguna pantalla. El código duplicado es el único error de este formulario
 * que va a pasar de verdad, y tiene que decir qué hacer.
 */
function traducirError(err: unknown, code: string): Error {
  const texto = String(err);
  if (/taken|already exists|must be unique/i.test(texto))
    return new Error(
      `El código "${code}" ya está en uso en esta tienda. Probá con otro.`
    );
  return err instanceof Error ? err : new Error(texto);
}

export async function createOriginalPriceDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  config: OriginalPriceCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<string> {
  const functionId = await getOriginalPriceFunctionId(admin);
  const functionConfig = toOriginalPriceFunctionConfig(config);
  const code = normalizeDiscountCode(config.code);

  let result;
  try {
    result = await runDiscountMutation(
      admin,
      `#graphql
      mutation CreateOriginalPrice($codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      {
        codeAppDiscount: {
          title: originalPriceDiscountTitle(campaignName),
          functionId,
          code,
          startsAt: (startsAt ?? new Date()).toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          // 🔴 PRODUCT: el cupón descuenta líneas, no el subtotal. La Function
          // lo comprueba y se niega si no coincide — un descuento creado con la
          // clase equivocada no aplicaría nada, en silencio.
          discountClasses: ["PRODUCT"],
          combinesWith: COMBINACION_DEL_CUPON,
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key: ORIGINAL_PRICE_METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(functionConfig),
            },
          ],
        },
      },
      "discountCodeAppCreate"
    );
  } catch (err) {
    throw traducirError(err, code);
  }

  const shopifyDiscountId = (
    result.codeAppDiscount as { discountId?: string } | undefined
  )?.discountId;

  if (!shopifyDiscountId) throw new Error("Shopify no retornó un ID de descuento");

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      config: {
        ...config,
        code,
        shopifyDiscountId,
        functionId,
      } as unknown as Record<string, unknown>,
    },
  });

  return shopifyDiscountId;
}

/** Reescribe título, código, fechas, combinación y metafield. */
export async function updateOriginalPriceDiscount(
  admin: AdminClient,
  campaignId: string,
  campaignName: string,
  shopifyDiscountId: string,
  config: OriginalPriceCampaignConfig,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<void> {
  const functionConfig = toOriginalPriceFunctionConfig(config);
  const code = normalizeDiscountCode(config.code);

  try {
    await runDiscountMutation(
      admin,
      `#graphql
      mutation UpdateOriginalPrice($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      {
        id: shopifyDiscountId,
        codeAppDiscount: {
          title: originalPriceDiscountTitle(campaignName),
          // El código se reescribe: el merchant puede cambiarlo, y si no lo
          // mandáramos quedaría el viejo funcionando y el nuevo sin existir.
          code,
          startsAt: (startsAt ?? new Date()).toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          // Se reescribe también al actualizar, por el mismo motivo que en los
          // otros tipos: si no, un descuento creado con una combinación vieja
          // se quedaría con ella para siempre.
          combinesWith: COMBINACION_DEL_CUPON,
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key: ORIGINAL_PRICE_METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(functionConfig),
            },
          ],
        },
      },
      "discountCodeAppUpdate"
    );
  } catch (err) {
    throw traducirError(err, code);
  }

  void campaignId;
}

// ─── Activar / pausar / eliminar ─────────────────────────────────────────────
//
// ⚠️ `discountCode*`, no `discountAutomatic*`. Son otra familia de mutaciones y
// los nombres se parecen lo suficiente como para copiar el equivocado.

export async function activateOriginalPriceDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation ActivateOriginalPrice($id: ID!) {
      discountCodeActivate(id: $id) { userErrors { field message } }
    }`,
    { id: shopifyDiscountId },
    "discountCodeActivate"
  );
}

export async function deactivateOriginalPriceDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeactivateOriginalPrice($id: ID!) {
      discountCodeDeactivate(id: $id) { userErrors { field message } }
    }`,
    { id: shopifyDiscountId },
    "discountCodeDeactivate"
  );
}

export async function deleteOriginalPriceDiscount(
  admin: AdminClient,
  shopifyDiscountId: string
): Promise<void> {
  await runDiscountMutation(
    admin,
    `#graphql
    mutation DeleteOriginalPrice($id: ID!) {
      discountCodeDelete(id: $id) { userErrors { field message } }
    }`,
    { id: shopifyDiscountId },
    "discountCodeDelete"
  );
}
