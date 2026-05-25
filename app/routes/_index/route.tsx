import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
};

const GREEN = "#008060";
const GREEN_DARK = "#006e52";
const GRAY_TEXT = "#6d7175";
const BORDER = "#e1e3e5";

const features = [
  {
    icon: "🏷️",
    title: "3 tipos de campañas",
    desc: "Descuento por porcentaje, precio fijo o Compra X Lleva Y. Crea la campaña correcta para cada ocasión.",
  },
  {
    icon: "🎯",
    title: "Segmentación flexible",
    desc: "Aplica descuentos por productos, colecciones, tags, vendedor o toda tu tienda con un solo clic.",
  },
  {
    icon: "📊",
    title: "Analytics con ROI",
    desc: "Mide pedidos atribuidos, ingresos generados y retorno de inversión de cada campaña en tiempo real.",
  },
];

export default function Index() {
  return (
    <div
      style={{
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#202223",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Nav */}
      <nav
        style={{
          padding: "16px 32px",
          display: "flex",
          alignItems: "center",
          borderBottom: `1px solid ${BORDER}`,
          background: "#fff",
        }}
      >
        <span
          style={{ fontWeight: "700", fontSize: "20px", color: GREEN }}
        >
          DiscountFlow
        </span>
      </nav>

      {/* Hero */}
      <section
        style={{
          background: "linear-gradient(135deg, #f6fef9 0%, #e8f5ee 100%)",
          padding: "80px 32px",
          textAlign: "center",
          flex: 1,
        }}
      >
        <p
          style={{
            fontSize: "13px",
            fontWeight: "600",
            color: GREEN,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: "16px",
          }}
        >
          Descuentos hechos simples
        </p>
        <h1
          style={{
            fontSize: "clamp(28px, 5vw, 48px)",
            fontWeight: "800",
            lineHeight: "1.2",
            maxWidth: "700px",
            margin: "0 auto 20px",
            color: "#1a1f2e",
          }}
        >
          Aumenta tus ventas con campañas de descuento inteligentes
        </h1>
        <p
          style={{
            fontSize: "18px",
            color: GRAY_TEXT,
            maxWidth: "560px",
            margin: "0 auto 40px",
            lineHeight: "1.6",
          }}
        >
          Crea descuentos por porcentaje, precio fijo o BxGy en minutos.
          Mide su impacto con analytics reales.
        </p>
        <a
          href="https://apps.shopify.com/discountflow"
          style={{
            display: "inline-block",
            background: GREEN,
            color: "#fff",
            padding: "14px 32px",
            borderRadius: "8px",
            fontWeight: "600",
            fontSize: "16px",
            textDecoration: "none",
            transition: "background 0.2s",
          }}
          onMouseOver={(e) =>
            ((e.target as HTMLAnchorElement).style.background = GREEN_DARK)
          }
          onMouseOut={(e) =>
            ((e.target as HTMLAnchorElement).style.background = GREEN)
          }
        >
          Instalar en Shopify
        </a>
      </section>

      {/* Features */}
      <section
        style={{
          padding: "64px 32px",
          background: "#fff",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontSize: "28px",
            fontWeight: "700",
            marginBottom: "48px",
            color: "#1a1f2e",
          }}
        >
          Todo lo que necesitas para gestionar tus descuentos
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "24px",
            maxWidth: "900px",
            margin: "0 auto",
          }}
        >
          {features.map((f) => (
            <div
              key={f.title}
              style={{
                background: "#f9fafb",
                border: `1px solid ${BORDER}`,
                borderRadius: "12px",
                padding: "28px 24px",
                textAlign: "left",
              }}
            >
              <div style={{ fontSize: "32px", marginBottom: "14px" }}>
                {f.icon}
              </div>
              <h3
                style={{
                  fontSize: "17px",
                  fontWeight: "700",
                  marginBottom: "10px",
                  color: "#1a1f2e",
                }}
              >
                {f.title}
              </h3>
              <p
                style={{
                  fontSize: "14px",
                  color: GRAY_TEXT,
                  lineHeight: "1.6",
                  margin: 0,
                }}
              >
                {f.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer
        style={{
          padding: "24px 32px",
          borderTop: `1px solid ${BORDER}`,
          background: "#f9fafb",
          textAlign: "center",
          fontSize: "13px",
          color: GRAY_TEXT,
        }}
      >
        © 2026 DiscountFlow · Soporte:{" "}
        <a
          href="mailto:contacto@appsdeveloperspro.com"
          style={{ color: GREEN, textDecoration: "none" }}
        >
          contacto@appsdeveloperspro.com
        </a>
      </footer>
    </div>
  );
}
