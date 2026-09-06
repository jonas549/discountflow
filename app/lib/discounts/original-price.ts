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
import { getCollectionProductVariants } from "../shopify/admin-api";
import { runDiscountMutation, type AdminClient } from "./discount-mutation";
import { getDiscountFunctionId, ORIGINAL_PRICE_FUNCTION_HANDLE } from "./function-id";
import {
  type OriginalPriceCampaignConfig,
  type OriginalPriceMetodo,
  toOriginalPriceFunctionConfig,
  originalPriceDiscountTitle,
  originalPriceMetodo,
  originalPriceUsaCodigo,
  normalizeDiscountCode,
  ORIGINAL_PRICE_METAFIELD_KEY,
} from "./original-price-client";
import { type ExclusionPorMonto } from "./original-price-calc";
import { cartValueMinimum, type CartValueCampaignConfig } from "./cart-value-client";

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

/**
 * Resuelve a qué productos aplica el cupón.
 *
 * La Function solo entiende productos: dentro del checkout no se puede
 * consultar qué hay en una colección. Así que las colecciones se expanden ACÁ,
 * al guardar, exactamente igual que en Escalonado.
 *
 * 🔴 Resolver a CERO productos LANZA, y es a propósito. Una campaña por
 * colección que no abarca ningún producto no tiene ningún uso legítimo: o la
 * colección está vacía, o la API falló. Guardarla en silencio dejaría una
 * campaña activa y visible que no descuenta nada — y el merchant culparía al
 * cupón, no a su colección.
 */
export async function resolveOriginalPriceProductIds(
  admin: AdminClient,
  config: OriginalPriceCampaignConfig
): Promise<string[]> {
  const mode = config.selectionMode ?? "all";

  if (mode === "all") return [];

  if (mode === "products") {
    const ids = config.productIds ?? [];
    if (ids.length === 0)
      throw new Error(
        "La campaña no tiene ningún producto seleccionado. Elegí al menos uno."
      );
    return ids;
  }

  const collectionIds = config.collectionIds ?? [];
  if (collectionIds.length === 0)
    throw new Error(
      "La campaña no tiene ninguna colección seleccionada. Elegí al menos una."
    );

  const vistos = new Set<string>();
  for (const collectionId of collectionIds) {
    for (const pv of await getCollectionProductVariants(admin, collectionId)) {
      vistos.add(pv.productId);
    }
  }

  if (vistos.size === 0)
    throw new Error(
      collectionIds.length === 1
        ? "La colección seleccionada no contiene ningún producto. Agregá productos a la colección o elegí otra."
        : "Las colecciones seleccionadas no contienen ningún producto. Agregá productos o elegí otras."
    );

  return [...vistos];
}

/**
 * Resuelve el umbral de cada campaña de monto de compra que el merchant excluyó.
 *
 * La config del cupón solo guarda IDs; el umbral vive en la OTRA campaña, así
 * que hay que ir a buscarlo. Se resuelve al guardar y viaja como una foto en el
 * metafield — ver `evaluarExclusionPorMonto` para por qué se recalcula en vez de
 * observar qué aplicó.
 *
 * 🔴 NUNCA LANZA. Una campaña excluida que ya no existe, o que se quedó sin
 * niveles, no puede impedir que se guarde el cupón: se deja fuera de la lista y
 * queda dicho en el log. Lanzar acá convertiría el borrado de otra campaña en
 * un cupón que no se puede editar.
 */
