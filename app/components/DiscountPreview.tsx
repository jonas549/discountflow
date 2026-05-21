// Panel lateral de vista previa del descuento + resumen de campaña.
// Usado en create (new.percentage) y edit ($id.edit).
import { es, estadoLabel } from "../i18n";

type DiscountPreviewProps = {
  discountPercent: number;
  name: string;
  productsDescription: string; // e.g. "3 productos", "2 colecciones", "Toda la tienda", "—"
  startsAt: string;
  endsAt: string;
  currentStatus?: string; // Solo en ruta de edición
};

export function DiscountPreview({
  discountPercent,
  name,
  productsDescription,
  startsAt,
  endsAt,
  currentStatus,
}: DiscountPreviewProps) {
  const base = 100;
  const discounted = discountPercent > 0 ? base * (1 - discountPercent / 100) : base;
  const savings = base - discounted;

  const summaryRows = [
    { label: es.nuevaPorcentaje.resumenNombre, value: name || es.nuevaPorcentaje.sinDefinir },
    { label: es.nuevaPorcentaje.resumenTipo, value: es.nuevaPorcentaje.resumenTipoPorcentaje },
    {
      label: es.nuevaPorcentaje.resumenDescuento,
      value: discountPercent > 0 ? `${discountPercent}%` : es.nuevaPorcentaje.sinDefinir,
    },
    { label: es.nuevaPorcentaje.resumenProductos, value: productsDescription },
    {
      label: es.nuevaPorcentaje.resumenInicio,
      value: startsAt
        ? new Date(startsAt).toLocaleDateString("es-MX")
        : es.nuevaPorcentaje.resumenInmediato,
    },
    {
      label: es.nuevaPorcentaje.resumenFin,
      value: endsAt
        ? new Date(endsAt).toLocaleDateString("es-MX")
        : es.nuevaPorcentaje.resumenSinFin,
    },
    ...(currentStatus !== undefined
      ? [{ label: "Estado actual", value: estadoLabel(currentStatus) }]
      : []),
  ];

  return (
    <>
      {/* Card 1 — Vista previa del descuento */}
      <div
        style={{
          border: "1px solid #e1e3e5",
          borderRadius: "10px",
          padding: "16px",
          marginBottom: "14px",
          background: "#fff",
        }}
      >
        <p
          style={{
            fontSize: "12px",
            fontWeight: "600",
            color: "#6d7175",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: "14px",
          }}
        >
          {es.nuevaPorcentaje.previewTitulo}
        </p>
        <div
          style={{
            background: "#f8fafb",
            border: "1px solid #e1e3e5",
            borderRadius: "8px",
            padding: "14px",
            position: "relative",
          }}
        >
          {discountPercent > 0 && (
            <div
              style={{
                position: "absolute",
                top: "10px",
                right: "10px",
                background: "#008060",
                color: "#fff",
                fontSize: "11px",
                fontWeight: "700",
                padding: "3px 8px",
                borderRadius: "12px",
              }}
            >
              -{discountPercent}%
            </div>
          )}
          <p style={{ fontSize: "11px", color: "#8c9196", marginBottom: "6px" }}>
            {es.nuevaPorcentaje.previewEjemplo}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
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
                }}
              >
                ${base.toFixed(2)}
              </div>
              <div style={{ fontSize: "18px", fontWeight: "700", color: "#008060" }}>
                ${discounted.toFixed(2)}
              </div>
              {discountPercent > 0 && (
                <div style={{ fontSize: "11px", color: "#6d7175" }}>
                  Ahorro: ${savings.toFixed(2)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Card 2 — Resumen */}
      <div
        style={{
          border: "1px solid #e1e3e5",
          borderRadius: "10px",
          padding: "16px",
          background: "#fff",
        }}
      >
        <p
          style={{
            fontSize: "12px",
            fontWeight: "600",
            color: "#6d7175",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: "14px",
          }}
        >
          {es.nuevaPorcentaje.resumenTitulo}
        </p>
        {summaryRows.map(({ label, value }) => (
          <div
            key={label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 0",
              borderBottom: "1px solid #f1f2f3",
              fontSize: "13px",
            }}
          >
            <span style={{ color: "#6d7175" }}>{label}</span>
            <span
              style={{
                color: "#202223",
                fontWeight: "500",
                textAlign: "right",
                maxWidth: "60%",
                wordBreak: "break-word",
              }}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
