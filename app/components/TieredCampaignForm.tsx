// Formulario compartido de campañas escalonadas (TIERED).
// Lo usan tanto la ruta de creación como la de edición: la única diferencia
// entre ambas son los valores iniciales y las etiquetas de los botones.

import { useState } from "react";
import { Form, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Btn } from "./Btn";
import { ItemPicker, type PickerItem } from "./ItemPicker";
import {
  Section,
  FieldGroup,
  ProductChips,
  StringChips,
  CollectionChips,
  inputStyle,
  inputErrorStyle,
  ActionBar,
  GeneralErrorBanner,
} from "./CampaignFormShared";
import {
  buildPreviewRows,
  normalizeTiers,
  validateTiers,
  type Tier,
  type TierMode,
} from "../lib/discounts/tiered-calc";
import type { TieredSelectionMode } from "../lib/discounts/tiered-client";
import { es } from "../i18n";

// Precio de referencia del preview. La tabla es ilustrativa: el cálculo real
// usa esta misma función pura, pero con los precios reales del carrito.
export const PRECIO_EJEMPLO = 100;

export type TieredFormErrors = {
  name?: string;
  selection?: string;
  tiers?: string;
  dates?: string;
  general?: string;
};

export type ProductItem = { id: string; title: string; variants: Array<{ id: string }> };
export type CollectionItem = { id: string; title: string };

export type TieredFormInitial = {
  name: string;
  mode: TierMode;
  tiers: Tier[];
  selectionMode: TieredSelectionMode;
  products: ProductItem[];
  collections: CollectionItem[];
  tags: string[];
  vendors: string[];
  types: string[];
  startsAt: string;
  endsAt: string;
};

const SELECTION_MODES: Array<{ value: TieredSelectionMode; label: string }> = [
  { value: "products", label: "Productos específicos" },
  { value: "collections", label: "Colecciones" },
  { value: "tags", label: "Tags" },
  { value: "vendors", label: "Vendedor" },
  { value: "productTypes", label: "Tipo de producto" },
  { value: "all", label: "Toda la tienda" },
];

