import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { TrendingUp, Tag, DollarSign, ShoppingCart, Plus, Clock, Info } from "lucide-react";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { es, estadoLabel, tipoLabel, formatCurrency } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: {
      products: {
        select: { originalPrice: true, originalCompareAtPrice: true },
      },
      orderAttributions: {
        select: { orderAmount: true, discountAmount: true },
      },
    },
  });

  const campaignsWithStats = campaigns.map((c) => {
    const config = c.config as Record<string, unknown>;
    let estimatedDiscount = 0;

    if (c.type === "PERCENTAGE") {
      const pct = Number(config.discountPercent ?? 0) / 100;
      const useCompare = Boolean(config.showCompareAtPrice);
      for (const p of c.products) {
        const base =
          useCompare && p.originalCompareAtPrice != null
            ? Number(p.originalCompareAtPrice)
            : Number(p.originalPrice ?? 0);
        estimatedDiscount += base * pct;
      }
    } else if (c.type === "RANGE") {
      const mode = String(config.mode ?? "fixedPrice");
      const val = Number(config.value ?? 0);
      for (const p of c.products) {
        const orig = Number(p.originalPrice ?? 0);
        if (mode === "fixedPrice") {
          estimatedDiscount += Math.max(0, orig - val);
        } else {
          estimatedDiscount += Math.min(val, Math.max(0, orig - 1));
        }
      }
    }

    const totalOrders = c.orderAttributions.length;
    const totalRevenue = c.orderAttributions.reduce(
      (s, o) => s + Number(o.orderAmount),
      0
    );
    const totalAttributedDiscount = c.orderAttributions.reduce(
      (s, o) => s + Number(o.discountAmount),
      0
    );

    return {
      id: c.id,
      name: c.name,
      type: c.type as "PERCENTAGE" | "RANGE" | "BXGY",
      status: c.status,
      productsCount: c.products.length,
      estimatedDiscount,
      totalOrders,
      totalRevenue,
      totalAttributedDiscount,
    };
  });

  const activeCampaigns = campaignsWithStats.filter(
    (c) => c.status === "ACTIVE"
  ).length;
  const productsOnDiscount = campaignsWithStats
    .filter((c) => c.status === "ACTIVE")
    .reduce((s, c) => s + c.productsCount, 0);
  const totalEstimatedDiscount = campaignsWithStats
    .filter((c) => c.status === "ACTIVE")
    .reduce((s, c) => s + c.estimatedDiscount, 0);
  const totalRevenue = campaignsWithStats.reduce(
    (s, c) => s + c.totalRevenue,
    0
  );

  return {
    activeCampaigns,
    productsOnDiscount,
    totalEstimatedDiscount,
    totalRevenue,
    campaigns: campaignsWithStats,
  };
};

// ─── KPI Card ─────────────────────────────────────────────────────────────────

type KpiCardProps = {
  icon: React.ReactNode;
  value: string;
  label: string;
  sublabel?: string;
  dimmed?: boolean;
};

