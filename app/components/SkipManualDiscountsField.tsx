// Casilla «No tocar productos que ya tienen descuento» de las campañas de Porcentaje.
export function SkipManualDiscountsField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      data-testid="skip-manual-discounts"
      style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginTop: "12px", cursor: "pointer" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: "3px", flexShrink: 0 }}
      />
      <div>
        <span style={{ fontSize: "13px", fontWeight: "500", color: "#202223" }}>
          No tocar productos que ya tienen descuento
        </span>
        <p style={{ fontSize: "12px", color: "#6d7175", margin: "3px 0 0", lineHeight: "1.4" }}>
          Si un producto ya tiene un precio comparativo puesto a mano (se ve tachado en la tienda), la
          campaña lo salta entero y deja sus precios como están. Al terminar verás en el listado cuáles
          se saltaron.
        </p>
      </div>
    </label>
  );
}
