import { prisma } from "../db";
import {
  decidirPlan,
  evaluarLectura,
  type LecturaPlan,
  type SubLeida,
} from "../billing/plan-decision.ts";

type AdminClient = { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> };

/**
 * Espera entre la primera y la segunda lectura (condición 4). Solo se paga en el
 * camino de degradación, que es raro: una tienda con plan activo nunca llega aquí.
 */
const SEGUNDA_LECTURA_MS = 2_000;

/** Cuántas suscripciones del historial se leen de una vez. Ver `historialCompleto`. */
const HISTORIAL_MAX = 50;

/**
 * Modo observación: registra qué haría, sin degradar a nadie. Se enciende con
 * `PLAN_SYNC_OBSERVACION=1` en las variables de entorno. Sirve para vigilar unos
 * días a las tiendas que pagan antes de dejar que el cambio actúe de verdad.
 */
const enObservacion = () => process.env.PLAN_SYNC_OBSERVACION === "1";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getOrCreateShop({
  domain,
  accessToken,
  scopes,
}: {
  domain: string;
  accessToken: string;
  scopes?: string | null;
}) {
  return prisma.shop.upsert({
    where: { domain },
    create: { domain, accessToken, scopes: scopes ?? "" },
    update: { accessToken, scopes: scopes ?? undefined, updatedAt: new Date() },
  });
}

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 min

/** Query Shopify for the current app subscription + currency and update DB if stale. */
export async function syncShopPlanIfStale(
  admin: AdminClient,
  shop: { id: string; lastSyncAt: Date | null; plan: string }
) {
  const now = new Date();
  console.log(
    `[plan-sync] enter shop=${shop.id} plan=${shop.plan} lastSyncAt=${
      shop.lastSyncAt ? shop.lastSyncAt.toISOString() : "null"
    }`
  );
  if (
    shop.lastSyncAt &&
    now.getTime() - shop.lastSyncAt.getTime() < SYNC_INTERVAL_MS
  ) {
    console.log(
      `[plan-sync] skip (fresh, <15min) shop=${shop.id} plan=${shop.plan}`
    );
    return shop;
  }

  try {
    const primera = await leerSuscripciones(admin);

    // Condición 1 — si no se pudo preguntar, no se toca NADA: ni el plan ni
    // `lastSyncAt`, para que la siguiente carga vuelva a intentarlo.
    if (!primera.lectura.valida) {
      console.warn(
        `[plan-sync] lectura inválida shop=${shop.id} (${primera.lectura.motivo}) — plan=${shop.plan} intacto, lastSyncAt sin tocar`
      );
      return shop;
    }

    console.log(
      `[plan-sync] api shop=${shop.id} activas=${JSON.stringify(
        primera.lectura.activas
      )} historial=${JSON.stringify(primera.lectura.todas)} completo=${
        primera.lectura.historialCompleto
      } currency=${primera.currency}`
    );

    // Condición 4 — la segunda lectura solo se pide cuando la primera apunta a
    // degradar. Una tienda con suscripción viva no paga este coste nunca.
    let segunda: LecturaPlan | undefined;
    if (evaluarLectura(primera.lectura).accion === "degradar-si-se-confirma") {
      await esperar(SEGUNDA_LECTURA_MS);
      const relectura = await leerSuscripciones(admin);
      segunda = relectura.lectura;
      console.log(
        `[plan-sync] segunda lectura shop=${shop.id} valida=${segunda.valida} ${
          segunda.valida
            ? `activas=${JSON.stringify(segunda.activas)} historial=${JSON.stringify(segunda.todas)}`
            : segunda.motivo
        }`
      );
    }

    const decision = decidirPlan({
      planActual: shop.plan,
      primera: primera.lectura,
      segunda,
    });

    let planAEscribir = decision.plan;

    // Modo observación: se registra la degradación pero no se aplica.
    if (decision.degradado && enObservacion()) {
      console.warn(
        `[plan-sync] OBSERVACIÓN shop=${shop.id} — DEGRADARÍA ${shop.plan} → FREE (${decision.motivo}). No se aplica.`
      );
      planAEscribir = shop.plan;
    } else if (decision.degradado) {
      console.warn(
        `[plan-sync] DEGRADA shop=${shop.id} ${shop.plan} → FREE (${decision.motivo})`
      );
    } else {
      console.log(
        `[plan-sync] resuelto shop=${shop.id} plan=${planAEscribir} (${decision.motivo})`
      );
    }

    return prisma.shop.update({
      where: { id: shop.id },
      data: {
        plan: planAEscribir,
        ...(primera.currency ? { currency: primera.currency } : {}),
        lastSyncAt: now,
        ...(planAEscribir !== shop.plan ? { planActivatedAt: now } : {}),
      },
    });
  } catch (err) {
    // Error de red o tropiezo de la API — no se rompe la app ni se toca el plan.
    console.error(`[plan-sync] THREW shop=${shop.id} (lastSyncAt stays unchanged):`, err);
    return shop;
  }
}

