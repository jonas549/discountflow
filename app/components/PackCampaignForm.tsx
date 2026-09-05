// Formulario compartido de campañas PACK (packs armables por el comprador).
// Lo usan tanto la ruta de creación como la de edición: la única diferencia
// entre ambas son los valores iniciales y las etiquetas de los botones.

import { useState } from "react";
import { Form, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Btn } from "./Btn";
import {
  Section,
  FieldGroup,
  inputStyle,
  inputErrorStyle,
  ActionBar,
  GeneralErrorBanner,
  DecimalInput,
} from "./CampaignFormShared";
import {
  buildPackPreview,
  normalizePackCatalog,
  normalizePackTiers,
  packMinimumProducts,
  validatePack,
  MIN_PACK_PERCENT,
  MAX_PACK_PERCENT,
  MIN_PACK_PRODUCTS,
  MAX_PACK_CATALOG,
  type PackMode,
  type PackTier,
  type PackApplicableLine,
} from "../lib/discounts/pack-calc";
import type { PackFormProduct } from "../lib/discounts/pack-form";
import { es } from "../i18n";

/** Precio de referencia del preview cuando el producto todavía no tiene foto. */
const PRECIO_EJEMPLO = 100;

export type PackFormErrors = {
  name?: string;
  selection?: string;
  discount?: string;
  dates?: string;
  general?: string;
};

export type PackFormInitial = {
  name: string;
  heading: string;
  mode: PackMode;
  products: PackFormProduct[];
  tiers: PackTier[];
  startsAt: string;
  endsAt: string;
};

const money = (n: number) =>
  `$${n.toLocaleString("es-CL", { maximumFractionDigits: 2 })}`;

