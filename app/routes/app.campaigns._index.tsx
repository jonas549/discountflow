import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Plus } from "lucide-react";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { es, estadoLabel, tipoLabel, formatDate } from "../i18n";

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
    include: { _count: { select: { products: true } } },
  });
  return {
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      config: c.config as Record<string, unknown>,
      productsCount: c._count.products,
      startsAt: c.startsAt?.toISOString() ?? null,
      endsAt: c.endsAt?.toISOString() ?? null,
    })),
  };
};

// ─── Mini visual mockups ──────────────────────────────────────────────────────

function MockupPorcentaje() {
  return (
    <div
      style={{
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 14px",
        marginBottom: "16px",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "10px",
          right: "10px",
          background: "#008060",
          color: "#fff",
          fontSize: "11px",
          fontWeight: "700",
          padding: "2px 7px",
          borderRadius: "12px",
        }}
      >
        -20%
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div
          style={{
            width: "36px",
            height: "36px",
            background: "#e1e3e5",
            borderRadius: "6px",
            flexShrink: 0,
          }}
        />
        <div>
          <div
            style={{
              fontSize: "12px",
              color: "#8c9196",
              textDecoration: "line-through",
              lineHeight: 1.3,
            }}
          >
            $50.00
          </div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "700",
              color: "#202223",
              lineHeight: 1.3,
            }}
          >
            $40.00
          </div>
        </div>
      </div>
    </div>
  );
}

function MockupRango() {
  return (
    <div
      style={{
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 14px",
        marginBottom: "16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
        }}
      >
        <span style={{ color: "#6d7175" }}>$35.00</span>
        <span style={{ color: "#8c9196", fontSize: "16px" }}>→</span>
        <span style={{ fontWeight: "700", color: "#202223" }}>$15.00</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "10px",
            background: "#fff3cd",
            color: "#8b5e00",
            padding: "2px 6px",
            borderRadius: "10px",
            fontWeight: "600",
          }}
        >
          FIJO
        </span>
      </div>
    </div>
  );
}

