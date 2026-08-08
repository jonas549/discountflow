// Formulario compartido de campañas escalonadas (TIERED).
// Lo usan tanto la ruta de creación como la de edición: la única diferencia
// entre ambas son los valores iniciales y las etiquetas de los botones.

import { useEffect, useState } from "react";
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
  MIN_TIER_PERCENT,
  MAX_TIER_PERCENT,
  type Tier,
  type TierMode,
  type TierValueType,
} from "../lib/discounts/tiered-calc";
import type { TieredSelectionMode } from "../lib/discounts/tiered-client";
import { formatDecimalInput, parseDecimalInput } from "../lib/decimal-input";
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
  /** Ausente en las campañas guardadas antes de los montos: se lee como PERCENT. */
  valueType: TierValueType;
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
  const [valueType, setValueType] = useState<TierValueType>(initial.valueType);
  const [tiers, setTiers] = useState<Tier[]>(initial.tiers);
  const esMonto = valueType === "AMOUNT";

  /**
   * Cambiar la unidad reescribe los niveles en vez de arrastrar el campo viejo.
   *
   * Si no, un nivel de "20" en % pasaría a valer "$20" sin que nadie lo haya
   * escrito, y `normalizeTiers` descartaría los que quedaran sin el campo de su
   * tipo — el merchant vería desaparecer sus niveles sin explicación. Se
   * conserva la escalera de cantidades, que es lo que costó configurar, y se
   * ponen los valores a 0 para que se vea que hay que rellenarlos.
   */
  const cambiarUnidad = (siguiente: TierValueType) => {
    if (siguiente === valueType) return;
    setValueType(siguiente);
    setTiers((prev) =>
      prev.map((t) =>
        siguiente === "AMOUNT"
          ? { minQty: t.minQty, amount: 0 }
          : { minQty: t.minQty, percent: 0 }
      )
    );
  };
  const [selectionMode, setSelectionMode] = useState<TieredSelectionMode>(initial.selectionMode);
  const [products, setProducts] = useState<ProductItem[]>(initial.products);
  const [collections, setCollections] = useState<CollectionItem[]>(initial.collections);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [vendors, setVendors] = useState<string[]>(initial.vendors);
  const [types, setTypes] = useState<string[]>(initial.types);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const [pickerMode, setPickerMode] = useState<"tags" | "vendors" | "productTypes" | null>(null);

  const tierWarnings = validateTiers(tiers, { valueType }).warnings;

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
      const minQty = (last?.minQty ?? 0) + 1;
      return [
        ...prev,
        esMonto
          ? { minQty, amount: (last?.amount ?? 0) + 1 }
          : { minQty, percent: Math.min(MAX_TIER_PERCENT, (last?.percent ?? 5) + 5) },
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
        <input type="hidden" name="valueType" value={valueType} />
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
              <ModeExplainer mode={mode} valueType={valueType} tiers={tiers} />
            </Section>

            <Section title={es.nuevaTiered.secNiveles} defaultOpen>
              <p style={{ fontSize: "12px", color: "#6d7175", margin: "8px 0 12px" }}>
                {es.nuevaTiered.nivelesHelper}
              </p>

              {/* Unidad del descuento. Es un eje aparte del modo: el modo dice
                  cómo se reparte y esto en qué se mide. La campaña entera va en
                  una sola unidad — no se mezclan niveles en % con niveles en $. */}
              <div style={{ marginBottom: "14px" }}>
                <span style={{ fontSize: "13px", color: "#42474c", marginRight: "10px" }}>
                  {es.nuevaTiered.unidadLabel}
                </span>
                <div style={{ display: "inline-flex", verticalAlign: "middle" }}>
                  {(["PERCENT", "AMOUNT"] as const).map((v, idx) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => cambiarUnidad(v)}
                      style={{
                        background: valueType === v ? "#008060" : "#fff",
                        color: valueType === v ? "#fff" : "#42474c",
                        border: "1px solid " + (valueType === v ? "#008060" : "#c9cccf"),
                        borderLeft: idx === 1 ? "none" : undefined,
                        borderRadius: idx === 0 ? "6px 0 0 6px" : "0 6px 6px 0",
                        padding: "6px 16px",
                        fontSize: "13px",
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      {v === "PERCENT"
                        ? es.nuevaTiered.unidadPorcentaje
                        : es.nuevaTiered.unidadMonto}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: "12px", color: "#6d7175", margin: "8px 0 0" }}>
                  {esMonto
                    ? es.nuevaTiered.unidadMontoHelper
                    : es.nuevaTiered.unidadPorcentajeHelper}
                </p>
              </div>

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
                    {esMonto ? (
                      // 0 sigue siendo válido: "desde aquí, precio normal". No hay
                      // tope: el monto máximo depende del precio de cada producto,
                      // y de eso avisa el preview.
                      <DecimalInput
                        value={tier.amount ?? 0}
                        onChange={(amount) => updateTier(i, { amount })}
                        style={{ ...inputStyle, borderRadius: "6px 0 0 6px", flex: 1, minWidth: 0 }}
                      />
                    ) : (
                      <input
                        type="number"
                        min={MIN_TIER_PERCENT}
                        max={MAX_TIER_PERCENT}
                        value={tier.percent ?? 0}
                        onChange={(e) =>
                          updateTier(i, {
                            // 0 es válido: "desde esta cantidad, precio normal".
                            percent: Math.max(
                              MIN_TIER_PERCENT,
                              Math.min(MAX_TIER_PERCENT, Number(e.target.value))
                            ),
                          })
                        }
                        style={{ ...inputStyle, borderRadius: "6px 0 0 6px", flex: 1, minWidth: 0 }}
                      />
                    )}
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
                      {esMonto ? "$" : "%"}
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
              valueType={valueType}
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
  valueType,
  tiers,
  selectionMode,
  productCount,
  startsAt,
  endsAt,
}: {
  name: string;
  mode: TierMode;
  valueType: TierValueType;
  tiers: Tier[];
  selectionMode: TieredSelectionMode;
  productCount: number;
  startsAt: string;
  endsAt: string;
}) {
  const esMonto = valueType === "AMOUNT";
  // El preview NO replica la lógica: ejecuta la misma función que la Function.
  // Con montos eso importa aún más, porque es donde se ve el caso del nivel que
  // se pasa del precio: aparece como un ahorro de 0, igual que le pasaría al
  // comprador.
  const rows = buildPreviewRows(mode, tiers, PRECIO_EJEMPLO, valueType);
  const sorted = normalizeTiers(tiers, valueType);
  // El máximo, no el último: con un nivel al 0 al final, el último ya no es
  // el que más descuenta y el resumen diría "máximo 0".
  const maxPercent = sorted.reduce((max, t) => {
    const v = (esMonto ? t.amount : t.percent) ?? 0;
    return v > max ? v : max;
  }, 0);

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
    {
      label: es.nuevaTiered.resumenMaximo,
      value: maxPercent ? (esMonto ? `$${maxPercent}` : `${maxPercent}%`) : "—",
    },
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
                    {esMonto ? `$${r.percent}` : `${r.percent}%`}
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
 * Campo de importe que conserva lo que el merchant está escribiendo.
 *
 * 🔴 NO usar `<input type="number">` controlado para importes.
 *
 * El DOM sanea el valor de un input numérico: si el contenido no es un número
 * válido —y "10." no lo es, porque está a medio escribir— `.value` devuelve
 * cadena vacía. Con `Number(e.target.value)` eso se traduce en 0, el estado se
 * resetea, React reescribe el campo a "0" y los dígitos siguientes se acumulan
 * encima. Resultado medido: tecleando 10,50 quedaba 50; 5,5 quedaba 5; 12,34
 * quedaba 34. Los enteros pasaban limpios, que es lo que lo hacía difícil de
 * ver. Tampoco acepta la coma en la mayoría de navegadores, y en español se
 * escribe 10,50.
 *
 * Aquí manda el BUFFER de texto: se guarda tal cual lo tecleado y solo se
 * propaga el número cuando ya es parseable. El valor de fuera únicamente pisa
 * el buffer si de verdad cambió (cambio de unidad, quitar un nivel, abrir para
 * editar); si no, se le borraría la coma en cada pulsación.
 */
function DecimalInput({
  value,
  onChange,
  style,
}: {
  value: number;
  onChange: (n: number) => void;
  style?: React.CSSProperties;
}) {
  const [text, setText] = useState(() => formatDecimalInput(value));

  useEffect(() => {
    // Si el buffer ya representa este mismo número, se deja intacto: es el
    // merchant escribiendo, no un cambio venido de fuera.
    if (parseDecimalInput(text) !== value) setText(formatDecimalInput(value));
    // `text` queda fuera a propósito — este efecto solo reacciona a `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        // null = todavía no es un número ("10," a medio escribir). Se conserva
        // el último valor bueno en vez de mandar un 0 que borraría el campo.
        const parsed = parseDecimalInput(raw);
        if (parsed !== null) onChange(parsed);
      }}
      style={style}
    />
  );
}

