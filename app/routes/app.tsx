import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getOrCreateShop, syncShopPlanIfStale } from "../lib/shopify/shop.server";
import { prisma } from "../lib/db";
import { JobProgress } from "../components/JobProgress";
import { SupportChat } from "../components/SupportChat";
import { hasFeature } from "../lib/features.server";
import { es } from "../i18n";

// 🔴 EL FLAG `chat:tawk` ES AHORA EL ÚNICO CONTROL DEL CHAT, Y ES A PROPÓSITO.
//
// Durante la prueba hubo además una guardia de entorno que impedía montarlo en
// producción. Se quitó el 2026-09-19, con el OK de Jonas, porque el chat va para
// todas las tiendas. Lo que queda es lo que importa: `hasFeature` FALLA CERRADO
// (ausencia, JSON corrupto o error de lectura = sin chat) y el flag vive en la
// base, así que se apaga con un UPDATE, en segundos y SIN desplegar.
//
// ⚠️ No reemplazar esto por una variable de entorno: las env vars de Vercel no
// surten efecto hasta un deployment nuevo, y entonces el apagado de emergencia
// dejaría de ser inmediato. Es la lección de `PLAN_SYNC_OBSERVACION`.

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

  // Chat de soporte: solo con el flag encendido en esta tienda. `hasFeature`
  // falla cerrado, así que cualquier duda = sin chat.
  //
  // ⚠️ El plan viaja al cliente SOLO para el panel de Tawk, nunca para pintarlo:
  // la nota de <s-app-nav> sigue en pie y el distintivo no vuelve. Aquí el
  // desfase es tolerable (el sondeo lo refresca cada 15 min como mucho) porque
  // nadie toma una decisión de dinero con este dato.
  const chatSoporte = hasFeature(shop, "chat:tawk")
    ? { shopDomain: shop.domain, plan: shop.plan }
    : null;

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
      {chatSoporte && (
        <SupportChat shopDomain={chatSoporte.shopDomain} plan={chatSoporte.plan} />
      )}
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