export async function resolverExclusionesPorMonto(
  shopId: string,
  campaignIds: string[] | undefined
): Promise<ExclusionPorMonto[]> {
  const ids = (campaignIds ?? []).filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
  if (ids.length === 0) return [];

  const campanas = await prisma.campaign.findMany({
    where: { id: { in: ids }, shopId, type: "CART_VALUE" },
    select: { id: true, name: true, config: true },
  });

  const resueltas: ExclusionPorMonto[] = [];
  for (const c of campanas) {
    const minSubtotal = cartValueMinimum(
      c.config as unknown as CartValueCampaignConfig
    );
    if (minSubtotal > 0) resueltas.push({ campaignId: c.id, minSubtotal });
    else
      console.warn(
        `[original-price] la campana de monto "${c.name}" (${c.id}) no tiene un ` +
          "umbral usable; la exclusion no viaja al metafield."
      );
  }

  if (resueltas.length !== ids.length)
    console.warn(
      `[original-price] exclusiones por monto: se pidieron ${ids.length} y se ` +
        `resolvieron ${resueltas.length}. Las que faltan ya no existen o no tienen niveles.`
    );

  return resueltas;
}

/**
 * Los dos límites de uso que Shopify SÍ hace cumplir por su cuenta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 VERIFICADO POR INTROSPECCIÓN CONTRA LA TIENDA (2026-09-06, API 2025-10).
 *
 * `DiscountCodeAppInput` tiene exactamente estos dos campos para esto:
 *
 *   · `usageLimit: Int`               → veces en total. `null` = sin límite.
 *   · `appliesOncePerCustomer: Boolean` → un uso por cliente.
 *
 * ⚠️ EL NOMBRE ES `appliesOncePerCustomer`. La documentación de shopify.dev
 * muestra en algunas páginas `appliesToOncePerCustomer`, que NO existe: un
 * campo inventado hace fallar la mutación entera. El nombre de acá salió del
 * schema real de la tienda, no de los docs.
 *
 * Al ser nativos, Shopify los comprueba ANTES de llamar a la Function: un
 * código agotado se rechaza en el carrito con su propio mensaje, sin que
 * nuestro código intervenga. Eso es exactamente lo que se quiere para el caso
 * de los influencers — que el código deje de funcionar, no que aplique $0.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function limitesDeUso(config: OriginalPriceCampaignConfig): {
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
} {
  // 🔴 En el método AUTOMÁTICO estos dos campos NO EXISTEN en el input de
  // Shopify (`DiscountAutomaticAppInput`, verificado por introspección). Quien
  // llama ni los usa; este guard está para que, si alguien los mezcla por
  // error, el resultado sea "sin límite" y no una mutación rechazada.
  if (!originalPriceUsaCodigo(config))
    return { usageLimit: null, appliesOncePerCustomer: false };

  const bruto = config.usageLimit;
  const usageLimit =
    typeof bruto === "number" && Number.isFinite(bruto) && bruto > 0
      ? Math.floor(bruto)
      : null;

  return { usageLimit, appliesOncePerCustomer: config.oncePerCustomer === true };
}

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

  // Las colecciones se expanden ACÁ, no en la ruta: así los dos caminos que
  // crean un descuento —el admin y el motor de jobs— resuelven igual. Es el
  // mismo sitio en el que lo hace `createTieredDiscount`.
  const productIds = await resolveOriginalPriceProductIds(admin, config);
  const resuelta: OriginalPriceCampaignConfig = { ...config, productIds, functionId };

  const exclusiones = await resolverExclusionesPorMonto(
    await shopIdDeLaCampana(campaignId),
    config.excludedCartValueCampaignIds
  );
  const functionConfig = toOriginalPriceFunctionConfig(resuelta, exclusiones);
  const code = normalizeDiscountCode(config.code);
  const metodo = originalPriceMetodo(config);

  /**
   * Lo que comparten los dos métodos. Se arma una vez para que no puedan
   * divergir: la clase, la combinación y el metafield tienen que ser idénticos
   * o el mismo cupón se comportaría distinto según cómo se activa.
   */
  const comun = {
    title: originalPriceDiscountTitle(campaignName),
    functionId,
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
  };

  let result;
  try {
    result =
      metodo === "CODE"
        ? await runDiscountMutation(
            admin,
            `#graphql
            mutation CreateOriginalPriceCode($codeAppDiscount: DiscountCodeAppInput!) {
              discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
                codeAppDiscount { discountId }
                userErrors { field message }
              }
            }`,
            {
              codeAppDiscount: {
                ...comun,
                code,
                // Los dos límites nativos, que SOLO existen en el método de
                // código. Ver `limitesDeUso`.
                ...limitesDeUso(config),
              },
            },
            "discountCodeAppCreate"
          )
        : await runDiscountMutation(
            admin,
            `#graphql
            mutation CreateOriginalPriceAutomatic($automaticAppDiscount: DiscountAutomaticAppInput!) {
              discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
                automaticAppDiscount { discountId }
                userErrors { field message }
              }
            }`,
            // 🔴 SIN `code` y SIN los límites de uso: ninguno de los tres
            // existe en `DiscountAutomaticAppInput`. Mandarlos haría fallar la
            // mutación entera.
            { automaticAppDiscount: comun },
            "discountAutomaticAppCreate"
          );
  } catch (err) {
    throw traducirError(err, code);
  }

  const shopifyDiscountId = (
    (metodo === "CODE" ? result.codeAppDiscount : result.automaticAppDiscount) as
      | { discountId?: string }
      | undefined
  )?.discountId;

  if (!shopifyDiscountId) throw new Error("Shopify no retornó un ID de descuento");

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      config: {
        // `resuelta`, no `config`: si guardáramos la config de entrada, las
        // campañas por colección quedarían en la base sin los productos que
        // sí fueron al metafield, y el contador de la pantalla mostraría cero.
        ...resuelta,
        code,
        metodo,
        shopifyDiscountId,
        functionId,
      } as unknown as Record<string, unknown>,
    },
  });

  return shopifyDiscountId;
}

