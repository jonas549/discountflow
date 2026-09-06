import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Check, Zap } from "lucide-react";
import { authenticate } from "../shopify.server";
import { getOrCreateShop, syncShopPlanIfStale } from "../lib/shopify/shop.server";
import { PLAN_LIMITS, type Plan } from "../lib/billing/plan-limits";
import { getCampaignCount, getVariantCount } from "../lib/billing/plan-limits.server";
import { es } from "../i18n";

// IMPORTANT: After configuring plans in Partner Dashboard, set the welcome link
// for each plan to: https://discountflow-app.vercel.app/app/plans/confirm
// Shopify will append ?plan_handle=X&shop=Y automatically.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  // Force sync on this page — merchant is making billing decisions
  const syncedShop = await syncShopPlanIfStale(admin, {
    ...shop,
    lastSyncAt: null, // force sync
  });

  const [campaignCount, variantCount] = await Promise.all([
    getCampaignCount(shop.id),
    getVariantCount(shop.id),
  ]);

  const shopName = session.shop.replace(".myshopify.com", "");
  // 🔴 SIN valor de reserva, a propósito.
  //
  // Antes era `process.env.SHOPIFY_APP_HANDLE || "discountflow-1"`, y
  // `discountflow-1` es el handle de la app de PRODUCCIÓN. Como este archivo lo
  // comparten las dos apps, cualquier instalación sin la variable definida —la app
  // de desarrollo, por ejemplo— construía la URL de precios de PRODUCCIÓN y
  // entregaba el merchant a otra app: la página de precios, el cobro y el welcome
  // link pertenecían a la app equivocada. Pasó el 2026-09-01 en la tienda de
  // pruebas y fue invisible hasta que alguien miró a dónde había ido a parar.
  //
  // Ahora falta la variable = no hay botón de cobro. Es preferible no poder
  // cambiar de plan a cambiarlo en la app de otro.
  // eslint-disable-next-line no-undef
  const appHandle = process.env.SHOPIFY_APP_HANDLE?.trim() || null;

  return {
    currentPlan: syncedShop.plan as Plan,
    campaignCount,
    variantCount,
    shopName,
    appHandle,
  };
};

// ─── Plan card ────────────────────────────────────────────────────────────────

