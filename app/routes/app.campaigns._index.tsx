import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Campaigns() {
  return (
    <s-page heading="Campaigns">
      <s-section heading="Create a campaign">
        <s-paragraph>
          Choose a campaign type to get started.
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <s-button variant="primary" disabled>
            Percentage Discount
          </s-button>
          <s-button variant="primary" disabled>
            Price Range
          </s-button>
          <s-button variant="primary" disabled>
            Buy X Get Y
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Your campaigns">
        <s-paragraph>No campaigns yet. Create your first one above.</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