export function PackCampaignForm({
  initial,
  errors,
  limitExceeded,
  overlapWarning,
  isSubmitting,
  showDraftButton,
  primaryLabel,
}: {
  initial: PackFormInitial;
  errors: PackFormErrors;
  limitExceeded?: boolean;
  /** Aviso de que otra campaña activa ya cubre parte del catálogo. No bloquea. */
  overlapWarning?: string;
  isSubmitting: boolean;
  showDraftButton: boolean;
  primaryLabel: string;
}) {
  const shopify = useAppBridge();

  const [name, setName] = useState(initial.name);
  const [heading, setHeading] = useState(initial.heading);
  const [mode, setMode] = useState<PackMode>(initial.mode);
  const [products, setProducts] = useState<PackFormProduct[]>(initial.products);
  const [tiers, setTiers] = useState<PackTier[]>(initial.tiers);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);

  /**
   * Los errores del servidor se ocultan en cuanto el merchant toca el campo que
   * los provocó. Sin esto el formulario parece trancado: los mensajes vienen de
   * `actionData`, que React Router conserva hasta el siguiente envío, y nada los
   * recalcula. Es el bug que se arregló el 2026-08-08 en los otros formularios.
   */
  const [tocado, setTocado] = useState<Record<string, boolean>>({});
  const err = (k: keyof PackFormErrors) => (tocado[k] ? undefined : errors[k]);
  const marcar = (k: keyof PackFormErrors) =>
    setTocado((t) => (t[k] ? t : { ...t, [k]: true }));

  const esPorTamano = mode === "PACK_SIZE";

  const catalogo = normalizePackCatalog(
    products.map((p) =>
      esPorTamano ? { productId: p.id } : { productId: p.id, percent: p.percent }
    )
  );
  const nivelesNormalizados = normalizePackTiers(tiers);
  const advertencias = validatePack(mode, catalogo, nivelesNormalizados).warnings;
  const minimo = packMinimumProducts(mode, nivelesNormalizados);

  const pickProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: products.map((p) => ({ id: p.id })),
    });
    if (!selected) return;
    marcar("selection");
    // Se conserva el % ya escrito de los productos que siguen elegidos: volver a
    // abrir el picker para sumar uno no puede borrar el trabajo anterior.
    const previos = new Map(products.map((p) => [p.id, p.percent]));
    setProducts(
      (selected as Array<{ id: string; title: string }>).map((p) => ({
        id: p.id,
        title: p.title,
        percent: previos.get(p.id) ?? 10,
      }))
    );
  };

  const actualizarProducto = (id: string, percent: number) =>
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, percent } : p)));

  const quitarProducto = (id: string) =>
    setProducts((prev) => prev.filter((p) => p.id !== id));

  const actualizarNivel = (i: number, patch: Partial<PackTier>) =>
    setTiers((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const agregarNivel = () =>
    setTiers((prev) => {
      const ultimo = prev[prev.length - 1];
      return [
        ...prev,
        {
          minProducts: (ultimo?.minProducts ?? MIN_PACK_PRODUCTS - 1) + 1,
          percent: Math.min(MAX_PACK_PERCENT, (ultimo?.percent ?? 0) + 10),
        },
      ];
    });

  const quitarNivel = (i: number) =>
    setTiers((prev) => prev.filter((_, j) => j !== i));

  // ── Preview ───────────────────────────────────────────────────────────────
  //
  // Arma un pack de ejemplo con los primeros productos de la lista, usando la
  // MISMA función pura que la Function del checkout. Si este número y el del
  // carrito difieren, es que alguien dejó de usar `pack-calc.ts` en un lado.
  const cuantosPreview = Math.min(
    products.length,
    Math.max(minimo, esPorTamano ? nivelesNormalizados.length + 1 : MIN_PACK_PRODUCTS)
  );
  const lineasPreview: PackApplicableLine[] = products
    .slice(0, cuantosPreview)
    .map((p, i) => ({
      lineId: `preview-${i}`,
      productId: p.id,
      unitPrice: PRECIO_EJEMPLO,
      quantity: 1,
    }));
  const preview = buildPackPreview(
    mode,
    catalogo,
    nivelesNormalizados,
    lineasPreview
  );

  const maximoDescuento = esPorTamano
    ? nivelesNormalizados.reduce((m, t) => Math.max(m, t.percent), 0)
    : catalogo.reduce((m, p) => Math.max(m, p.percent ?? 0), 0);

  return (
    <Form method="post">
      {/* Campos derivados del estado en cada render: no hay forma de que el
          formulario mande algo distinto de lo que se ve en pantalla. */}
      <input type="hidden" name="mode" value={mode} />
      <input
        type="hidden"
        name="productsJson"
        value={JSON.stringify(products)}
      />
      <input type="hidden" name="tiersJson" value={JSON.stringify(tiers)} />

      {errors.general && (
        <GeneralErrorBanner message={errors.general} limitExceeded={limitExceeded} />
      )}

      {overlapWarning && (
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #f9a825",
            borderRadius: "8px",
            padding: "12px 16px",
            color: "#a05c00",
            fontSize: "14px",
            marginBottom: "16px",
          }}
        >
          {overlapWarning}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: "20px", alignItems: "start" }}>
        <div>
          {/* ── 1 · Información general ── */}
          <Section title={es.nuevoPack.secInfoGeneral}>
            <FieldGroup
              label={es.nuevoPack.nombreLabel}
              helper={es.nuevoPack.nombreHelper}
              error={err("name")}
            >
              <input
                type="text"
                name="name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  marcar("name");
                }}
                placeholder={es.nuevoPack.nombrePlaceholder}
                style={err("name") ? inputErrorStyle : inputStyle}
              />
            </FieldGroup>

            <FieldGroup
              label={es.nuevoPack.headingLabel}
              helper={es.nuevoPack.headingHelper}
            >
              <input
                type="text"
                name="heading"
                value={heading}
                onChange={(e) => setHeading(e.target.value)}
                placeholder={es.nuevoPack.headingPorDefecto}
                style={inputStyle}
              />
            </FieldGroup>
          </Section>

          {/* ── 2 · Modo ── */}
          <Section title={es.nuevoPack.secModo}>
            <div style={{ display: "grid", gap: "10px", marginTop: "12px" }}>
              {(
                [
                  ["PER_PRODUCT", es.nuevoPack.modoPorProducto, es.nuevoPack.modoPorProductoDesc],
                  ["PACK_SIZE", es.nuevoPack.modoPorTamano, es.nuevoPack.modoPorTamanoDesc],
                ] as const
              ).map(([valor, titulo, desc]) => (
                <label
                  key={valor}
                  style={{
                    display: "flex",
                    gap: "10px",
                    alignItems: "flex-start",
                    border: `1px solid ${mode === valor ? "#008060" : "#e1e3e5"}`,
                    background: mode === valor ? "#f1f8f5" : "#fff",
                    borderRadius: "8px",
                    padding: "12px 14px",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    checked={mode === valor}
                    onChange={() => {
                      setMode(valor);
                      marcar("discount");
                    }}
                    style={{ marginTop: "3px" }}
                  />
                  <span>
                    <span style={{ display: "block", fontSize: "14px", fontWeight: 500 }}>
                      {titulo}
                    </span>
                    <span style={{ display: "block", fontSize: "12.5px", color: "#6d7175", marginTop: "2px" }}>
                      {desc}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Section>

          {/* ── 3 · Productos ── */}
          <Section title={es.nuevoPack.secProductos}>
            <p style={{ fontSize: "12.5px", color: "#6d7175", marginTop: "12px" }}>
              {es.nuevoPack.productosHelper}
            </p>

            <div style={{ marginTop: "12px" }}>
              <Btn type="button" variant="secondary" size="md" onClick={pickProducts}>
                {es.nuevoPack.btnElegirProductos}
              </Btn>
              <span style={{ fontSize: "12.5px", color: "#8c9196", marginLeft: "10px" }}>
                {products.length}/{MAX_PACK_CATALOG}
              </span>
            </div>

            {err("selection") && (
              <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>
                {err("selection")}
              </p>
            )}

            {products.length === 0 ? (
              <p style={{ fontSize: "13px", color: "#8c9196", marginTop: "14px" }}>
                {es.nuevoPack.sinProductos}
              </p>
            ) : (
              <table style={{ width: "100%", marginTop: "14px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ fontSize: "12px", color: "#6d7175", textAlign: "left" }}>
                    <th style={{ padding: "6px 0", fontWeight: 500 }}>
                      {es.nuevoPack.columnaProducto}
                    </th>
                    {!esPorTamano && (
                      <th style={{ padding: "6px 0", fontWeight: 500, width: "130px" }}>
                        {es.nuevoPack.columnaDescuento}
                      </th>
                    )}
                    <th style={{ width: "70px" }} />
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id} style={{ borderTop: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "8px 0", fontSize: "13.5px" }}>{p.title}</td>
                      {!esPorTamano && (
                        <td style={{ padding: "8px 0" }}>
                          <div style={{ display: "flex", alignItems: "stretch" }}>
                            {/* Buffer de texto, no `type="number"`: el input
                                numérico controlado devuelve cadena vacía a medio
                                escribir un decimal y borra lo tecleado. */}
                            <DecimalInput
                              value={p.percent}
                              onChange={(v) =>
                                actualizarProducto(
                                  p.id,
                                  Math.max(MIN_PACK_PERCENT, Math.min(MAX_PACK_PERCENT, v))
                                )
                              }
                              style={{
                                ...inputStyle,
                                borderRadius: "6px 0 0 6px",
                                width: "80px",
                              }}
                            />
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                padding: "0 10px",
                                border: "1px solid #c9cccf",
                                borderLeft: "none",
                                borderRadius: "0 6px 6px 0",
                                background: "#f6f6f7",
                                fontSize: "13px",
                                color: "#6d7175",
                              }}
                            >
                              %
                            </span>
                          </div>
                        </td>
                      )}
                      <td style={{ padding: "8px 0", textAlign: "right" }}>
                        <Btn
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => quitarProducto(p.id)}
                        >
                          {es.nuevoPack.quitarProducto}
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* ── 4 · Niveles (solo modo por tamaño) ── */}
          {esPorTamano && (
            <Section title={es.nuevoPack.secNiveles}>
              <p style={{ fontSize: "12.5px", color: "#6d7175", marginTop: "12px" }}>
                {es.nuevoPack.nivelesHelper}
              </p>

              {err("discount") && (
                <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>
                  {err("discount")}
                </p>
              )}

              <div style={{ marginTop: "12px", display: "grid", gap: "8px" }}>
                {tiers.map((tier, i) => (
                  <div key={i} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <span style={{ fontSize: "13px", color: "#6d7175", minWidth: "48px" }}>
                      {es.nuevoPack.nivelDesde}
                    </span>
                    <input
                      type="number"
                      min={MIN_PACK_PRODUCTS}
                      value={tier.minProducts}
                      onChange={(e) => {
                        actualizarNivel(i, {
                          minProducts: Math.max(
                            MIN_PACK_PRODUCTS,
                            Math.floor(Number(e.target.value) || MIN_PACK_PRODUCTS)
                          ),
                        });
                        marcar("discount");
                      }}
                      style={{ ...inputStyle, width: "80px" }}
                    />
                    <span style={{ fontSize: "13px", color: "#6d7175" }}>
                      {es.nuevoPack.nivelProductos}
                    </span>
                    <div style={{ display: "flex", alignItems: "stretch", marginLeft: "auto" }}>
                      <DecimalInput
                        value={tier.percent}
                        onChange={(v) => {
                          actualizarNivel(i, {
                            percent: Math.max(
                              MIN_PACK_PERCENT,
                              Math.min(MAX_PACK_PERCENT, v)
                            ),
                          });
                          marcar("discount");
                        }}
                        style={{ ...inputStyle, borderRadius: "6px 0 0 6px", width: "80px" }}
                      />
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "0 10px",
                          border: "1px solid #c9cccf",
                          borderLeft: "none",
                          borderRadius: "0 6px 6px 0",
                          background: "#f6f6f7",
                          fontSize: "13px",
                          color: "#6d7175",
                        }}
                      >
                        %
                      </span>
                    </div>
                    <Btn
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => quitarNivel(i)}
                    >
                      ×
                    </Btn>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: "10px" }}>
                <Btn type="button" variant="secondary" size="sm" onClick={agregarNivel}>
                  {es.nuevoPack.btnAgregarNivel}
                </Btn>
              </div>
            </Section>
          )}

          {!esPorTamano && err("discount") && (
            <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "-8px", marginBottom: "16px" }}>
              {err("discount")}
            </p>
          )}

          {/* ── 5 · Programación ── */}
          <Section title={es.nuevoPack.secProgramacion} defaultOpen={false}>
            <FieldGroup
              label={es.nuevoPack.fechaInicioLabel}
              helper={es.nuevoPack.fechaInicioHelper}
              error={err("dates")}
            >
              <input
                type="datetime-local"
                name="startsAt"
                value={startsAt}
                onChange={(e) => {
                  setStartsAt(e.target.value);
                  marcar("dates");
                }}
                style={inputStyle}
              />
            </FieldGroup>
            <FieldGroup
              label={es.nuevoPack.fechaFinLabel}
              helper={es.nuevoPack.fechaFinHelper}
            >
              <input
                type="datetime-local"
                name="endsAt"
                value={endsAt}
                onChange={(e) => {
                  setEndsAt(e.target.value);
                  marcar("dates");
                }}
                style={inputStyle}
              />
            </FieldGroup>
          </Section>
        </div>

        {/* ── Panel lateral: preview + resumen ── */}
        <div style={{ position: "sticky", top: "12px" }}>
          <div
            style={{
              border: "1px solid #e1e3e5",
              borderRadius: "10px",
              background: "#fff",
              padding: "16px 18px",
              marginBottom: "16px",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>
              {es.nuevoPack.previewTitulo}
            </h3>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>
              {es.nuevoPack.previewHelper}
            </p>

            {lineasPreview.length === 0 ? (
              <p style={{ fontSize: "13px", color: "#8c9196", marginTop: "12px" }}>
                {es.nuevoPack.sinProductos}
              </p>
            ) : !preview.applies ? (
              <p style={{ fontSize: "13px", color: "#8c9196", marginTop: "12px" }}>
                {es.nuevoPack.previewSinDescuento(
                  Math.max(1, minimo - preview.distinctProducts)
                )}
              </p>
            ) : (
              <table style={{ width: "100%", marginTop: "12px", fontSize: "13px" }}>
                <tbody>
                  <tr>
                    <td style={{ color: "#6d7175", padding: "3px 0" }}>
                      {es.nuevoPack.previewSubtotal}
                    </td>
                    <td style={{ textAlign: "right" }}>{money(preview.subtotal)}</td>
                  </tr>
                  <tr>
                    <td style={{ color: "#008060", padding: "3px 0" }}>
                      {es.nuevoPack.previewAhorro}
                      {preview.appliedPercent !== null && ` (${preview.appliedPercent}%)`}
                    </td>
                    <td style={{ textAlign: "right", color: "#008060" }}>
                      −{money(preview.savings)}
                    </td>
                  </tr>
                  <tr style={{ borderTop: "1px solid #f1f2f3" }}>
                    <td style={{ padding: "6px 0", fontWeight: 600 }}>
                      {es.nuevoPack.previewTotal}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>
                      {money(preview.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div
            style={{
              border: "1px solid #e1e3e5",
              borderRadius: "10px",
              background: "#fff",
              padding: "16px 18px",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>
              {es.nuevoPack.resumenTitulo}
            </h3>
            <dl style={{ margin: "12px 0 0", fontSize: "13px" }}>
              {(
                [
                  [es.nuevoPack.resumenNombre, name || es.nuevoPack.sinDefinir],
                  [es.nuevoPack.resumenTipo, es.nuevoPack.resumenTipoPack],
                  [
                    es.nuevoPack.resumenModo,
                    esPorTamano ? es.nuevoPack.modoPorTamano : es.nuevoPack.modoPorProducto,
                  ],
                  [es.nuevoPack.resumenProductos, String(products.length)],
                  [es.nuevoPack.resumenMinimo, `${minimo} productos`],
                  [es.nuevoPack.resumenMaximo, maximoDescuento > 0 ? `${maximoDescuento}%` : "—"],
                  [es.nuevoPack.resumenInicio, startsAt || es.nuevoPack.resumenInmediato],
                  [es.nuevoPack.resumenFin, endsAt || es.nuevoPack.resumenSinFin],
                ] as const
              ).map(([k, v]) => (
                <div
                  key={k}
                  style={{ display: "flex", justifyContent: "space-between", gap: "10px", padding: "3px 0" }}
                >
                  <dt style={{ color: "#6d7175" }}>{k}</dt>
                  <dd style={{ margin: 0, textAlign: "right" }}>{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {advertencias.length > 0 && (
            <ul
              style={{
                margin: "12px 0 0",
                paddingLeft: "18px",
                fontSize: "12.5px",
                color: "#a05c00",
              }}
            >
              {advertencias.map((w) => (
                <li key={w} style={{ marginBottom: "4px" }}>
                  {w}
                </li>
              ))}
            </ul>
          )}

          <p style={{ fontSize: "12px", color: "#6d7175", marginTop: "12px", lineHeight: 1.5 }}>
            {es.nuevoPack.avisoWidget}
          </p>
          <p style={{ fontSize: "12px", color: "#6d7175", marginTop: "8px", lineHeight: 1.5 }}>
            {es.nuevoPack.avisoCarrito}
          </p>
        </div>
      </div>

      <ActionBar>
        <Btn type="submit" name="intent" value="activate" variant="primary" size="md" disabled={isSubmitting}>
          {isSubmitting ? es.nuevoPack.btnCargando : primaryLabel}
        </Btn>
        {showDraftButton && (
          <Btn type="submit" name="intent" value="draft" variant="secondary" size="md" disabled={isSubmitting}>
            {es.nuevoPack.btnBorrador}
          </Btn>
        )}
        <Link
          to="/app/campaigns"
          style={{ fontSize: "14px", color: "#6d7175", textDecoration: "none", marginLeft: "auto" }}
        >
          {es.nuevoPack.btnCancelar}
        </Link>
      </ActionBar>
    </Form>
  );
}