/**
 * La tienda dueña de una campaña.
 *
 * Hace falta para resolver los umbrales de las campañas de monto excluidas, y
 * se busca acá en vez de pedirlo por parámetro para no cambiar la firma de
 * `create`/`update`: las llaman las rutas del admin **y** el motor de jobs, y
 * una firma nueva es un sitio más donde uno de los dos se queda atrás.
 */
async function shopIdDeLaCampana(campaignId: string): Promise<string> {
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { shopId: true },
  });
  return c?.shopId ?? "";
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
  // Se vuelve a resolver en cada edición, y no se reutiliza lo guardado: si el
  // merchant agregó productos a la colección desde la última vez, esta es la
  // única oportunidad de que entren.
  const productIds = await resolveOriginalPriceProductIds(admin, config);
  const resuelta: OriginalPriceCampaignConfig = { ...config, productIds };

  const shopId = await shopIdDeLaCampana(campaignId);
  const exclusiones = await resolverExclusionesPorMonto(
    shopId,
    config.excludedCartValueCampaignIds
  );
  const functionConfig = toOriginalPriceFunctionConfig(resuelta, exclusiones);
  const code = normalizeDiscountCode(config.code);
  const metodo = originalPriceMetodo(config);

  const comun = {
    title: originalPriceDiscountTitle(campaignName),
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
  };

  try {
    if (metodo === "CODE") {
      await runDiscountMutation(
        admin,
        `#graphql
        mutation UpdateOriginalPriceCode($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
          discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
            codeAppDiscount { discountId }
            userErrors { field message }
          }
        }`,
        {
          id: shopifyDiscountId,
          codeAppDiscount: {
            ...comun,
            // El código se reescribe: el merchant puede cambiarlo, y si no lo
            // mandáramos quedaría el viejo funcionando y el nuevo sin existir.
            code,
            // 🔴 Y los límites de uso IGUAL, por el mismo motivo. Si no se
            // mandaran al actualizar, quitar el límite en el formulario dejaría
            // el viejo vivo en Shopify: el merchant vería "sin límite" en la app
            // y el código se agotaría a las 100 usos. Es el fallo del
            // `combinesWith` que no se reescribía, con otro campo.
            ...limitesDeUso(config),
          },
        },
        "discountCodeAppUpdate"
      );
    } else {
      await runDiscountMutation(
        admin,
        `#graphql
        mutation UpdateOriginalPriceAutomatic($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
          discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
            automaticAppDiscount { discountId }
            userErrors { field message }
          }
        }`,
        { id: shopifyDiscountId, automaticAppDiscount: comun },
        "discountAutomaticAppUpdate"
      );
    }
  } catch (err) {
    throw traducirError(err, code);
  }

  // 🔴 Persistir los productos resueltos. Antes esta función terminaba en
  // `void campaignId` porque no había nada que guardar; ahora sí lo hay, y sin
  // esto la base y el metafield contarían productos distintos.
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      config: { ...resuelta, code, metodo } as unknown as Record<string, unknown>,
    },
  });
}

