import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Mail, Clock, BookOpen, Zap } from "lucide-react";
import { authenticate } from "../shopify.server";
import { Btn } from "../components/Btn";
import { es } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

// ─── Card base ────────────────────────────────────────────────────────────────

function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e1e3e5",
        borderRadius: "12px",
        padding: "24px 28px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CardIcon({
  icon,
  color = "#008060",
  bg = "#f1f8f5",
}: {
  icon: React.ReactNode;
  color?: string;
  bg?: string;
}) {
  return (
    <div
      style={{
        width: "40px",
        height: "40px",
        borderRadius: "10px",
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color,
        marginBottom: "14px",
      }}
    >
      {icon}
    </div>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function Support() {
  return (
    <s-page heading={es.soporte.titulo}>
      <s-section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "16px",
          }}
        >
          {/* Card 1 — Bienvenida */}
          <Card style={{ gridColumn: "1 / -1" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "20px" }}>
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "12px",
                  background: "#f1f8f5",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#008060",
                  flexShrink: 0,
                }}
              >
                <Zap size={22} />
              </div>
              <div>
                <h2
                  style={{
                    fontSize: "16px",
                    fontWeight: "600",
                    color: "#202223",
                    margin: "0 0 10px",
                  }}
                >
                  {es.soporte.bienvenidaTitulo}
                </h2>
                <p
                  style={{
                    fontSize: "14px",
                    color: "#6d7175",
                    lineHeight: "1.6",
                    margin: "0 0 8px",
                  }}
                >
                  {es.soporte.bienvenidaTexto}
                </p>
                <p
                  style={{
                    fontSize: "14px",
                    color: "#6d7175",
                    lineHeight: "1.6",
                    margin: 0,
                    fontWeight: "500",
                  }}
                >
                  {es.soporte.bienvenidaSub}
                </p>
              </div>
            </div>
          </Card>

          {/* Card 2 — Contacto */}
          <Card>
            <CardIcon icon={<Mail size={20} />} />
            <h3
              style={{
                fontSize: "15px",
                fontWeight: "600",
                color: "#202223",
                margin: "0 0 8px",
              }}
            >
              {es.soporte.contactoTitulo}
            </h3>
            <p
              style={{
                fontSize: "13px",
                color: "#6d7175",
                margin: "0 0 12px",
                lineHeight: "1.5",
              }}
            >
              Escríbenos directamente y un miembro del equipo te responderá a la brevedad.
            </p>
            <a
              href={`mailto:${es.soporte.correo}`}
              style={{
                display: "block",
                fontSize: "14px",
                fontWeight: "600",
                color: "#008060",
                textDecoration: "none",
                marginBottom: "16px",
                wordBreak: "break-all",
              }}
            >
              {es.soporte.correo}
            </a>
            <a href={`mailto:${es.soporte.correo}`}>
              <Btn variant="primary" size="md">
                <Mail size={15} />
                {es.soporte.btnEnviarCorreo}
              </Btn>
            </a>
          </Card>

          {/* Card 3 — Tiempo de respuesta */}
          <Card>
            <CardIcon
              icon={<Clock size={20} />}
              color="#a05c00"
              bg="#fff8e1"
            />
            <h3
              style={{
                fontSize: "15px",
                fontWeight: "600",
                color: "#202223",
                margin: "0 0 8px",
              }}
            >
              {es.soporte.tiempoTitulo}
            </h3>
            <p
              style={{
                fontSize: "20px",
                fontWeight: "700",
                color: "#008060",
                margin: "0 0 6px",
              }}
            >
              ⚡ {es.soporte.tiempoTexto}
            </p>
            <p
              style={{
                fontSize: "13px",
                color: "#6d7175",
                margin: 0,
                lineHeight: "1.5",
              }}
            >
              {es.soporte.tiempoSub}
            </p>
          </Card>

          {/* Card 4 — Recursos rápidos */}
          <Card style={{ gridColumn: "1 / -1" }}>
            <CardIcon
              icon={<BookOpen size={20} />}
              color="#4d2db8"
              bg="#f0ebff"
            />
            <h3
              style={{
                fontSize: "15px",
                fontWeight: "600",
                color: "#202223",
                margin: "0 0 14px",
              }}
            >
              {es.soporte.recursosTitulo}
            </h3>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "10px" }}>
              {es.soporte.recursos.map((item) => (
                <li key={item}>
                  <a
                    href="#"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "14px",
                      color: "#008060",
                      textDecoration: "none",
                      fontWeight: "500",
                    }}
                  >
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "50%",
                        background: "#008060",
                        flexShrink: 0,
                      }}
                    />
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
