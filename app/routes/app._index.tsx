import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  TrendingUp,
  Tag,
  DollarSign,
  ShoppingCart,
  Plus,
  BarChart2,
  HelpCircle,
} from "lucide-react";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { es, estadoLabel, tipoLabel, formatDate, formatCurrency } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [activeCampaigns, allCampaigns, productsOnDiscount, ingresosAggregate, pedidosMes] =
    await Promise.all([
      prisma.campaign.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
      prisma.campaign.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { _count: { select: { products: true } } },
      }),
      prisma.campaignProduct.count({
        where: { campaign: { shopId: shop.id, status: "ACTIVE" } },
      }),
      prisma.orderAttribution.aggregate({
        where: { campaign: { shopId: shop.id } },
        _sum: { orderAmount: true },
      }),
      prisma.orderAttribution.count({
        where: { campaign: { shopId: shop.id }, createdAt: { gte: startOfMonth } },
      }),
    ]);

  const ingresosAtribuidos = Number(ingresosAggregate._sum.orderAmount ?? 0);

  return {
    activeCampaigns,
    productsOnDiscount,
    ingresosAtribuidos,
    pedidosMes,
    recentCampaigns: allCampaigns.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      productsCount: c._count.products,
      startsAt: c.startsAt?.toISOString() ?? null,
      endsAt: c.endsAt?.toISOString() ?? null,
    })),
  };
};

type KpiCardProps = {
  icon: React.ReactNode;
  value: string;
  label: string;
  sublabel?: string;
};

function KpiCard({ icon, value, label, sublabel }: KpiCardProps) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e1e3e5",
        borderRadius: "12px",
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
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
          marginBottom: "4px",
        }}
      >
        {icon}
      </div>
      <div
        style={{ fontSize: "28px", fontWeight: "700", color: "#202223", lineHeight: 1 }}
      >
        {value}
      </div>
      <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: "500" }}>
        {label}
      </div>
      {sublabel && (
        <div style={{ fontSize: "12px", color: "#8c9196" }}>{sublabel}</div>
      )}
    </div>
  );
}

const ESTADO_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE: { bg: "#d3f5e2", text: "#007a5a" },
  DRAFT: { bg: "#e4e5e7", text: "#505050" },
  PAUSED: { bg: "#fff3cd", text: "#8b5e00" },
  COMPLETED: { bg: "#e8e0fc", text: "#4d2db8" },
  CANCELLED: { bg: "#fde8e8", text: "#c0392b" },
};

export default function Dashboard() {
  const { activeCampaigns, productsOnDiscount, ingresosAtribuidos, pedidosMes, recentCampaigns } =
    useLoaderData<typeof loader>();

  const estadoStyle = (status: string) =>
    ESTADO_COLORS[status] ?? { bg: "#e4e5e7", text: "#505050" };

  return (
    <s-page heading={es.dashboard.titulo}>
      {/* KPI Cards */}
      <s-section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "16px",
          }}
        >
          <KpiCard
            icon={<TrendingUp size={18} />}
            value={String(activeCampaigns)}
            label={es.dashboard.kpi.campanasActivas}
            sublabel={`${es.dashboard.kpi.vsUltimoMes}: —`}
          />
          <KpiCard
            icon={<Tag size={18} />}
            value={String(productsOnDiscount)}
            label={es.dashboard.kpi.productosEnDescuento}
          />
          <KpiCard
            icon={<DollarSign size={18} />}
            value={ingresosAtribuidos > 0 ? formatCurrency(ingresosAtribuidos) : "$0"}
            label={es.dashboard.kpi.ingresosAtribuidos}
            sublabel={ingresosAtribuidos === 0 ? "Sin pedidos atribuidos aún" : undefined}
          />
          <KpiCard
            icon={<ShoppingCart size={18} />}
            value={String(pedidosMes)}
            label={es.dashboard.kpi.conversionesMes}
            sublabel={pedidosMes === 0 ? "Sin pedidos este mes" : undefined}
          />
        </div>
      </s-section>

      {/* Quick Actions */}
      <s-section heading={es.dashboard.accionesRapidas}>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <Link
            to="/app/campaigns"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#008060",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              padding: "8px 16px",
              fontSize: "14px",
              fontWeight: "500",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            <Plus size={16} />
            {es.dashboard.crearCampana}
          </Link>
          <Link
            to="/app/analytics"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#ffffff",
              color: "#202223",
              border: "1px solid #c9cccf",
              borderRadius: "6px",
              padding: "8px 16px",
              fontSize: "14px",
              fontWeight: "500",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            <BarChart2 size={16} />
            {es.dashboard.verAnaliticas}
          </Link>
          <Link
            to="/app/support"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#ffffff",
              color: "#202223",
              border: "1px solid #c9cccf",
              borderRadius: "6px",
              padding: "8px 16px",
              fontSize: "14px",
              fontWeight: "500",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            <HelpCircle size={16} />
            {es.dashboard.centroDeSoporte}
          </Link>
        </div>
      </s-section>

      {/* Recent Campaigns */}
      <s-section heading={es.dashboard.campanasRecientes}>
        {recentCampaigns.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "48px 0",
              color: "#6d7175",
            }}
          >
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>🎯</div>
            <p style={{ marginBottom: "20px", fontSize: "14px" }}>
              {es.dashboard.sinCampanas}
            </p>
            <Link
              to="/app/campaigns"
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
              {es.dashboard.crearCTA}
            </Link>
          </div>
        ) : (
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
                  {["Nombre", "Tipo", "Estado", "Productos", "Inicio"].map(
                    (h) => (
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
                        }}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {recentCampaigns.map((c) => {
                  const st = estadoStyle(c.status);
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
                        }}
                      >
                        {c.name}
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {tipoLabel(c.type)}
                      </td>
                      <td style={{ padding: "12px" }}>
                        <span
                          style={{
                            background: st.bg,
                            color: st.text,
                            padding: "2px 8px",
                            borderRadius: "20px",
                            fontSize: "12px",
                            fontWeight: "500",
                          }}
                        >
                          {estadoLabel(c.status)}
                        </span>
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {c.productsCount}
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {formatDate(c.startsAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