/**
 * Explica la diferencia entre modos con LOS NIVELES REALES del merchant y
 * números concretos. Es la forma más rápida de que entienda que los mismos
 * niveles producen dos totales distintos.
 */
function ModeExplainer({
  mode,
  valueType,
  tiers,
}: {
  mode: TierMode;
  valueType: TierValueType;
  tiers: Tier[];
}) {
  const esMonto = valueType === "AMOUNT";
  const rows = buildPreviewRows(mode, tiers, PRECIO_EJEMPLO, valueType);
  if (rows.length === 0) return null;

  // Se usa la fila del último nivel definido (la última es la fila "N+").
  const row = rows[Math.max(0, rows.length - 2)];
  const fmt = (v: number) => (esMonto ? `$${v}` : `${v}%`);
  const valores = normalizeTiers(tiers, valueType)
    .map((t) => fmt((esMonto ? t.amount : t.percent) ?? 0))
    .join(", ");

  const texto =
    mode === "UNIFORM"
      ? `Al llegar a ${row.quantity} unidades, las ${row.quantity} llevan ${fmt(row.percent)}${
          esMonto ? " de descuento cada una" : ""
        }. ${row.quantity} × ${money(PRECIO_EJEMPLO)} → paga ${money(row.total)}.`
      : `Cada unidad lleva su propio descuento (${valores}). ${row.quantity} × ${money(PRECIO_EJEMPLO)} → paga ${money(row.total)}.`;

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
