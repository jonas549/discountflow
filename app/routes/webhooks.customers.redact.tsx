import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: merchant requests deletion of customer data.
// DiscountFlow stores NO personal customer data (no names, emails, or addresses).
// OrderAttribution only records order amounts + variant IDs — not PII.
// Nothing to delete, so we acknowledge and return 200.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[GDPR] ${topic} for ${shop} — no PII stored, acknowledged`);
  return new Response(null, { status: 200 });
};
