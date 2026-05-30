import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";

// When a merchant uninstalls the app:
// 1. Delete OAuth sessions (they're invalid now)
// 2. Pause all active campaigns (prices revert via each campaign's revert logic is NOT called
//    here — the merchant uninstalled, so Shopify prices won't be accessible anyway)
// 3. Keep all Shop/Campaign data — merchant may reinstall within 48h.
// Actual deletion happens via shop/redact webhook ~48h later.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  // Delete sessions — they're invalid after uninstall
  await prisma.session.deleteMany({ where: { shop } });

  // Pause all active campaigns so they don't appear active on reinstall
  const shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
  if (shopRecord) {
    await prisma.campaign.updateMany({
      where: { shopId: shopRecord.id, status: "ACTIVE" },
      data: { status: "PAUSED" },
    });
    await prisma.shop.update({
      where: { id: shopRecord.id },
      data: { plan: "FREE", lastSyncAt: null },
    });
  }

  return new Response(null, { status: 200 });
};
