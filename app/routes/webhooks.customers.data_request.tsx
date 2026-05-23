import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: merchant requests customer data export.
// DiscountFlow stores NO personal customer data — only anonymous order amounts
// and variant IDs. Nothing to export, so we acknowledge and return 200.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[GDPR] ${topic} for ${shop} — no PII stored, acknowledged`);
  return new Response(null, { status: 200 });
};
