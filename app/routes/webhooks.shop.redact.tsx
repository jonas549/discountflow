import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";

// GDPR: 48 hours after uninstall, Shopify requests full shop data deletion.
// We cascade-delete: Shop → Campaigns → CampaignProducts, OrderAttributions, AnalyticsEvents.
// Sessions are deleted independently (by domain) since they reference shop domain, not Shop.id.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[GDPR] ${topic} for ${shop} — deleting all shop data`);

  try {
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { shop } }),
      // Shop.campaigns cascade-deletes CampaignProducts, OrderAttributions, AnalyticsEvents
      prisma.shop.deleteMany({ where: { domain: shop } }),
    ]);
    console.log(`[GDPR] shop/redact complete for ${shop}`);
  } catch (err) {
    console.error(`[GDPR] shop/redact failed for ${shop}:`, err);
    // Return 200 anyway — Shopify will retry if we return 5xx, but the shop may already be gone.
    // Returning 200 prevents infinite retry loops for edge cases like already-deleted shops.
  }

  return new Response(null, { status: 200 });
};
