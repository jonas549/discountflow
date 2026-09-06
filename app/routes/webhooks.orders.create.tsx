import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import {
  tieredAppliesToProduct,
  tieredDiscountMessage,
  type TieredCampaignConfig,
} from "../lib/discounts/tiered-client";
import {
  PACK_LINE_ATTRIBUTE,
  packDiscountMessage,
  type PackCampaignConfig,
} from "../lib/discounts/pack-client";
import {
  atribuirPacks,
  leerPropiedadDeLinea,
  type LineaDePedido,
} from "../lib/discounts/pack-attribution";
import {
  atribuirPorSenal,
  senalPorTituloAutomatico,
  senalPorCodigo,
  senalesReclamadasMasDeUnaVez,
} from "../lib/discounts/order-attribution";
import { bxgyDiscountTitle } from "../lib/discounts/bxgy-client";
import {
  cartValueDiscountMessage,
  type CartValueCampaignConfig,
} from "../lib/discounts/cart-value-client";
import {
  originalPriceDiscountMessage,
  originalPriceUsaCodigo,
  normalizeDiscountCode,
  type OriginalPriceCampaignConfig,
} from "../lib/discounts/original-price-client";

// Campos del payload orders/create que necesitamos (sin PII de cliente).
// Level 1 Protected Customer Data — aprobado 2026-05.
interface OrderPayload {
  admin_graphql_api_id: string; // gid://shopify/Order/...
  total_price: string;
  total_discounts: string;
  currency: string;
  discount_applications?: Array<{
    type: string;    // "automatic" | "discount_code" | "manual" | "script"
    /**
     * Automáticos: el título. Para BXGY es el del OBJETO descuento
     * (`[DiscountFlow] X`); para las Functions, el `message` que emiten.
     */
    title?: string;
    /**
     * 🔴 El código del cupón. NO estaba declarado, y es el único campo que
     * identifica un cupón sobre precio original con método de código — el tipo
     * cuyo caso de uso ES medir a cada influencer por separado.
     */
    code?: string;
    value_type: string;
    value: string;
  }>;
  line_items: Array<{
    variant_id: number | null;
    product_id: number;
    quantity: number;
    price: string;
    /**
     * 🔴 En el payload REST del pedido esto es un ARRAY de `{name, value}`, NO
     * el objeto `{clave: valor}` que devuelve la Ajax Cart API del storefront.
     *
     * Es el mismo dato con dos formas distintas según por dónde se lea, y
     * confundirlas no da ningún error: da CERO atribuciones en silencio. Se lee
     * con `leerPropiedad`, que tolera las dos.
     */
    properties?:
      | Array<{ name: string; value: string }>
      | Record<string, string>
      | null;
    discount_allocations: Array<{
      amount: string;
      discount_application_index: number;
    }>;
  }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as OrderPayload;

  // En el contexto del webhook no tenemos sesión activa — buscamos el shop
  // por dominio. Si no existe todavía (edge case), retornamos 200 sin fallar.
  const shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
  if (!shopRecord) return new Response(null, { status: 200 });

  const orderId = order.admin_graphql_api_id;

  // ── 1. Campañas PERCENTAGE y RANGE ───────────────────────────────────────
  // Modifican precios directamente: no generan discount_applications.
  // Atribuimos cruzando variant_ids del pedido con CampaignProduct.

  const orderVariantGids = order.line_items
    .filter((li) => li.variant_id != null)
    .map((li) => `gid://shopify/ProductVariant/${li.variant_id}`);

  if (orderVariantGids.length > 0) {
    const priceModCampaigns = await prisma.campaign.findMany({
      where: {
        shopId: shopRecord.id,
        status: "ACTIVE",
        type: { in: ["PERCENTAGE", "RANGE"] },
        products: { some: { shopifyVariantId: { in: orderVariantGids } } },
      },
      include: {
        products: {
          where: { shopifyVariantId: { in: orderVariantGids } },
          select: { shopifyVariantId: true, originalPrice: true },
        },
      },
    });

    for (const campaign of priceModCampaigns) {
      let orderAmountForCampaign = 0;
      let discountAmountForCampaign = 0;

      for (const product of campaign.products) {
        const lineItem = order.line_items.find(
          (li) =>
            `gid://shopify/ProductVariant/${li.variant_id}` ===
            product.shopifyVariantId
        );
        if (!lineItem) continue;

        const currentPrice = Number(lineItem.price);
        const originalPrice = Number(product.originalPrice ?? currentPrice);
        const qty = lineItem.quantity;

        orderAmountForCampaign += currentPrice * qty;
        discountAmountForCampaign += Math.max(0, originalPrice - currentPrice) * qty;
      }

      if (orderAmountForCampaign > 0) {
        await prisma.orderAttribution.upsert({
          where: {
            campaignId_shopifyOrderId: {
              campaignId: campaign.id,
              shopifyOrderId: orderId,
            },
          },
          create: {
            campaignId: campaign.id,
            shopifyOrderId: orderId,
            orderAmount: orderAmountForCampaign,
            discountAmount: discountAmountForCampaign,
            currency: order.currency ?? "USD",
          },
          update: {},
        });
      }
    }
  }

