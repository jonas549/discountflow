// Panel lateral de vista previa para campañas de Rango de Precio.
// Usado en new.range y edit_.range.
import { es, estadoLabel } from "../i18n";
import type { RangeMode } from "../lib/discounts/range";

type RangeDiscountPreviewProps = {
  mode: RangeMode | "";
  value: number;
  name: string;
  productsDescription: string;
  startsAt: string;
  endsAt: string;
  currentStatus?: string;
};

export function RangeDiscountPreview({
  mode,
  value,
  name,
  productsDescription,
  startsAt,
  endsAt,
  currentStatus,
}: RangeDiscountPreviewProps) {
  const base = 50;
  let discounted: number | null = null;

  if (mode === "fixedPrice" && value > 0 && value < base) {
    discounted = value;
  } else if (mode === "fixedAmount" && value > 0 && base - value >= 1) {
    discounted = base - value;
  }

  const modoLabel =
    mode === "fixedPrice"
      ? es.nuevaRango.modoFijo
      : mode === "fixedAmount"
      ? es.nuevaRango.modoMonto
      : es.nuevaRango.sinDefinir;

  const valorLabel =
    value > 0 && mode
      ? mode === "fixedPrice"
        ? `$${value.toFixed(2)}`
        : `-$${value.toFixed(2)}`
      : es.nuevaRango.sinDefinir;

  const summaryRows = [
    { label: es.nuevaRango.resumenNombre, value: name || es.nuevaRango.sinDefinir },
    { label: es.nuevaRango.resumenTipo, value: es.nuevaRango.resumenTipoRango },
    { label: es.nuevaRango.resumenModo, value: modoLabel },
    { label: es.nuevaRango.resumenValor, value: valorLabel },
    { label: es.nuevaRango.resumenProductos, value: productsDescription },
    {
      label: es.nuevaRango.resumenInicio,
      value: startsAt
        ? new Date(startsAt).toLocaleDateString("es-MX")
        : es.nuevaRango.resumenInmediato,
    },
    {
      label: es.nuevaRango.resumenFin,
      value: endsAt
        ? new Date(endsAt).toLocaleDateString("es-MX")
        : es.nuevaRango.resumenSinFin,
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
          {es.nuevaRango.previewTitulo}
        </p>
        <p style={{ fontSize: "11px", color: "#8c9196", marginBottom: "8px" }}>
          {es.nuevaRango.previewEjemplo}
        </p>

        {discounted !== null ? (
          <div
            style={{
              background: "#f8fafb",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              padding: "14px",
            }}
          >
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
                <div style={{ fontSize: "11px", color: "#6d7175" }}>
                  Ahorro: ${(base - discounted).toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              background: "#f8fafb",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              padding: "14px",
              color: "#8c9196",
              fontSize: "13px",
            }}
          >
            {es.nuevaRango.previewPendiente}
          </div>
        )}

        {mode && value > 0 && (
          <div
            style={{
              marginTop: "10px",
              background: "#fff8e1",
              border: "1px solid #ffe082",
              borderRadius: "6px",
              padding: "8px 12px",
              fontSize: "12px",
              color: "#8b5e00",
            }}
          >
            ⚠️ {es.nuevaRango.previewNota}
          </div>
        )}
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
          {es.nuevaRango.resumenTitulo}
        </p>
        {summaryRows.map(({ label, value: val }) => (
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
              {val}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