function KpiCard({ icon, value, label, sublabel, dimmed }: KpiCardProps) {
  return (
    <div
      style={{
        background: dimmed ? "#fafafa" : "#ffffff",
        border: `1px solid ${dimmed ? "#e1e3e5" : "#e1e3e5"}`,
        borderRadius: "12px",
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        opacity: dimmed ? 0.75 : 1,
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          background: dimmed ? "#f1f2f3" : "#f1f8f5",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: dimmed ? "#8c9196" : "#008060",
          marginBottom: "4px",
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontSize: "28px",
          fontWeight: "700",
          color: dimmed ? "#8c9196" : "#202223",
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: "500" }}>
        {label}
      </div>
      {sublabel && (
        <div
          style={{
            fontSize: "11px",
            color: dimmed ? "#8c9196" : "#6d7175",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          {dimmed && <Clock size={11} />}
          {sublabel}
        </div>
      )}
    </div>
  );
}

// ─── Estado badge ─────────────────────────────────────────────────────────────

const ESTADO_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE: { bg: "#d3f5e2", text: "#007a5a" },
  DRAFT: { bg: "#e4e5e7", text: "#505050" },
  PAUSED: { bg: "#fff3cd", text: "#8b5e00" },
  COMPLETED: { bg: "#e8e0fc", text: "#4d2db8" },
  CANCELLED: { bg: "#fde8e8", text: "#c0392b" },
};

// ─── Page component ───────────────────────────────────────────────────────────

export default function Analytics() {
  const {
    activeCampaigns,
    productsOnDiscount,
    totalEstimatedDiscount,
    campaigns,
  } = useLoaderData<typeof loader>();

  const hasCampaigns = campaigns.length > 0;

  return (
    <s-page heading={es.analytics.titulo}>
      {/* Banner pendiente de aprobación */}
      <s-section>
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #ffc107",
            borderRadius: "8px",
            padding: "12px 16px",
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            marginBottom: "4px",
          }}
        >
          <Info size={16} style={{ color: "#a05c00", flexShrink: 0, marginTop: "1px" }} />
          <p style={{ fontSize: "13px", color: "#a05c00", margin: 0, lineHeight: 1.5 }}>
            {es.analytics.bannerPendiente}
          </p>
        </div>
      </s-section>

      {/* KPI Grid */}
      <s-section heading={es.analytics.subtitulo}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "16px",
            marginBottom: "4px",
          }}
        >
          <KpiCard
            icon={<TrendingUp size={18} />}
            value={String(activeCampaigns)}
            label={es.analytics.kpi.campanasActivas}
          />
          <KpiCard
            icon={<Tag size={18} />}
            value={String(productsOnDiscount)}
            label={es.analytics.kpi.productosEnDescuento}
          />
          <KpiCard
            icon={<DollarSign size={18} />}
            value={formatCurrency(totalEstimatedDiscount)}
            label={es.analytics.kpi.totalDescontadoEst}
            sublabel={es.analytics.estimadoNota}
          />
          <KpiCard
            icon={<ShoppingCart size={18} />}
            value="$0"
            label={es.analytics.kpi.ingresosAtribuidos}
            sublabel={es.analytics.pendienteAprobacion}
            dimmed
          />
        </div>
      </s-section>

      {/* Tabla de rendimiento */}
      <s-section heading="Rendimiento por campaña">
        {!hasCampaigns ? (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>📊</div>
            <p
              style={{
                color: "#6d7175",
                fontSize: "14px",
                maxWidth: "400px",
                margin: "0 auto 20px",
                lineHeight: "1.6",
              }}
            >
              {es.analytics.sinCampanas}
            </p>
            <Link
              to="/app/campaigns/new/percentage"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "#008060",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "8px 20px",
                fontSize: "14px",
                fontWeight: "500",
                textDecoration: "none",
              }}
            >
              <Plus size={16} />
              Crear primera campaña
            </Link>
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "14px",
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                    {[
                      es.analytics.tabla.campana,
                      es.analytics.tabla.tipo,
                      es.analytics.tabla.estado,
                      es.analytics.tabla.pedidos,
                      es.analytics.tabla.recaudacion,
                      es.analytics.tabla.totalDescontado,
                      es.analytics.tabla.roi,
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "8px 12px",
                          textAlign: "left",
                          color: "#6d7175",
                          fontWeight: "500",
                          fontSize: "12px",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => {
                    const estadoStyle =
                      ESTADO_COLORS[c.status] ?? ESTADO_COLORS.DRAFT;
                    const roi =
                      c.totalRevenue > 0 && c.estimatedDiscount > 0
                        ? `${((c.totalRevenue / c.estimatedDiscount) * 100).toFixed(0)}%`
                        : es.analytics.noAplica;
                    const descuentoCell =
                      c.type === "BXGY"
                        ? "—"
                        : c.estimatedDiscount > 0
                        ? formatCurrency(c.estimatedDiscount)
                        : "$0";

                    return (
                      <tr
                        key={c.id}
                        style={{ borderBottom: "1px solid #f1f2f3" }}
                      >
                        <td
                          style={{
                            padding: "12px",
                            fontWeight: "500",
                            color: "#202223",
                            maxWidth: "220px",
                          }}
                        >
                          {c.name}
                        </td>
                        <td style={{ padding: "12px", color: "#6d7175", whiteSpace: "nowrap" }}>
                          {tipoLabel(c.type)}
                        </td>
                        <td style={{ padding: "12px" }}>
                          <span
                            style={{
                              background: estadoStyle.bg,
                              color: estadoStyle.text,
                              padding: "2px 8px",
                              borderRadius: "20px",
                              fontSize: "12px",
                              fontWeight: "500",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {estadoLabel(c.status)}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "12px",
                            color: c.totalOrders > 0 ? "#202223" : "#8c9196",
                            textAlign: "right",
                          }}
                        >
                          {c.totalOrders}
                        </td>
                        <td
                          style={{
                            padding: "12px",
                            color: c.totalRevenue > 0 ? "#202223" : "#8c9196",
                            textAlign: "right",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.totalRevenue > 0
                            ? formatCurrency(c.totalRevenue)
                            : "$0"}
                        </td>
                        <td
                          style={{
                            padding: "12px",
                            textAlign: "right",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.type !== "BXGY" && c.estimatedDiscount > 0 ? (
                            <span>
                              {descuentoCell}{" "}
                              <span
                                style={{
                                  fontSize: "11px",
                                  color: "#8c9196",
                                  fontStyle: "italic",
                                }}
                              >
                                est.
                              </span>
                            </span>
                          ) : (
                            <span style={{ color: "#8c9196" }}>
                              {descuentoCell}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "12px",
                            color: "#8c9196",
                            textAlign: "right",
                          }}
                        >
                          {roi}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p
              style={{
                fontSize: "12px",
                color: "#8c9196",
                marginTop: "12px",
                fontStyle: "italic",
              }}
            >
              * Los valores marcados como "est." son estimados calculados desde
              el descuento unitario × variantes afectadas. Pedidos y Recaudación
              aparecerán automáticamente cuando se complete la aprobación de
              Shopify.
            </p>
          </>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
