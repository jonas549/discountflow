import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { es } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Support() {
  return (
    <s-page heading={es.soporte.titulo}>
      <s-section heading={es.soporte.necesitasAyuda}>
        <s-paragraph>{es.soporte.descripcion}</s-paragraph>
        <s-button>{es.soporte.contactar}</s-button>
      </s-section>

      <s-section slot="aside" heading={es.soporte.recursos}>
        <s-unordered-list>
          <s-list-item>{es.soporte.guiaInicio}</s-list-item>
          <s-list-item>{es.soporte.tiposCampanas}</s-list-item>
          <s-list-item>{es.soporte.faq}</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