  // ── 2. Campañas BXGY ─────────────────────────────────────────────────────
  //
  // 🔴 ARREGLADO EL 2026-09-06. Este bloque **nunca atribuyó un solo pedido**
  // en toda la vida de la app, y tenía dos fallos encadenados:
  //
  //   (a) EL CRUCE. Comparaba el título de la aplicación contra `campaign.name`.
  //       El descuento se crea como `[DiscountFlow] <nombre>` desde el commit
  //       que trajo BxGy, ocho commits ANTES de que se escribiera este bloque.
  //       Comparación exacta que no coincide nunca: cero filas, cero errores,
  //       cero atribuciones. Ahora las dos puntas usan `bxgyDiscountTitle`.
  //
  //   (b) EL IMPORTE. Usaba `total_price` y `total_discounts` — el pedido
  //       ENTERO. Estaba escondido detrás de (a): al arreglar el cruce, una
  //       campaña BXGY habría empezado a llevarse el ahorro de los OTROS
  //       descuentos del pedido y a contar como recaudación suya productos en
  //       los que no participó. Los dos se arreglan juntos o el arreglo miente.
  //
  // BXGY es un descuento NATIVO (`discountAutomaticBxgyCreate`), no una
  // Function: por eso su señal es el TÍTULO DEL OBJETO y no un `message`. Esa
  // distinción es la que faltaba.
  //
  // ⚠️ `orderAmount` sale de las líneas que el descuento TOCÓ, igual que en
  // escalonados. En un "compra 2 llevá 1 gratis" esas son las líneas del
  // regalo, así que la recaudación atribuida es conservadora. Es deliberado:
  // nunca puede atribuir de más. Ver la nota del handoff.

  const aplicaciones = order.discount_applications ?? [];
  const lineas = order.line_items as LineaDePedido[];

  /** Nunca reescribe una atribución existente: `update: {}` es intencional. */
  const guardarAtribucion = async (
    campaignId: string,
    orderAmount: number,
    discountAmount: number
  ) => {
    await prisma.orderAttribution.upsert({
      where: { campaignId_shopifyOrderId: { campaignId, shopifyOrderId: orderId } },
      create: {
        campaignId,
        shopifyOrderId: orderId,
        orderAmount,
        discountAmount,
        currency: order.currency ?? "USD",
      },
      update: {},
    });
  };

  /** Se llena solo cuando un tipo tenía campañas y no pudo atribuir. */
  const fallos: Array<Record<string, unknown>> = [];

  if (aplicaciones.length > 0) {
    const bxgyCampaigns = await prisma.campaign.findMany({
      where: { shopId: shopRecord.id, status: "ACTIVE", type: "BXGY" },
      select: { id: true, name: true },
    });

    if (bxgyCampaigns.length > 0) {
      const resultado = atribuirPorSenal(
        lineas,
        aplicaciones,
        bxgyCampaigns.map((c) => ({ id: c.id, senal: bxgyDiscountTitle(c.name) })),
        senalPorTituloAutomatico
      );

      for (const a of resultado.atribuciones) {
        await guardarAtribucion(a.campaignId, a.orderAmount, a.discountAmount);
      }

      if (resultado.atribuciones.length === 0) {
        fallos.push({
          tipo: "BXGY",
          campanas: bxgyCampaigns.length,
          ambiguas: resultado.ambiguas,
          sinReconocer: resultado.sinReconocer,
        });
      }
    }
  }

