import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { es } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Analytics() {
  return (
    <s-page heading={es.analytics.titulo}>
      <s-section heading={es.analytics.subtitulo}>
        <div style={{ textAlign: "center", padding: "48px 0" }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>📊</div>
          <p
            style={{
              color: "#6d7175",
              fontSize: "14px",
              maxWidth: "400px",
              margin: "0 auto",
              lineHeight: "1.6",
            }}
          >
            {es.analytics.proximamente}
          </p>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