/**
 * Una consulta a Shopify, normalizada a `LecturaPlan`.
 *
 * 🔴 Aquí vive la condición 1. El código anterior hacía
 * `json.data?.currentAppInstallation?.activeSubscriptions ?? []`, que convertía en
 * «lista vacía» tanto una respuesta legítima sin suscripciones como un fallo HTTP,
 * un `currentAppInstallation` nulo o un cuerpo sin `data`. Mientras nadie degradaba
 * daba igual; ahora esa confusión bajaría a FREE a quien paga. Cada fallo se
 * devuelve como `valida: false` con su motivo, nunca como ausencia de suscripción.
 */
async function leerSuscripciones(
  admin: AdminClient
): Promise<{ lectura: LecturaPlan; currency: string | null }> {
  const res = await admin.graphql(`#graphql
    query {
      currentAppInstallation {
        activeSubscriptions {
          name
          status
          lineItems {
            plan { pricingDetails { __typename ... on AppRecurringPricing { planHandle } } }
          }
        }
        allSubscriptions(first: ${HISTORIAL_MAX}, sortKey: CREATED_AT, reverse: true) {
          nodes {
            name
            status
            lineItems {
              plan { pricingDetails { __typename ... on AppRecurringPricing { planHandle } } }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      shop { currencyCode }
    }
  `);

  if (!res.ok)
    return { lectura: { valida: false, motivo: `HTTP ${res.status}` }, currency: null };

  const json = (await res.json()) as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: SubCruda[];
        allSubscriptions?: { nodes?: SubCruda[]; pageInfo?: { hasNextPage?: boolean } };
      } | null;
      shop?: { currencyCode?: string };
    };
    errors?: unknown;
  };

  const errores = json.errors;
  if (errores && (!Array.isArray(errores) || errores.length > 0))
    return {
      lectura: { valida: false, motivo: `GraphQL errors: ${JSON.stringify(errores)}` },
      currency: null,
    };

  // La comprobación que faltaba: el campo tiene que ESTAR, no basta con que la
  // respuesta llegue. Un `currentAppInstallation` nulo es un fallo, no un cero.
  const inst = json.data?.currentAppInstallation;
  if (!inst || typeof inst !== "object")
    return {
      lectura: { valida: false, motivo: "currentAppInstallation ausente o nulo" },
      currency: null,
    };

  const activas = inst.activeSubscriptions;
  const historial = inst.allSubscriptions;
  if (!Array.isArray(activas) || !Array.isArray(historial?.nodes))
    return {
      lectura: { valida: false, motivo: "activeSubscriptions/allSubscriptions con forma inesperada" },
      currency: null,
    };

  return {
    lectura: {
      valida: true,
      activas: activas.map(normalizar),
      todas: historial.nodes.map(normalizar),
      historialCompleto: historial.pageInfo?.hasNextPage !== true,
    },
    currency: json.data?.shop?.currencyCode ?? null,
  };
}

type SubCruda = {
  name?: string;
  status?: string;
  lineItems?: Array<{
    plan?: { pricingDetails?: { __typename?: string; planHandle?: string | null } };
  }>;
};

/**
 * `name` NO se usa para decidir: viene traducido al idioma de la tienda
 * («Standaard», «Avancé»), y matear por ahí fue el bug de junio. El identificador
 * estable es `planHandle`.
 */
function normalizar(s: SubCruda): SubLeida {
  let planHandle: string | null = null;
  for (const li of s.lineItems ?? []) {
    const pd = li.plan?.pricingDetails;
    if (pd?.__typename === "AppRecurringPricing" && pd.planHandle) {
      planHandle = pd.planHandle;
      break;
    }
  }
  return { status: s.status ?? "DESCONOCIDO", planHandle };
}
