import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { handleToPlan } from "../lib/billing/plan-limits";
import { prisma } from "../lib/db";

// Shopify redirects here after a merchant approves a plan change.
// URL params: ?plan_handle=lite&shop=my-store.myshopify.com
// Configure this URL in Partner Dashboard as the "welcome link" for each plan.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const planHandle = url.searchParams.get("plan_handle") ?? "free";
  const newPlan = handleToPlan(planHandle);

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const now = new Date();

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      plan: newPlan,
      planActivatedAt: now,
      lastSyncAt: now,
    },
  });

  return redirect(`/app?planConfirmed=${newPlan}`);
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