  // ── 3. Campañas TIERED (descuentos escalonados) ──────────────────────────
  // Los descuentos de Shopify Functions llegan en discount_applications igual
  // que los automáticos nativos, pero NO se pueden identificar por título.
  // Verificado con un pedido real (2026-07-25): Shopify publica ahí el
  // `message` de la Function ("Descuento por cantidad"), que es idéntico en
  // todas las campañas escalonadas. Tres consecuencias, ninguna toca a BXGY:
  //
  //   1. Quien ASIGNA la campaña es el cruce por PRODUCTOS
  //      (tieredAppliesToProduct). El título solo DESCARTA los descuentos
  //      automáticos ajenos —del merchant u otras apps—, nunca elige.
  //   2. La Function emite un candidate POR LÍNEA, así que un mismo pedido
  //      trae VARIAS applications de la misma campaña: hay que sumarlas todas.
  //      Contar solo la primera daba el importe a una fracción del real.
  //   3. Si dos campañas activas pueden explicar el mismo descuento, no se
  //      atribuye a ninguna y queda registrado en el log.
  //
  // El importe sale de las discount_allocations de cada línea, no de
  // total_price / total_discounts, que atribuirían el pedido entero.

  const applications = order.discount_applications ?? [];

  if (applications.length > 0) {
    const tieredCampaigns = await prisma.campaign.findMany({
      where: { shopId: shopRecord.id, status: "ACTIVE", type: "TIERED" },
    });

    if (tieredCampaigns.length > 0) {
      const configOf = (c: { config: unknown }) =>
        c.config as TieredCampaignConfig;

      // Acumulado por campaña. `lines` evita sumar dos veces el importe de una
      // línea que recibiera más de una asignación de la MISMA campaña.
      const totals = new Map<
        string,
        { orderAmount: number; discountAmount: number; lines: Set<number> }
      >();
      const ambiguas: Array<{ producto: number; entre: string[] }> = [];

      for (const [lineIndex, lineItem] of order.line_items.entries()) {
        if (lineItem.product_id == null) continue;
        // El webhook manda el id numérico; el config guarda GIDs.
        const productGid = `gid://shopify/Product/${lineItem.product_id}`;

        for (const allocation of lineItem.discount_allocations ?? []) {
          // El índice apunta a la posición en el array ORIGINAL de
          // discount_applications, sin filtrar.
          const app = applications[allocation.discount_application_index];
          if (!app || app.type !== "automatic") continue;

          // (a) Descarte por título: deja fuera los descuentos automáticos
          //     ajenos (del merchant u otras apps). NO elige campaña — el
          //     título es idéntico en todas las escalonadas.
          const propias = tieredCampaigns.filter(
            (c) => app.title === tieredDiscountMessage(configOf(c))
          );
          if (propias.length === 0) continue;

          // (b) Asignación real: por productos.
          const candidatas = propias.filter((c) =>
            tieredAppliesToProduct(configOf(c), productGid)
          );
          if (candidatas.length === 0) continue;
          if (candidatas.length > 1) {
            // Sin certeza no se atribuye: mejor un hueco visible en Analytics
            // que dinero asignado a la campaña equivocada.
            ambiguas.push({
              producto: lineItem.product_id,
              entre: candidatas.map((c) => c.name),
            });
            continue;
          }

          const campaign = candidatas[0];
          const acc = totals.get(campaign.id) ?? {
            orderAmount: 0,
            discountAmount: 0,
            lines: new Set<number>(),
          };
          if (!acc.lines.has(lineIndex)) {
            acc.lines.add(lineIndex);
            acc.orderAmount += Number(lineItem.price) * lineItem.quantity;
          }
          acc.discountAmount += Number(allocation.amount);
          totals.set(campaign.id, acc);
        }
      }

      // El log temporal [tiered-attribution] vivía aquí desde el 2026-07-25 y
      // se quitó el 2026-09-06: cumplió su función —validar la atribución de
      // escalonados con un pedido real— y llevaba mes y medio escribiendo en
      // producción en CADA pedido de las 6 tiendas. `ambiguas` se conserva
      // porque es lo que hace que una ambigüedad no se atribuya.

      for (const [campaignId, acc] of totals) {
        if (acc.orderAmount <= 0) continue;

        await prisma.orderAttribution.upsert({
          where: {
            campaignId_shopifyOrderId: {
              campaignId,
              shopifyOrderId: orderId,
            },
          },
          create: {
            campaignId,
            shopifyOrderId: orderId,
            orderAmount: acc.orderAmount,
            discountAmount: acc.discountAmount,
            currency: order.currency ?? "USD",
          },
          update: {},
        });
      }
    }
  }

  // ── 4. Campañas PACK (packs armables) ────────────────────────────────────
  //
  // La decisión vive en `pack-attribution.ts`, módulo PURO y con tests.
  //
  // 🔴 Por qué está extraído: este código **no se puede ejercitar en dev**. El
  // webhook `orders/create` está sin suscribir en la app Dev por falta de
  // Protected Customer Data (comentado en `shopify.app.dev.toml` desde el
  // 2026-07-24), así que en dev el pedido se completa, el descuento se aplica y
  // el webhook nunca llega. La primera vez que esto corre de verdad es en
  // producción, sobre el pedido de un cliente. Ese es justo el código que no
  // puede vivir sin tests dentro de una ruta.