// ─── Activar / pausar / eliminar ─────────────────────────────────────────────
//
// ⚠️ `discountCode*`, no `discountAutomatic*`. Son otra familia de mutaciones y
// los nombres se parecen lo suficiente como para copiar el equivocado.

/**
 * Las tres operaciones de ciclo de vida, ramificadas por método.
 *
 * 🔴 El `metodo` se pasa explícito y NO se adivina del ID. Los GIDs de un
 * descuento de código y de uno automático se parecen (`gid://shopify/Discount...`)
 * y acertar por la forma del ID sería exactamente el tipo de suposición que ya
 * costó incidentes en este repo. Quien llama sabe qué campaña es; que lo diga.
 *
 * ⚠️ Llamar a la mutación de la familia equivocada NO es silencioso: Shopify
 * devuelve un `userError` y `runDiscountMutation` lanza.
 */
const CICLO_DE_VIDA = {
  activar: {
    CODE: ["ActivateOriginalPriceCode", "discountCodeActivate"],
    AUTOMATIC: ["ActivateOriginalPriceAutomatic", "discountAutomaticActivate"],
  },
  pausar: {
    CODE: ["DeactivateOriginalPriceCode", "discountCodeDeactivate"],
    AUTOMATIC: ["DeactivateOriginalPriceAutomatic", "discountAutomaticDeactivate"],
  },
  eliminar: {
    CODE: ["DeleteOriginalPriceCode", "discountCodeDelete"],
    AUTOMATIC: ["DeleteOriginalPriceAutomatic", "discountAutomaticDelete"],
  },
} as const;

async function operarCicloDeVida(
  admin: AdminClient,
  shopifyDiscountId: string,
  operacion: keyof typeof CICLO_DE_VIDA,
  metodo: OriginalPriceMetodo
): Promise<void> {
  const [nombre, mutacion] = CICLO_DE_VIDA[operacion][metodo];
  await runDiscountMutation(
    admin,
    `#graphql
    mutation ${nombre}($id: ID!) {
      ${mutacion}(id: $id) { userErrors { field message } }
    }`,
    { id: shopifyDiscountId },
    mutacion
  );
}

export async function activateOriginalPriceDiscount(
  admin: AdminClient,
  shopifyDiscountId: string,
  metodo: OriginalPriceMetodo = "CODE"
): Promise<void> {
  await operarCicloDeVida(admin, shopifyDiscountId, "activar", metodo);
}

export async function deactivateOriginalPriceDiscount(
  admin: AdminClient,
  shopifyDiscountId: string,
  metodo: OriginalPriceMetodo = "CODE"
): Promise<void> {
  await operarCicloDeVida(admin, shopifyDiscountId, "pausar", metodo);
}

export async function deleteOriginalPriceDiscount(
  admin: AdminClient,
  shopifyDiscountId: string,
  metodo: OriginalPriceMetodo = "CODE"
): Promise<void> {
  await operarCicloDeVida(admin, shopifyDiscountId, "eliminar", metodo);
}
