import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Support() {
  return (
    <s-page heading="Support">
      <s-section heading="Need help?">
        <s-paragraph>
          Contact our support team or browse our documentation to get started
          with DiscountFlow.
        </s-paragraph>
        <s-button>Contact support</s-button>
      </s-section>

      <s-section slot="aside" heading="Resources">
        <s-unordered-list>
          <s-list-item>Getting started guide</s-list-item>
          <s-list-item>Campaign types explained</s-list-item>
          <s-list-item>FAQ</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