/**
 * Lo que la tarjeta de cada plan le promete al merchant.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 ESTO TIENE QUE DESCRIBIR `PLAN_LIMITS`, NO AL REVÉS.
 *
 * Hasta el 2026-09-06 los cuatro planes decían "Porcentaje, Rango de precio,
 * BxGy", y en GRATIS eso era FALSO desde que F4 cerró el agujero: el plan
 * gratuito no incluye BxGy. El texto se quedó atrás de la tabla y estuvo
 * mintiéndole a los merchants gratuitos.
 *
 * Por eso `plan-features.test.ts` compara estas cadenas contra `PLAN_LIMITS` y
 * falla si vuelven a divergir. Si cambiás un límite, este texto tiene que
 * cambiar con él.
 *
 * Los topes por tipo salen de `PLAN_LIMITS[plan].types`:
 *
 *              BxGy    Escalonados  Packs   Monto     Cupón
 *   GRATIS      ✗          ✗          ✗       ✗         ✗
 *   LITE        4          2          ✗       2         ✗
 *   ESSENTIAL   10         10        sin      sin       sin
 *   PROFES.    sin        sin        sin      sin       sin
 *
 * ⚠️ Las líneas de ANALÍTICAS y SOPORTE no tienen nada detrás en el código: no
 * hay gating por plan en `app.analytics.tsx` ni en `app.support.tsx`, y los
 * cuatro planes ven lo mismo. Se conservan como estaban, pero prometen una
 * diferencia que el producto no implementa. Pendiente de decisión de Jonas.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const FEATURES: Record<Plan, string[]> = {
  FREE: [
    "2 campañas activas",
    "50 variantes en descuento",
    // Solo estos dos: los otros cinco tipos tienen `incluido: false` en FREE.
    "Porcentaje y Rango de precio",
    "Analíticas básicas",
    "Soporte por email",
  ],
  LITE: [
    "5 campañas activas",
    "750 variantes en descuento",
    "Porcentaje, Rango de precio, BxGy (hasta 4) y Escalonados (hasta 2)",
    // 🔴 El código dice `max: 2`, no 1. Esa fila sigue marcada como SUPUESTO en
    // `plan-limits.ts`: si se decide otro número, se cambia allá y acá.
    "Descuento por monto de compra (hasta 2 activas)",
    "Analíticas completas",
    "Soporte prioritario",
  ],
  ESSENTIAL: [
    "50 campañas activas",
    "6.000 variantes en descuento",
    "Todos los tipos: Porcentaje, Rango, BxGy, Escalonados, Packs armables, Monto de compra y Cupón sobre precio original",
    "BxGy y Escalonados: hasta 10 activas de cada uno",
    "Analíticas completas + ROI",
    "Soporte prioritario",
  ],
  PROFESSIONAL: [
    "100 campañas activas",
    "10.000 variantes en descuento",
    "Todos los tipos, sin límite por tipo",
    "Analíticas avanzadas",
    "Soporte dedicado",
  ],
};

const PLAN_ORDER: Plan[] = ["FREE", "LITE", "ESSENTIAL", "PROFESSIONAL"];

function PlanCard({
  planKey,
  isCurrent,
  isPopular,
  pricingUrl,
}: {
  planKey: Plan;
  isCurrent: boolean;
  isPopular: boolean;
  /** `null` si falta SHOPIFY_APP_HANDLE: la tarjeta muestra el aviso, no el botón. */
  pricingUrl: string | null;
}) {
  const limits = PLAN_LIMITS[planKey];
  const features = FEATURES[planKey];

  const borderColor = isCurrent ? "#008060" : isPopular ? "#5c6ac4" : "#e1e3e5";
  const headerBg = isPopular ? "#5c6ac4" : isCurrent ? "#008060" : "#f6f6f7";
  const headerText = isPopular || isCurrent ? "#fff" : "#202223";

  return (
    <div
      style={{
        border: `2px solid ${borderColor}`,
        borderRadius: "14px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {isPopular && (
        <div
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            background: "#fff",
            color: "#5c6ac4",
            fontSize: "10px",
            fontWeight: "700",
            padding: "2px 8px",
            borderRadius: "10px",
            letterSpacing: "0.05em",
          }}
        >
          {es.planes.masPopular}
        </div>
      )}

      {/* Header */}
      <div
        style={{
          background: headerBg,
          padding: "20px 24px",
          color: headerText,
        }}
      >
        <div
          style={{
            fontSize: "13px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            opacity: 0.8,
            marginBottom: "4px",
          }}
        >
          {limits.label}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
          <span style={{ fontSize: "32px", fontWeight: "700" }}>
            {limits.price === 0 ? es.planes.gratis : `$${limits.price}`}
          </span>
          {limits.price > 0 && (
            <span style={{ fontSize: "13px", opacity: 0.75 }}>{es.planes.mes}</span>
          )}
        </div>
      </div>

      {/* Features */}
      <div style={{ padding: "20px 24px", flex: 1 }}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {features.map((f) => (
            <li
              key={f}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                marginBottom: "10px",
                fontSize: "13px",
                color: "#3d4147",
              }}
            >
              <Check size={14} style={{ color: "#008060", flexShrink: 0, marginTop: "2px" }} />
              {f}
            </li>
          ))}
        </ul>
      </div>

      {/* CTA */}
      <div style={{ padding: "0 24px 24px" }}>
        {isCurrent ? (
          <div
            style={{
              textAlign: "center",
              padding: "10px",
              background: "#f1f8f5",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#008060",
            }}
          >
            {es.planes.btnActual}
          </div>
        ) : pricingUrl ? (
          <a
            href={pricingUrl}
            target="_top"
            style={{
              display: "block",
              textAlign: "center",
              padding: "10px",
              background: isPopular ? "#5c6ac4" : "#008060",
              color: "#fff",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: "600",
              textDecoration: "none",
            }}
          >
            {es.planes.btnUpgrade}
          </a>
        ) : (
          <div
            style={{
              textAlign: "center",
              padding: "10px",
              background: "#fff8e1",
              border: "1px solid #f9a825",
              borderRadius: "8px",
              fontSize: "12px",
              color: "#a05c00",
              lineHeight: 1.4,
            }}
          >
            {es.planes.cobroNoConfigurado}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Plans() {
  const { currentPlan, campaignCount, variantCount, shopName, appHandle } =
    useLoaderData<typeof loader>();

  // `null` cuando falta SHOPIFY_APP_HANDLE: las tarjetas muestran un aviso en vez
  // del botón, en lugar de enlazar a la página de precios de otra app.
  const pricingUrl = appHandle
    ? `https://admin.shopify.com/store/${shopName}/charges/${appHandle}/pricing_plans`
    : null;

  const limits = PLAN_LIMITS[currentPlan];

  return (
    <s-page heading={es.planes.titulo}>
      {/* Current plan summary */}
      <s-section>
        <div
          style={{
            background: "#f6f6f7",
            borderRadius: "10px",
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "8px",
              background: "#f1f8f5",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#008060",
            }}
          >
            <Zap size={18} />
          </div>
          <div>
            <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "2px" }}>
              {es.planes.planActual}
            </div>
            <div style={{ fontSize: "16px", fontWeight: "600", color: "#202223" }}>
              {limits.label}
            </div>
            <div style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>
              {campaignCount} / {limits.campaigns} campañas · {variantCount.toLocaleString("en-US")} / {limits.variants.toLocaleString("en-US")} variantes
            </div>
          </div>
        </div>
      </s-section>

      {/* Plan cards */}
      <s-section heading={es.planes.subtitulo}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "16px",
          }}
        >
          {PLAN_ORDER.map((key) => (
            <PlanCard
              key={key}
              planKey={key}
              isCurrent={key === currentPlan}
              isPopular={key === "ESSENTIAL"}
              pricingUrl={pricingUrl}
            />
          ))}
        </div>
        <p
          style={{
            fontSize: "12px",
            color: "#8c9196",
            marginTop: "16px",
            textAlign: "center",
          }}
        >
          {es.planes.notaConfig}
        </p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