function MockupBxGy() {
  return (
    <div
      style={{
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 14px",
        marginBottom: "16px",
      }}
    >
      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        <div
          style={{
            background: "#e1e3e5",
            borderRadius: "5px",
            width: "28px",
            height: "28px",
          }}
        />
        <div
          style={{
            background: "#e1e3e5",
            borderRadius: "5px",
            width: "28px",
            height: "28px",
          }}
        />
        <span style={{ color: "#8c9196", fontSize: "12px", margin: "0 4px" }}>
          +
        </span>
        <div style={{ position: "relative" }}>
          <div
            style={{
              background: "#e8f5e9",
              border: "1px solid #a5d6a7",
              borderRadius: "5px",
              width: "28px",
              height: "28px",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "-8px",
              right: "-8px",
              background: "#4caf50",
              color: "#fff",
              fontSize: "7px",
              fontWeight: "700",
              padding: "1px 4px",
              borderRadius: "8px",
            }}
          >
            FREE
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Campaign type card ───────────────────────────────────────────────────────

type CampaignCardProps = {
  mockup: React.ReactNode;
  title: string;
  description: string;
  ejemplo: string;
  href?: string;
  disabled?: boolean;
};

function CampaignCard({
  mockup,
  title,
  description,
  ejemplo,
  href,
  disabled = false,
}: CampaignCardProps) {
  return (
    <div
      style={{
        background: disabled ? "#fafafa" : "#ffffff",
        border: "1.5px solid",
        borderColor: disabled ? "#e1e3e5" : "#c9cccf",
        borderRadius: "12px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        opacity: disabled ? 0.75 : 1,
        transition: "box-shadow 0.15s, border-color 0.15s",
        cursor: disabled ? "not-allowed" : "default",
        flex: "1 1 260px",
        minWidth: "260px",
        maxWidth: "340px",
        position: "relative",
      }}
    >
      {disabled && (
        <div
          style={{
            position: "absolute",
            top: "14px",
            right: "14px",
            background: "#e4e5e7",
            color: "#6d7175",
            fontSize: "10px",
            fontWeight: "700",
            padding: "2px 8px",
            borderRadius: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {es.campanas.proximamente}
        </div>
      )}
      {mockup}
      <div
        style={{
          fontSize: "15px",
          fontWeight: "600",
          color: "#202223",
          marginBottom: "6px",
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: "13px",
          color: "#6d7175",
          lineHeight: "1.5",
          marginBottom: "10px",
          flexGrow: 1,
        }}
      >
        {description}
      </div>
      <div
        style={{
          fontSize: "12px",
          color: "#8c9196",
          marginBottom: "16px",
          background: "#f8fafb",
          padding: "6px 10px",
          borderRadius: "6px",
        }}
      >
        💡 {ejemplo}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        {disabled ? (
          <button
            disabled
            style={{
              background: "#e4e5e7",
              color: "#8c9196",
              border: "none",
              borderRadius: "6px",
              padding: "7px 14px",
              fontSize: "13px",
              fontWeight: "500",
              cursor: "not-allowed",
            }}
          >
            {es.campanas.crear}
          </button>
        ) : (
          <Link
            to={href ?? "/app/campaigns"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              background: "#008060",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              padding: "7px 14px",
              fontSize: "13px",
              fontWeight: "500",
              textDecoration: "none",
            }}
          >
            <Plus size={14} />
            {es.campanas.crear}
          </Link>
        )}
        <button
          disabled={disabled}
          style={{
            background: "transparent",
            color: disabled ? "#8c9196" : "#006fbb",
            border: "none",
            padding: "7px 10px",
            fontSize: "13px",
            fontWeight: "500",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          {es.campanas.masInfo}
        </button>
      </div>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const ESTADO_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE: { bg: "#d3f5e2", text: "#007a5a" },
  DRAFT: { bg: "#e4e5e7", text: "#505050" },
  PAUSED: { bg: "#fff3cd", text: "#8b5e00" },
  COMPLETED: { bg: "#e8e0fc", text: "#4d2db8" },
  CANCELLED: { bg: "#fde8e8", text: "#c0392b" },
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Campaigns() {
  const { campaigns } = useLoaderData<typeof loader>();

  return (
    <s-page heading={es.campanas.titulo}>
      {/* Campaign type picker */}
      <s-section heading={es.campanas.crearSeccion}>
        <p
          style={{
            fontSize: "14px",
            color: "#6d7175",
            marginBottom: "20px",
          }}
        >
          {es.campanas.subtitulo}
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
          }}
        >
          <CampaignCard
            mockup={<MockupPorcentaje />}
            title={es.campanas.porcentaje.titulo}
            description={es.campanas.porcentaje.descripcion}
            ejemplo={es.campanas.porcentaje.ejemplo}
            href="/app/campaigns/new/percentage"
          />
          <CampaignCard
            mockup={<MockupRango />}
            title={es.campanas.rango.titulo}
            description={es.campanas.rango.descripcion}
            ejemplo={es.campanas.rango.ejemplo}
            disabled
          />
          <CampaignCard
            mockup={<MockupBxGy />}
            title={es.campanas.bxgy.titulo}
            description={es.campanas.bxgy.descripcion}
            ejemplo={es.campanas.bxgy.ejemplo}
            disabled
          />
        </div>
      </s-section>

      {/* Campaigns list */}
      <s-section heading={es.campanas.tusCampanas}>
        {campaigns.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "40px 0",
              color: "#6d7175",
              fontSize: "14px",
            }}
          >
            {es.campanas.sinCampanas}
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
                <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                  {[
                    es.campanas.tabla.nombre,
                    es.campanas.tabla.tipo,
                    es.campanas.tabla.estado,
                    es.campanas.tabla.descuento,
                    es.campanas.tabla.productos,
                    es.campanas.tabla.inicio,
                    es.campanas.tabla.fin,
                    es.campanas.tabla.acciones,
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "10px 12px",
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
                  const st =
                    ESTADO_COLORS[c.status] ?? ESTADO_COLORS.DRAFT;
                  const discount =
                    c.type === "PERCENTAGE"
                      ? `${(c.config as { discountPercent?: number }).discountPercent ?? "—"}%`
                      : "—";
                  return (
                    <tr
                      key={c.id}
                      style={{
                        borderBottom: "1px solid #f1f2f3",
                        transition: "background 0.1s",
                      }}
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
                            padding: "2px 9px",
                            borderRadius: "20px",
                            fontSize: "12px",
                            fontWeight: "500",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {estadoLabel(c.status)}
                        </span>
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {discount}
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {c.productsCount}
                      </td>
                      <td
                        style={{
                          padding: "12px",
                          color: "#6d7175",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatDate(c.startsAt)}
                      </td>
                      <td
                        style={{
                          padding: "12px",
                          color: "#6d7175",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatDate(c.endsAt)}
                      </td>
                      <td style={{ padding: "12px" }}>
                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            alignItems: "center",
                          }}
                        >
                          <button
                            style={{
                              background: "transparent",
                              border: "1px solid #c9cccf",
                              borderRadius: "5px",
                              padding: "4px 10px",
                              fontSize: "12px",
                              cursor: "pointer",
                              color: "#202223",
                            }}
                          >
                            Editar
                          </button>
                          {c.status === "ACTIVE" && (
                            <button
                              style={{
                                background: "transparent",
                                border: "1px solid #c9cccf",
                                borderRadius: "5px",
                                padding: "4px 10px",
                                fontSize: "12px",
                                cursor: "pointer",
                                color: "#202223",
                              }}
                            >
                              Pausar
                            </button>
                          )}
                        </div>
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
