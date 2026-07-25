import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import {
  tieredAppliesToProduct,
  tieredDiscountMessage,
  type TieredCampaignConfig,
} from "../lib/discounts/tiered-client";

// Campos del payload orders/create que necesitamos (sin PII de cliente).
// Level 1 Protected Customer Data — aprobado 2026-05.
interface OrderPayload {
  admin_graphql_api_id: string; // gid://shopify/Order/...
  total_price: string;
  total_discounts: string;
  currency: string;
  discount_applications?: Array<{
    type: string;    // "automatic" | "code" | "manual" | "script"
    title?: string;  // título del descuento automático (BXGY)
    value_type: string;
    value: string;
  }>;
  line_items: Array<{
    variant_id: number | null;
    product_id: number;
    quantity: number;
    price: string;
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
  // Shopify registra descuentos automáticos en discount_applications con
  // type="automatic". El título coincide con el nombre de la campaña BXGY
  // (que es el título con el que lo creamos en Shopify vía discountAutomaticBxgyCreate).

  const automaticTitles = (order.discount_applications ?? [])
    .filter((da) => da.type === "automatic" && da.title)
    .map((da) => da.title as string);

  if (automaticTitles.length > 0) {
    const bxgyCampaigns = await prisma.campaign.findMany({
      where: {
        shopId: shopRecord.id,
        status: "ACTIVE",
        type: "BXGY",
        name: { in: automaticTitles },
      },
    });

    for (const campaign of bxgyCampaigns) {
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
          orderAmount: Number(order.total_price),
          discountAmount: Number(order.total_discounts),
          currency: order.currency ?? "USD",
        },
        update: {},
      });
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

      // TEMPORAL [tiered-attribution] — quitar tras validar con un pedido real.
      console.log(
        "[tiered-attribution]",
        JSON.stringify({
          titulosAutomaticos: applications
            .filter((a) => a.type === "automatic")
            .map((a) => a.title),
          campanasActivas: tieredCampaigns.map((c) => c.name),
          atribuido: [...totals.entries()].map(([id, acc]) => ({
            campana: tieredCampaigns.find((c) => c.id === id)?.name,
            lineas: acc.lines.size,
            orderAmount: acc.orderAmount,
            discountAmount: acc.discountAmount,
          })),
          ambiguasSinAtribuir: ambiguas,
        })
      );

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

  return new Response(null, { status: 200 });
};
