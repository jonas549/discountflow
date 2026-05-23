import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getOrCreateShop, syncShopPlanIfStale } from "../lib/shopify/shop.server";
import { es } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  // Lazy plan sync — at most one GraphQL call per 15 min per shop
  const syncedShop = await syncShopPlanIfStale(admin, shop);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    currentPlan: syncedShop.plan as string,
  };
};

export default function App() {
  const { apiKey, currentPlan } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">{es.nav.inicio}</s-link>
        <s-link href="/app/campaigns">{es.nav.campanas}</s-link>
        <s-link href="/app/analytics">{es.nav.analiticas}</s-link>
        <s-link href="/app/plans">
          {es.nav.planes}
          {currentPlan !== "FREE" && (
            <span
              style={{
                marginLeft: "6px",
                fontSize: "10px",
                fontWeight: "600",
                background: "#008060",
                color: "#fff",
                borderRadius: "10px",
                padding: "1px 6px",
                verticalAlign: "middle",
              }}
            >
              {currentPlan}
            </span>
          )}
        </s-link>
        <s-link href="/app/support">{es.nav.soporte}</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