  const lineasDePack = (order.line_items as LineaDePedido[]).filter(
    (li) => leerPropiedadDeLinea(li.properties, PACK_LINE_ATTRIBUTE) !== null
  );

  if (lineasDePack.length > 0) {
    const idsDeCampana = [
      ...new Set(
        lineasDePack
          .map((li) => leerPropiedadDeLinea(li.properties, PACK_LINE_ATTRIBUTE)!)
      ),
    ];

    // Sin filtrar por estado: el pedido ocurrió cuando la campaña estaba activa,
    // y pausarla después no debe borrar su historial de ventas.
    const packCampaigns = await prisma.campaign.findMany({
      where: { shopId: shopRecord.id, type: "PACK", id: { in: idsDeCampana } },
    });

    const resultado = atribuirPacks(
      order.line_items as LineaDePedido[],
      applications,
      packCampaigns.map((c) => ({
        id: c.id,
        name: c.name,
        message: packDiscountMessage(c.config as PackCampaignConfig),
      })),
      PACK_LINE_ATTRIBUTE
    );

    console.log(
      "[pack-attribution]",
      JSON.stringify({
        lineasConMarca: resultado.lineasConMarca,
        lineasHuerfanas: resultado.lineasHuerfanas,
        // 🔴 Si esto viene lleno y el importe sale 0, la suposición de que
        // Shopify publica el `message` de la Function como `title` es falsa
        // para PACK, y acá está el valor real para corregirlo.
        titulosNoReconocidos: resultado.titulosNoReconocidos,
        atribuido: resultado.atribuciones.map((a) => ({
          campana: packCampaigns.find((c) => c.id === a.campaignId)?.name,
          lineas: a.lineas,
          orderAmount: a.orderAmount,
          discountAmount: a.discountAmount,
        })),
      })
    );

    for (const a of resultado.atribuciones) {
      await prisma.orderAttribution.upsert({
        where: {
          campaignId_shopifyOrderId: {
            campaignId: a.campaignId,
            shopifyOrderId: orderId,
          },
        },
        create: {
          campaignId: a.campaignId,
          shopifyOrderId: orderId,
          orderAmount: a.orderAmount,
          discountAmount: a.discountAmount,
          currency: order.currency ?? "USD",
        },
        update: {},
      });
    }
  }

  // ── 5 y 6. Campañas CUPÓN SOBRE PRECIO ORIGINAL y MONTO DE COMPRA ────────
  //
  // 🔴 Ninguno de los dos tenía bloque. No estaban rotos: no existían. Los tres
  // tipos nuevos se desplegaron el 2026-09-06 y, hasta este commit, un merchant
  // podía crear campañas de cupón o de monto y ver "0 pedidos · ROI N/A" para
  // siempre. En el cupón era lo más grave, porque su caso de uso ES medir.
  //
  // Las dos van por Function, así que se reconocen por el `message` que emiten
  // —igual que escalonados y packs, y NO como BXGY—, salvo el cupón con código,
  // que se reconoce por el código: exacto, único en la tienda, sin ambigüedad
  // posible. Es el camino más fiable de los seis tipos.

