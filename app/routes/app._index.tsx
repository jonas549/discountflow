import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Dashboard() {
  return (
    <s-page heading="Dashboard">
      <s-section heading="Welcome to DiscountFlow">
        <s-paragraph>
          Manage your discount campaigns from here. Use the navigation to create
          and monitor campaigns.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Quick Stats">
        <s-paragraph>Active campaigns: —</s-paragraph>
        <s-paragraph>Products on discount: —</s-paragraph>
        <s-paragraph>Revenue attributed: —</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
