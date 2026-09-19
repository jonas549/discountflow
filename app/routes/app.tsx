import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getOrCreateShop, syncShopPlanIfStale } from "../lib/shopify/shop.server";
import { prisma } from "../lib/db";
import { JobProgress } from "../components/JobProgress";
import { SupportChat } from "../components/SupportChat";
import { es } from "../i18n";

// 🔴 EL CHAT CARGA SIEMPRE, EN TODAS LAS TIENDAS. Decisión de Jonas, 2026-09-19.
//
// Antes estuvo detrás del flag `chat:tawk` y de una guardia de entorno. Las dos
// se quitaron a propósito: el chat tiene que estar para todos los merchants,
// incluidos los que instalen la app de ahora en adelante, sin que nadie tenga
// que encender nada por tienda.
//
// ⚠️ LO QUE ESO CUESTA, para que quede escrito: ya NO hay apagado inmediato. Si
// el widget molesta —tapa un botón, el script de Tawk falla, alguien se queja—,
// la vuelta atrás es `git revert` + push y esperar el build (~4 min), no un
// UPDATE de segundos. Por eso las tres defensas del propio componente
// (try/catch, `return null`, y el id en un solo sitio) dejan de ser prolijidad y
// pasan a ser lo único que evita que un fallo del chat tumbe la app entera de
// los tres clientes que pagan. No aflojarlas.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  // Lazy plan sync — at most one GraphQL call per 15 min per shop.
  // No se devuelve el plan al cliente a propósito: la navegación no lo muestra
  // (ver la nota en <s-app-nav>). El sondeo sigue aquí porque es lo que mantiene
  // `Shop.plan` al día en cada carga de la app.
  await syncShopPlanIfStale(admin, shop);

  // Operación en curso, si la hay: la franja del shell permite seguir el
  // progreso mientras el merchant navega por el resto de la app.
  const enCurso = await prisma.campaign.findFirst({
    where: { shopId: shop.id, activeJobId: { not: null } },
    select: { activeJobId: true },
    orderBy: { updatedAt: "desc" },
  });

  // Datos para el panel del chat. Van siempre: el chat ya no depende de nada.
  //
  // ⚠️ El plan viaja al cliente SOLO para el panel de Tawk, nunca para pintarlo:
  // la nota de <s-app-nav> sigue en pie y el distintivo no vuelve. Aquí el
  // desfase es tolerable (el sondeo lo refresca cada 15 min como mucho) porque
  // nadie toma una decisión de dinero con este dato.
  const chatSoporte = { shopDomain: shop.domain, plan: shop.plan };

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    runningJobId: enCurso?.activeJobId ?? null,
    chatSoporte,
  };
};

export default function App() {
  const { apiKey, runningJobId, chatSoporte } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">{es.nav.inicio}</s-link>
        <s-link href="/app/campaigns">{es.nav.campanas}</s-link>
        <s-link href="/app/analytics">{es.nav.analiticas}</s-link>
        {/* 🔴 Sin distintivo de plan, y no es pereza: tenía DOS defectos.
            1. Nunca se vio como un distintivo. `<s-app-nav>` lo renderiza el
               admin de Shopify FUERA del iframe, tomando el texto del enlace: el
               <span> con estilos se aplanaba y salía "PlanesESSENTIAL", pegado.
            2. No se podía mantener al día. Este es el layout padre, y una
               navegación de cliente a una ruta hija NO vuelve a ejecutar su
               loader, así que el plan se quedaba con el valor de la última carga
               completa. Tras bajar a Gratis, el menú seguía diciendo ESSENTIAL.
            Además duplicaba la fuente de verdad del plan justo en lo que revisa
            Shopify (requisito 1.2.2: la interfaz debe reflejar la suscripción
            activa). El plan se muestra en /app/plans, que fuerza el sondeo y
            siempre está fresco. No volver a añadirlo aquí. */}
        <s-link href="/app/plans">{es.nav.planes}</s-link>
        <s-link href="/app/support">{es.nav.soporte}</s-link>
      </s-app-nav>
      {runningJobId && <JobProgress jobId={runningJobId} compact />}
      <SupportChat shopDomain={chatSoporte.shopDomain} plan={chatSoporte.plan} />
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