  if (aplicaciones.length > 0) {
    const conMensaje = await prisma.campaign.findMany({
      where: {
        shopId: shopRecord.id,
        status: "ACTIVE",
        type: { in: ["TIERED", "PACK", "CART_VALUE", "CODE_ORIGINAL_PRICE"] },
      },
      select: { id: true, type: true, config: true },
    });

    const cuponConfig = (c: { config: unknown }) =>
      c.config as OriginalPriceCampaignConfig;

    const cupones = conMensaje.filter((c) => c.type === "CODE_ORIGINAL_PRICE");
    const cuponesConCodigo = cupones.filter((c) =>
      originalPriceUsaCodigo(cuponConfig(c))
    );
    const cuponesAutomaticos = cupones.filter(
      (c) => !originalPriceUsaCodigo(cuponConfig(c))
    );
    const montos = conMensaje.filter((c) => c.type === "CART_VALUE");

    // 🔴 La salvaguarda contra atribuir de más. El `message` lo escribe el
    // merchant, y nada le impide poner el mismo texto en una campaña de monto y
    // en un cupón automático: una sola aplicación encajaría en los dos bloques
    // y el mismo ahorro se contaría dos veces. Con esto, esa señal no se
    // atribuye a ninguno. Los mensajes de escalonado y pack entran en el
    // recuento, pero el efecto es de una sola dirección: quien se aparta es
    // siempre el bloque nuevo. Los que ya atribuyen hoy no leen esto.
    const senalesAjenas = senalesReclamadasMasDeUnaVez([
      conMensaje
        .filter((c) => c.type === "TIERED")
        .map((c) => tieredDiscountMessage(c.config as TieredCampaignConfig)),
      conMensaje
        .filter((c) => c.type === "PACK")
        .map((c) => packDiscountMessage(c.config as PackCampaignConfig)),
      montos.map((c) =>
        cartValueDiscountMessage(c.config as CartValueCampaignConfig)
      ),
      cuponesAutomaticos.map((c) =>
        originalPriceDiscountMessage(cuponConfig(c))
      ),
    ]);

    // 5.a · Cupón con CÓDIGO. Sin `senalesAjenas`: el código es único en la
    // tienda por obligación de Shopify, así que no puede chocar con nada.
    if (cuponesConCodigo.length > 0) {
      const resultado = atribuirPorSenal(
        lineas,
        aplicaciones,
        cuponesConCodigo.map((c) => ({
          id: c.id,
          senal: normalizeDiscountCode(cuponConfig(c).code ?? ""),
        })),
        senalPorCodigo
      );

      for (const a of resultado.atribuciones) {
        await guardarAtribucion(a.campaignId, a.orderAmount, a.discountAmount);
      }

      if (resultado.atribuciones.length === 0) {
        fallos.push({
          tipo: "CODE_ORIGINAL_PRICE/codigo",
          campanas: cuponesConCodigo.length,
          ambiguas: resultado.ambiguas,
        });
      }
    }

    // 5.b · Cupón AUTOMÁTICO. Sin código que cruzar: se reconoce por el mensaje.
    if (cuponesAutomaticos.length > 0) {
      const resultado = atribuirPorSenal(
        lineas,
        aplicaciones,
        cuponesAutomaticos.map((c) => ({
          id: c.id,
          senal: originalPriceDiscountMessage(cuponConfig(c)),
        })),
        senalPorTituloAutomatico,
        senalesAjenas
      );

      for (const a of resultado.atribuciones) {
        await guardarAtribucion(a.campaignId, a.orderAmount, a.discountAmount);
      }

      if (resultado.atribuciones.length === 0) {
        fallos.push({
          tipo: "CODE_ORIGINAL_PRICE/automatico",
          campanas: cuponesAutomaticos.length,
          ambiguas: resultado.ambiguas,
        });
      }
    }

    // 6 · Monto de compra. Es un descuento de ORDEN: Shopify reparte su importe
    // en las `discount_allocations` de las líneas, así que la suma sale de ahí
    // igual que en los demás.
    //
    // 🔴 Decisión de Jonas: dos campañas de monto activas con el mismo mensaje
    // son indistinguibles → NO SE ATRIBUYE A NINGUNA. Es la misma regla que ya
    // aplicaba escalonados con sus casos ambiguos. Mejor un cero honesto que un
    // número inventado.
    if (montos.length > 0) {
      const resultado = atribuirPorSenal(
        lineas,
        aplicaciones,
        montos.map((c) => ({
          id: c.id,
          senal: cartValueDiscountMessage(c.config as CartValueCampaignConfig),
        })),
        senalPorTituloAutomatico,
        senalesAjenas
      );

      for (const a of resultado.atribuciones) {
        await guardarAtribucion(a.campaignId, a.orderAmount, a.discountAmount);
      }

      if (resultado.atribuciones.length === 0) {
        fallos.push({
          tipo: "CART_VALUE",
          campanas: montos.length,
          ambiguas: resultado.ambiguas,
        });
      }
    }
  }

  // Diagnóstico que habla SOLO cuando algo no cruzó. No es el log temporal que
  // se acaba de quitar: aquel escribía en cada pedido de cada tienda. Este
  // guarda silencio en el caso normal —incluido el pedido sin descuentos— y
  // solo aparece cuando un tipo tenía campañas activas y no pudo atribuir, que
  // es exactamente cuando alguien va a preguntar por qué el dashboard dice 0.
  if (fallos.length > 0) {
    console.warn(
      "[attribution-miss]",
      JSON.stringify({
        pedido: orderId,
        titulos: aplicaciones.map((a) => ({
          type: a.type,
          title: a.title ?? null,
          code: a.code ?? null,
        })),
        fallos,
      })
    );
  }

  return new Response(null, { status: 200 });
};