const money = (n: number) =>
  `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function TieredCampaignForm({
  initial,
  availableTags,
  availableVendors,
  availableProductTypes,
  errors,
  limitExceeded,
  isSubmitting,
  showDraftButton,
  primaryLabel,
}: {
  initial: TieredFormInitial;
  availableTags: string[];
  availableVendors: string[];
  availableProductTypes: string[];
  errors: TieredFormErrors;
  limitExceeded?: boolean;
  isSubmitting: boolean;
  showDraftButton: boolean;
  primaryLabel: string;
}) {
  const shopify = useAppBridge();

  const [name, setName] = useState(initial.name);
  const [mode, setMode] = useState<TierMode>(initial.mode);
  const [tiers, setTiers] = useState<Tier[]>(initial.tiers);
  const [selectionMode, setSelectionMode] = useState<TieredSelectionMode>(initial.selectionMode);
  const [products, setProducts] = useState<ProductItem[]>(initial.products);
  const [collections, setCollections] = useState<CollectionItem[]>(initial.collections);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [vendors, setVendors] = useState<string[]>(initial.vendors);
  const [types, setTypes] = useState<string[]>(initial.types);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const [pickerMode, setPickerMode] = useState<"tags" | "vendors" | "productTypes" | null>(null);

  const tierWarnings = validateTiers(tiers).warnings;

  const pickProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: products.map((p) => ({ id: p.id })),
    });
    if (selected)
      setProducts(
        selected.map((p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
          id: p.id,
          title: p.title,
          variants: p.variants ?? [],
        }))
      );
  };

  const pickCollections = async () => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: collections.map((c) => ({ id: c.id })),
    });
    if (selected)
      setCollections(
        (selected as Array<{ id: string; title: string }>).map((c) => ({
          id: c.id,
          title: c.title,
        }))
      );
  };

  const updateTier = (index: number, patch: Partial<Tier>) =>
    setTiers((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  const addTier = () =>
    setTiers((prev) => {
      const last = prev[prev.length - 1];
      return [
        ...prev,
        { minQty: (last?.minQty ?? 0) + 1, percent: Math.min(99, (last?.percent ?? 5) + 5) },
      ];
    });

  const removeTier = (index: number) =>
    setTiers((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

  const modeCardStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    border: `1px solid ${active ? "#008060" : "#c9cccf"}`,
    background: active ? "#f1f8f5" : "#fff",
    borderRadius: "8px",
    padding: "12px 14px",
    cursor: "pointer",
    textAlign: "left",
  });

  return (
    <>
      {errors.general && (
        <GeneralErrorBanner message={errors.general} limitExceeded={limitExceeded} />
      )}

      <Form method="post">
        {/* Estado serializado para el action */}
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="selectionMode" value={selectionMode} />
        <input type="hidden" name="tiersJson" value={JSON.stringify(tiers)} />
        <input
          type="hidden"
          name="productsJson"
          value={JSON.stringify(products.map((p) => ({ id: p.id })))}
        />
        <input
          type="hidden"
          name="collectionIdsJson"
          value={JSON.stringify(collections.map((c) => c.id))}
        />
        <input type="hidden" name="tagsJson" value={JSON.stringify(tags)} />
        <input type="hidden" name="vendorsJson" value={JSON.stringify(vendors)} />
        <input type="hidden" name="typesJson" value={JSON.stringify(types)} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            gap: "24px",
            alignItems: "start",
          }}
        >
          <div>
            <Section title={es.nuevaTiered.secInfoGeneral} defaultOpen>
              <FieldGroup
                label={es.nuevaTiered.nombreLabel}
                helper={es.nuevaTiered.nombreHelper}
                error={errors.name}
              >
                <input
                  name="name"
                  type="text"
                  placeholder={es.nuevaTiered.nombrePlaceholder}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={errors.name ? inputErrorStyle : inputStyle}
                />
              </FieldGroup>
            </Section>

            <Section title={es.nuevaTiered.secAplicabilidad} defaultOpen>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                  marginTop: "8px",
                  alignItems: "flex-end",
                }}
              >
                <FieldGroup label={es.nuevaTiered.modoLabel}>
                  <select
                    value={selectionMode}
                    onChange={(e) => setSelectionMode(e.target.value as TieredSelectionMode)}
                    style={inputStyle}
                  >
                    {SELECTION_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </FieldGroup>
                <div>
                  {selectionMode === "products" && (
                    <button
                      type="button"
                      onClick={pickProducts}
                      style={{ ...inputStyle, cursor: "pointer", textAlign: "left" }}
                    >
                      Seleccionar productos
                    </button>
                  )}
                  {selectionMode === "collections" && (
                    <button
                      type="button"
                      onClick={pickCollections}
                      style={{ ...inputStyle, cursor: "pointer", textAlign: "left" }}
                    >
                      Seleccionar colecciones
                    </button>
                  )}
                  {selectionMode === "tags" && (
                    <button
                      type="button"
                      onClick={() => setPickerMode("tags")}
                      style={{ ...inputStyle, cursor: "pointer", textAlign: "left" }}
                    >
                      Seleccionar tags
                    </button>
                  )}
                  {selectionMode === "vendors" && (
                    <button
                      type="button"
                      onClick={() => setPickerMode("vendors")}
                      style={{ ...inputStyle, cursor: "pointer", textAlign: "left" }}
                    >
                      Seleccionar vendedores
                    </button>
                  )}
                  {selectionMode === "productTypes" && (
                    <button
                      type="button"
                      onClick={() => setPickerMode("productTypes")}
                      style={{ ...inputStyle, cursor: "pointer", textAlign: "left" }}
                    >
                      Seleccionar tipos
                    </button>
                  )}
                </div>
              </div>

              {errors.selection && (
                <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>
                  {errors.selection}
                </p>
              )}

              {selectionMode === "products" && (
                <ProductChips
                  products={products.map((p) => ({
                    id: p.id,
                    title: p.title,
                    variantCount: p.variants.length,
                  }))}
                  onRemove={(id) => setProducts((prev) => prev.filter((p) => p.id !== id))}
                />
              )}
              {selectionMode === "collections" && (
                <CollectionChips
                  collections={collections}
                  onRemove={(id) => setCollections((prev) => prev.filter((c) => c.id !== id))}
                />
              )}
              {selectionMode === "tags" && (
                <StringChips values={tags} onRemove={(t) => setTags((v) => v.filter((x) => x !== t))} />
              )}
              {selectionMode === "vendors" && (
                <StringChips
                  values={vendors}
                  onRemove={(v) => setVendors((a) => a.filter((x) => x !== v))}
                />
              )}
              {selectionMode === "productTypes" && (
                <StringChips
                  values={types}
                  onRemove={(t) => setTypes((a) => a.filter((x) => x !== t))}
                />
              )}
              {selectionMode === "all" && (
                <div
                  style={{
                    marginTop: "12px",
                    background: "#f1f8f5",
                    border: "1px solid #b5e3d8",
                    borderRadius: "6px",
                    padding: "10px 14px",
                    fontSize: "13px",
                    color: "#007a5a",
                  }}
                >
                  ✓ {es.nuevaTiered.msgTodaTienda}
                </div>
              )}
            </Section>

            <Section title={es.nuevaTiered.secModo} defaultOpen>
              <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                {(["UNIFORM", "INCREMENTAL"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    style={modeCardStyle(mode === m)}
                  >
                    <span
                      style={{
                        display: "block",
                        fontSize: "14px",
                        fontWeight: 600,
                        color: "#202223",
                        marginBottom: "4px",
                      }}
                    >
                      {mode === m ? "◉" : "○"}{" "}
                      {m === "UNIFORM" ? es.nuevaTiered.modoUniforme : es.nuevaTiered.modoIncremental}
                    </span>
                    <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                      {m === "UNIFORM"
                        ? es.nuevaTiered.modoUniformeDesc
                        : es.nuevaTiered.modoIncrementalDesc}
                    </span>
                  </button>
                ))}
              </div>
              <ModeExplainer mode={mode} tiers={tiers} />
            </Section>

            <Section title={es.nuevaTiered.secNiveles} defaultOpen>
              <p style={{ fontSize: "12px", color: "#6d7175", margin: "8px 0 12px" }}>
                {es.nuevaTiered.nivelesHelper}
              </p>

              {tiers.map((tier, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 40px",
                    gap: "10px",
                    alignItems: "center",
                    marginBottom: "8px",
                  }}
                >
                  <div style={{ display: "flex" }}>
                    <span
                      style={{
                        background: "#f1f2f3",
                        border: "1px solid #c9cccf",
                        borderRight: "none",
                        borderRadius: "6px 0 0 6px",
                        padding: "8px 10px",
                        fontSize: "13px",
                        color: "#6d7175",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {es.nuevaTiered.nivelDesde}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={tier.minQty}
                      onChange={(e) => updateTier(i, { minQty: Math.max(1, Number(e.target.value)) })}
                      style={{ ...inputStyle, borderRadius: 0, flex: 1, minWidth: 0 }}
                    />
                    <span
                      style={{
                        background: "#f1f2f3",
                        border: "1px solid #c9cccf",
                        borderLeft: "none",
                        borderRadius: "0 6px 6px 0",
                        padding: "8px 10px",
                        fontSize: "13px",
                        color: "#6d7175",
                        whiteSpace: "nowrap",
                      }}
                    >
                      uds.
                    </span>
                  </div>

                  <div style={{ display: "flex" }}>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={tier.percent}
                      onChange={(e) =>
                        updateTier(i, { percent: Math.max(1, Math.min(99, Number(e.target.value))) })
                      }
                      style={{ ...inputStyle, borderRadius: "6px 0 0 6px", flex: 1, minWidth: 0 }}
                    />
                    <span
                      style={{
                        background: "#f1f2f3",
                        border: "1px solid #c9cccf",
                        borderLeft: "none",
                        borderRadius: "0 6px 6px 0",
                        padding: "8px 12px",
                        fontSize: "14px",
                        color: "#6d7175",
                      }}
                    >
                      %
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeTier(i)}
                    disabled={tiers.length <= 1}
                    title={es.nuevaTiered.btnQuitarNivel}
                    style={{
                      background: "#fff",
                      border: "1px solid #c9cccf",
                      borderRadius: "6px",
                      padding: "8px 0",
                      cursor: tiers.length <= 1 ? "not-allowed" : "pointer",
                      color: tiers.length <= 1 ? "#c9cccf" : "#d82c0d",
                      fontSize: "14px",
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={addTier}
                style={{
                  background: "#fff",
                  border: "1px solid #c9cccf",
                  borderRadius: "6px",
                  padding: "7px 14px",
                  fontSize: "13px",
                  cursor: "pointer",
                  color: "#202223",
                  marginTop: "4px",
                }}
              >
                {es.nuevaTiered.btnAgregarNivel}
              </button>

              {errors.tiers && (
                <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "10px" }}>{errors.tiers}</p>
              )}
              {tierWarnings.map((w) => (
                <p key={w} style={{ fontSize: "12px", color: "#8b5e00", marginTop: "8px" }}>
                  ⚠ {w}
                </p>
              ))}
            </Section>

            <Section title={es.nuevaTiered.secProgramacion} defaultOpen={false}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                  marginTop: "8px",
                }}
              >
                <FieldGroup
                  label={es.nuevaTiered.fechaInicioLabel}
                  helper={es.nuevaTiered.fechaInicioHelper}
                >
                  <input
                    type="datetime-local"
                    name="startsAt"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    style={inputStyle}
                  />
                </FieldGroup>
                <FieldGroup
                  label={es.nuevaTiered.fechaFinLabel}
                  helper={es.nuevaTiered.fechaFinHelper}
                  error={errors.dates}
                >
                  <input
                    type="datetime-local"
                    name="endsAt"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    style={inputStyle}
                  />
                </FieldGroup>
              </div>
            </Section>
          </div>

          <div style={{ position: "sticky", top: "24px" }}>
            <TieredPreview
              name={name}
              mode={mode}
              tiers={tiers}
              selectionMode={selectionMode}
              productCount={products.length}
              startsAt={startsAt}
              endsAt={endsAt}
            />
          </div>
        </div>

        <ActionBar>
          <Link
            to="/app/campaigns"
            style={{ color: "#6d7175", fontSize: "14px", textDecoration: "none", padding: "8px 4px" }}
          >
            {es.nuevaTiered.btnCancelar}
          </Link>
          <div style={{ marginLeft: "auto", display: "flex", gap: "10px" }}>
            {showDraftButton && (
              <Btn
                type="submit"
                name="intent"
                value="draft"
                variant="secondary"
                size="md"
                disabled={isSubmitting}
              >
                {es.nuevaTiered.btnBorrador}
              </Btn>
            )}
            <Btn
              type="submit"
              name="intent"
              value="activate"
              variant="primary"
              size="md"
              disabled={isSubmitting}
              style={isSubmitting ? { background: "#4d9e8a" } : undefined}
            >
              {isSubmitting ? es.nuevaTiered.btnCargando : primaryLabel}
            </Btn>
          </div>
        </ActionBar>
      </Form>

      <ItemPicker
        open={pickerMode === "tags"}
        title="Seleccionar tags"
        items={availableTags.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={tags}
        onConfirm={(ids) => { setTags(ids); setPickerMode(null); }}
        onCancel={() => setPickerMode(null)}
      />
      <ItemPicker
        open={pickerMode === "vendors"}
        title="Seleccionar vendedores"
        items={availableVendors.map((v): PickerItem => ({ id: v, label: v }))}
        selectedIds={vendors}
        onConfirm={(ids) => { setVendors(ids); setPickerMode(null); }}
        onCancel={() => setPickerMode(null)}
      />
      <ItemPicker
        open={pickerMode === "productTypes"}
        title="Seleccionar tipos"
        items={availableProductTypes.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={types}
        onConfirm={(ids) => { setTypes(ids); setPickerMode(null); }}
        onCancel={() => setPickerMode(null)}
      />
    </>
  );
}

// ─── Preview ──────────────────────────────────────────────────────────────────

function TieredPreview({
  name,
  mode,
  tiers,
  selectionMode,
  productCount,
  startsAt,
  endsAt,
}: {
  name: string;
  mode: TierMode;
  tiers: Tier[];
  selectionMode: TieredSelectionMode;
  productCount: number;
  startsAt: string;
  endsAt: string;
}) {
  // El preview NO replica la lógica: ejecuta la misma función que la Function.
  const rows = buildPreviewRows(mode, tiers, PRECIO_EJEMPLO);
  const sorted = normalizeTiers(tiers);
  const maxPercent = sorted.length ? sorted[sorted.length - 1].percent : 0;

  const aplicaDesc =
    selectionMode === "all"
      ? "Toda la tienda"
      : selectionMode === "products"
      ? productCount > 0
        ? `${productCount} producto${productCount !== 1 ? "s" : ""}`
        : es.nuevaTiered.sinDefinir
      : selectionMode === "collections"
      ? "Colecciones"
      : selectionMode === "tags"
      ? "Tags"
      : selectionMode === "vendors"
      ? "Vendedor"
      : "Tipo de producto";

  const summaryRows = [
    { label: es.nuevaTiered.resumenNombre, value: name || es.nuevaTiered.sinDefinir },
    { label: es.nuevaTiered.resumenTipo, value: es.nuevaTiered.resumenTipoTiered },
    {
      label: es.nuevaTiered.resumenModo,
      value: mode === "UNIFORM" ? es.nuevaTiered.modoUniforme : es.nuevaTiered.modoIncremental,
    },
    { label: es.nuevaTiered.resumenAplica, value: aplicaDesc },
    { label: es.nuevaTiered.resumenNiveles, value: String(sorted.length) },
    { label: es.nuevaTiered.resumenMaximo, value: maxPercent ? `${maxPercent}%` : "—" },
    {
      label: es.nuevaTiered.resumenInicio,
      value: startsAt
        ? new Date(startsAt).toLocaleDateString("es-MX")
        : es.nuevaTiered.resumenInmediato,
    },
    {
      label: es.nuevaTiered.resumenFin,
      value: endsAt ? new Date(endsAt).toLocaleDateString("es-MX") : es.nuevaTiered.resumenSinFin,
    },
  ];

  const cellStyle: React.CSSProperties = {
    padding: "7px 8px",
    fontSize: "13px",
    borderBottom: "1px solid #f1f2f3",
  };

  return (
    <>
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
            marginBottom: "4px",
          }}
        >
          {es.nuevaTiered.previewTitulo}
        </p>
        <p style={{ fontSize: "11px", color: "#8c9196", marginBottom: "12px" }}>
          {es.nuevaTiered.previewHelper(money(PRECIO_EJEMPLO))}
        </p>

        {rows.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#8c9196" }}>
            Agrega al menos un nivel para ver la vista previa.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...cellStyle, textAlign: "left", color: "#6d7175", fontWeight: 500 }}>
                  {es.nuevaTiered.previewCantidad}
                </th>
                <th style={{ ...cellStyle, textAlign: "right", color: "#6d7175", fontWeight: 500 }}>
                  {es.nuevaTiered.previewDescuento}
                </th>
                <th style={{ ...cellStyle, textAlign: "right", color: "#6d7175", fontWeight: 500 }}>
                  {es.nuevaTiered.previewPaga}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.quantity}>
                  <td style={cellStyle}>
                    {r.quantity}
                    {r.isBeyondLastTier ? "+" : ""}
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right", color: "#008060", fontWeight: 600 }}>
                    {r.percent}%
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right", fontWeight: 500 }}>
                    {money(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div
          style={{
            marginTop: "12px",
            background: "#fff8e1",
            border: "1px solid #ffe0a3",
            borderRadius: "6px",
            padding: "9px 12px",
            fontSize: "12px",
            color: "#8b5e00",
            lineHeight: 1.4,
          }}
        >
          {es.nuevaTiered.avisoCarrito}
        </div>
      </div>

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
          {es.nuevaTiered.resumenTitulo}
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

/**
 * Explica la diferencia entre modos con LOS NIVELES REALES del merchant y
 * números concretos. Es la forma más rápida de que entienda que los mismos
 * niveles producen dos totales distintos.
 */
function ModeExplainer({ mode, tiers }: { mode: TierMode; tiers: Tier[] }) {
  const rows = buildPreviewRows(mode, tiers, PRECIO_EJEMPLO);
  if (rows.length === 0) return null;

  // Se usa la fila del último nivel definido (la última es la fila "N+").
  const row = rows[Math.max(0, rows.length - 2)];
  const percents = normalizeTiers(tiers)
    .map((t) => `${t.percent}%`)
    .join(", ");

  const texto =
    mode === "UNIFORM"
      ? `Al llegar a ${row.quantity} unidades, las ${row.quantity} quedan al ${row.percent}%. ${row.quantity} × ${money(PRECIO_EJEMPLO)} → paga ${money(row.total)}.`
      : `Cada unidad lleva su propio descuento (${percents}). ${row.quantity} × ${money(PRECIO_EJEMPLO)} → paga ${money(row.total)}.`;

  return (
    <div
      style={{
        marginTop: "12px",
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "6px",
        padding: "10px 14px",
        fontSize: "13px",
        color: "#202223",
        lineHeight: 1.5,
      }}
    >
      {texto}
    </div>
  );
}
