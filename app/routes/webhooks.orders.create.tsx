import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { matchesTieredDiscountTitle } from "../lib/discounts/tiered-client";

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
  // que los automáticos nativos. Dos diferencias deliberadas con el bloque de
  // arriba, y ninguna toca a BXGY:
  //
  //   1. El cruce usa el TÍTULO REAL del descuento —"[DiscountFlow] <nombre>"—
  //      a través de matchesTieredDiscountTitle(), en vez del nombre pelado.
  //   2. El importe sale de las discount_allocations de cada línea, no de
  //      total_price / total_discounts, que atribuirían el pedido entero y
  //      todos los descuentos ajenos a esta campaña.

  const automaticApps = (order.discount_applications ?? [])
    // El índice se calcula ANTES de filtrar: discount_application_index apunta
    // a la posición en el array original.
    .map((da, index) => ({ ...da, index }))
    .filter((da) => da.type === "automatic" && da.title);

  if (automaticApps.length > 0) {
    const tieredCampaigns = await prisma.campaign.findMany({
      where: { shopId: shopRecord.id, status: "ACTIVE", type: "TIERED" },
    });

    if (tieredCampaigns.length > 0) {
      // TEMPORAL — verificación con el primer pedido real en producción.
      // Todavía no está confirmado si Shopify manda aquí el título del
      // descuento o el `message` de la Function. Este log lo resuelve de un
      // vistazo; quitar una vez validado.
      console.log(
        "[tiered-attribution] títulos recibidos:",
        JSON.stringify(automaticApps.map((d) => d.title)),
        "| campañas activas:",
        JSON.stringify(tieredCampaigns.map((c) => c.name))
      );

      for (const campaign of tieredCampaigns) {
        const app = automaticApps.find((da) =>
          matchesTieredDiscountTitle(da.title, campaign.name)
        );
        if (!app) continue;

        // Solo las líneas que recibieron una asignación de ESTE descuento.
        let orderAmountForCampaign = 0;
        let discountAmountForCampaign = 0;

        for (const lineItem of order.line_items) {
          const allocations = (lineItem.discount_allocations ?? []).filter(
            (a) => a.discount_application_index === app.index
          );
          if (allocations.length === 0) continue;

          orderAmountForCampaign += Number(lineItem.price) * lineItem.quantity;
          discountAmountForCampaign += allocations.reduce(
            (sum, a) => sum + Number(a.amount),
            0
          );
        }

        if (orderAmountForCampaign <= 0) continue;

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

  return new Response(null, { status: 200 });
};
