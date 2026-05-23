import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, Link } from "react-router";
import { Form } from "react-router";
import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ChevronDown, ChevronUp, Tag } from "lucide-react";
import { Btn } from "../components/Btn";
import { DiscountPreview } from "../components/DiscountPreview";
import { ItemPicker, type PickerItem } from "../components/ItemPicker";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import {
  applyPercentageDiscount,
  type SelectedProductInput,
  type SelectionMode,
} from "../lib/discounts/percentage";
import { getCollections, getProductMetadata } from "../lib/shopify/admin-api";
import { type Plan, PLAN_LIMITS } from "../lib/billing/plan-limits";
import { getCampaignCount } from "../lib/billing/plan-limits.server";
import { es } from "../i18n";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [collections, productMeta] = await Promise.all([
    getCollections(admin),
    getProductMetadata(admin),
  ]);
  return {
    collections,
    availableTags: productMeta.tags,
    availableVendors: productMeta.vendors,
    availableProductTypes: productMeta.productTypes,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

type ActionErrors = {
  name?: string;
  discountPercent?: string;
  products?: string;
  dates?: string;
  general?: string;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const name = (formData.get("name") as string | null) ?? "";
  const discountPercent = Number(formData.get("discountPercent"));
  const useCompareAtPriceAsBase = formData.get("useCompareAtPriceAsBase") === "on";
  const selectionMode = (formData.get("selectionMode") as string) || "products";
  const selectedProductsJson = (formData.get("selectedProductsJson") as string) || "[]";
  const collectionIdsJson = (formData.get("collectionIdsJson") as string) || "[]";
  const selectedTagsJson = (formData.get("selectedTagsJson") as string) || "[]";
  const selectedVendorsJson = (formData.get("selectedVendorsJson") as string) || "[]";
  const selectedProductTypesJson = (formData.get("selectedProductTypesJson") as string) || "[]";
  const enableExclusions = formData.get("enableExclusions") === "on";
  const excludedProductsJson = (formData.get("excludedProductsJson") as string) || "[]";
  const startsAt = (formData.get("startsAt") as string) || "";
  const endsAt = (formData.get("endsAt") as string) || "";
  const intent = (formData.get("intent") as "draft" | "activate") || "draft";

  const errors: ActionErrors = {};
  if (!name.trim()) errors.name = es.nuevaPorcentaje.errNombre;
  if (!discountPercent || discountPercent < 1 || discountPercent > 99)
    errors.discountPercent = es.nuevaPorcentaje.errDescuento;

  let selectedProducts: SelectedProductInput[] = [];
  let collectionIds: string[] = [];
  let selectedTags: string[] = [];
  let selectedVendors: string[] = [];
  let selectedProductTypes: string[] = [];
  try { selectedProducts = JSON.parse(selectedProductsJson); } catch { /* noop */ }
  try { collectionIds = JSON.parse(collectionIdsJson); } catch { /* noop */ }
  try { selectedTags = JSON.parse(selectedTagsJson); } catch { /* noop */ }
  try { selectedVendors = JSON.parse(selectedVendorsJson); } catch { /* noop */ }
  try { selectedProductTypes = JSON.parse(selectedProductTypesJson); } catch { /* noop */ }

  if (selectionMode === "products" && selectedProducts.length === 0)
    errors.products = es.nuevaPorcentaje.errProductos;
  if (selectionMode === "collections" && collectionIds.length === 0)
    errors.products = "Debes seleccionar al menos una colección";
  if (selectionMode === "tags" && selectedTags.length === 0)
    errors.products = "Debes seleccionar al menos un tag";
  if (selectionMode === "vendors" && selectedVendors.length === 0)
    errors.products = "Debes seleccionar al menos un vendedor";
  if (selectionMode === "productTypes" && selectedProductTypes.length === 0)
    errors.products = "Debes seleccionar al menos un tipo de producto";

  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))
    errors.dates = es.nuevaPorcentaje.errFechas;

  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const campaignStartsAt = startsAt ? new Date(startsAt) : null;
  const campaignEndsAt = endsAt ? new Date(endsAt) : null;
  const isScheduled = campaignStartsAt !== null && campaignStartsAt > new Date();
  const shouldActivate = intent === "activate" && !isScheduled;

  let excluded: SelectedProductInput[] = [];
  try { excluded = JSON.parse(excludedProductsJson); } catch { /* noop */ }
  const excludedVariantIds =
    enableExclusions && excluded.length > 0
      ? new Set(excluded.flatMap((p) => (p.variants ?? []).map((v) => v.id)))
      : undefined;

  // Plan enforcement — campaign count
  const plan = (shop.plan as Plan) || "FREE";
  const limits = PLAN_LIMITS[plan];
  const campaignCount = await getCampaignCount(shop.id);
  if (campaignCount >= limits.campaigns) {
    return Response.json(
      { errors: { general: es.planes.limiteCampanas(campaignCount, limits.campaigns) }, limitExceeded: true },
      { status: 422 }
    );
  }

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name: name.trim(),
      type: "PERCENTAGE",
      status: shouldActivate ? "ACTIVE" : "DRAFT",
      config: {
        discountPercent,
        showCompareAtPrice: useCompareAtPriceAsBase,
        selectionMode,
        collectionIds,
        selectedTags,
        selectedVendors,
        selectedProductTypes,
        excludedProductIds: enableExclusions ? excluded.map((p) => p.id) : [],
        enableExclusions,
      },
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  if (shouldActivate) {
    try {
      await applyPercentageDiscount(admin, campaign.id, {
        discountPercent,
        useCompareAtPriceAsBase,
        selectionMode: selectionMode as SelectionMode,
        selectedProducts: selectionMode === "products" ? selectedProducts : undefined,
        collectionIds: selectionMode === "collections" ? collectionIds : undefined,
        selectedTags: selectionMode === "tags" ? selectedTags : undefined,
        selectedVendors: selectionMode === "vendors" ? selectedVendors : undefined,
        selectedProductTypes: selectionMode === "productTypes" ? selectedProductTypes : undefined,
        excludedVariantIds,
      });
    } catch (err) {
      await prisma.campaign.delete({ where: { id: campaign.id } });
      return Response.json(
        { errors: { general: `Error al aplicar el descuento: ${String(err)}` } },
        { status: 500 }
      );
    }
  }

  return redirect("/app/campaigns");
};

// ─── UI helpers ───────────────────────────────────────────────────────────────

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      style={{
        border: "1px solid #e1e3e5",
        borderRadius: "10px",
        marginBottom: "16px",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 18px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: "14px",
          fontWeight: "600",
          color: "#202223",
          textAlign: "left",
        }}
      >
        {title}
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div style={{ padding: "0 18px 18px", borderTop: "1px solid #f1f2f3" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function FieldGroup({
  label,
  helper,
  error,
  children,
}: {
  label: string;
  helper?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: "16px" }}>
      <label
        style={{
          display: "block",
          fontSize: "13px",
          fontWeight: "500",
          color: "#202223",
          marginBottom: "5px",
        }}
      >
        {label}
      </label>
      {children}
      {helper && !error && (
        <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>{helper}</p>
      )}
      {error && (
        <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "4px" }}>{error}</p>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  fontSize: "14px",
  color: "#202223",
  background: "#fff",
  boxSizing: "border-box",
  outline: "none",
};

const inputErrorStyle: React.CSSProperties = { ...inputStyle, borderColor: "#d82c0d" };

const pickerBtnStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  padding: "8px 14px",
  fontSize: "13px",
  fontWeight: "500",
  cursor: "pointer",
  color: "#202223",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  background: "#f1f2f3",
  border: "1px solid #e1e3e5",
  borderRadius: "16px",
  padding: "3px 10px",
  fontSize: "12px",
  color: "#202223",
};

const chipRemoveStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#8c9196",
  padding: "0 0 0 2px",
  fontSize: "14px",
  lineHeight: 1,
};

type ProductChip = { id: string; title: string; variantCount: number };

function ProductChips({
  products,
  onRemove,
}: {
  products: ProductChip[];
  onRemove: (id: string) => void;
}) {
  if (products.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
      {products.map((p) => (
        <div
          key={p.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            background: "#f1f2f3",
            border: "1px solid #e1e3e5",
            borderRadius: "16px",
            padding: "3px 10px",
            fontSize: "12px",
            color: "#202223",
          }}
        >
          <Tag size={11} style={{ color: "#8c9196" }} />
          {p.title}
          <span style={{ color: "#8c9196", fontSize: "11px" }}>({p.variantCount} var.)</span>
          <button
            type="button"
            onClick={() => onRemove(p.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#8c9196",
              padding: "0 0 0 2px",
              fontSize: "14px",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function NewPercentageCampaign() {
  const { collections, availableTags, availableVendors, availableProductTypes } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: ActionErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};

  const [name, setName] = useState("");
  const [discountPercent, setDiscountPercent] = useState(20);
  const [useCompareAtPriceAsBase, setUseCompareAtPriceAsBase] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("products");
  const [selectedProducts, setSelectedProducts] = useState<
    Array<{ id: string; title: string; variants: Array<{ id: string }> }>
  >([]);
  const [selectedCollections, setSelectedCollections] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [selectedProductTypes, setSelectedProductTypes] = useState<string[]>([]);
  const [pickerMode, setPickerMode] = useState<"tags" | "vendors" | "productTypes" | null>(null);
  const [enableExclusions, setEnableExclusions] = useState(false);
  const [excludedProducts, setExcludedProducts] = useState<
    Array<{ id: string; title: string; variants: Array<{ id: string }> }>
  >([]);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  const productChips: ProductChip[] = selectedProducts.map((p) => ({
    id: p.id,
    title: p.title,
    variantCount: p.variants.length,
  }));
  const excludedChips: ProductChip[] = excludedProducts.map((p) => ({
    id: p.id,
    title: p.title,
    variantCount: p.variants.length,
  }));

  const productsDescription =
    selectionMode === "all"
      ? "Toda la tienda"
      : selectionMode === "products" && selectedProducts.length > 0
      ? `${selectedProducts.length} producto${selectedProducts.length !== 1 ? "s" : ""}`
      : selectionMode === "collections" && selectedCollections.length > 0
      ? `${selectedCollections.length} colección${selectedCollections.length !== 1 ? "es" : ""}`
      : selectionMode === "tags" && selectedTags.length > 0
      ? `${selectedTags.length} tag${selectedTags.length !== 1 ? "s" : ""}`
      : selectionMode === "vendors" && selectedVendors.length > 0
      ? `${selectedVendors.length} vendedor${selectedVendors.length !== 1 ? "es" : ""}`
      : selectionMode === "productTypes" && selectedProductTypes.length > 0
      ? `${selectedProductTypes.length} tipo${selectedProductTypes.length !== 1 ? "s" : ""}`
      : "—";

  const handleSelectProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: selectedProducts.map((p) => ({ id: p.id })),
    });
    if (selected) {
      setSelectedProducts(
        selected.map(
          (p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
            id: p.id,
            title: p.title,
            variants: p.variants ?? [],
          })
        )
      );
    }
  };

  const handleSelectCollections = async () => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: selectedCollections.map((c) => ({ id: c.id })),
    });
    if (selected) {
      setSelectedCollections(
        (selected as Array<{ id: string; title: string }>).map((c) => ({
          id: c.id,
          title: c.title,
        }))
      );
    }
  };

  const handleSelectExcluded = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: excludedProducts.map((p) => ({ id: p.id })),
    });
    if (selected) {
      setExcludedProducts(
        selected.map(
          (p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
            id: p.id,
            title: p.title,
            variants: p.variants ?? [],
          })
        )
      );
    }
  };

  return (
    <s-page heading={es.nuevaPorcentaje.titulo}>
      <div style={{ marginBottom: "4px" }}>
        <Link
          to="/app/campaigns"
          style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}
        >
          {es.nuevaPorcentaje.volver}
        </Link>
      </div>

      {errors.general && (
        <div
          style={{
            background: actionData?.limitExceeded ? "#fff8e1" : "#fde8e8",
            border: `1px solid ${actionData?.limitExceeded ? "#f9a825" : "#f97066"}`,
            borderRadius: "8px",
            padding: "12px 16px",
            color: actionData?.limitExceeded ? "#a05c00" : "#c0392b",
            fontSize: "14px",
            marginBottom: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <span>{errors.general}</span>
          {actionData?.limitExceeded && (
            <Link
              to="/app/plans"
              style={{
                fontSize: "13px",
                fontWeight: "600",
                color: "#008060",
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              {es.planes.verPlanes} →
            </Link>
          )}
        </div>
      )}

      <Form method="post">
        <input
          type="hidden"
          name="selectedProductsJson"
          value={JSON.stringify(selectedProducts.map((p) => ({ id: p.id, variants: p.variants })))}
        />
        <input
          type="hidden"
          name="collectionIdsJson"
          value={JSON.stringify(selectedCollections.map((c) => c.id))}
        />
        <input
          type="hidden"
          name="selectedTagsJson"
          value={JSON.stringify(selectedTags)}
        />
        <input
          type="hidden"
          name="selectedVendorsJson"
          value={JSON.stringify(selectedVendors)}
        />
        <input
          type="hidden"
          name="selectedProductTypesJson"
          value={JSON.stringify(selectedProductTypes)}
        />
        <input
          type="hidden"
          name="excludedProductsJson"
          value={JSON.stringify(excludedProducts.map((p) => ({ id: p.id, variants: p.variants })))}
        />

        {/* Layout 2 columnas: secciones izquierda + preview derecha */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "24px", alignItems: "start" }}>
          <div>

        {/* ─── 1. Información general ─── */}
        <Section title={es.nuevaPorcentaje.secInfoGeneral} defaultOpen>
          <FieldGroup
            label={es.nuevaPorcentaje.nombreLabel}
            helper={es.nuevaPorcentaje.nombreHelper}
            error={errors.name}
          >
            <input
              name="name"
              type="text"
              placeholder={es.nuevaPorcentaje.nombrePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={errors.name ? inputErrorStyle : inputStyle}
            />
          </FieldGroup>
        </Section>

        {/* ─── 2. Descuento — Issue #4: 2-column layout ─── */}
        <Section title={es.nuevaPorcentaje.secDescuento} defaultOpen>
          {/* Issue #4: horizontal 2-col grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <FieldGroup label={es.nuevaPorcentaje.tipoLabel}>
              <select
                disabled
                style={{ ...inputStyle, background: "#f8fafb", color: "#6d7175", cursor: "default" }}
              >
                <option>{es.nuevaPorcentaje.tipoPorcentaje}</option>
              </select>
            </FieldGroup>
            <FieldGroup
              label={es.nuevaPorcentaje.descuentoLabel}
              helper={es.nuevaPorcentaje.descuentoHelper}
              error={errors.discountPercent}
            >
              <div style={{ display: "flex", width: "100%" }}>
                <input
                  name="discountPercent"
                  type="number"
                  min={1}
                  max={99}
                  value={discountPercent}
                  onChange={(e) =>
                    setDiscountPercent(Math.max(1, Math.min(99, Number(e.target.value))))
                  }
                  style={{
                    ...(errors.discountPercent ? inputErrorStyle : inputStyle),
                    borderRadius: "6px 0 0 6px",
                    flex: 1,
                    minWidth: 0,
                  }}
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
            </FieldGroup>
          </div>

          {/* Issue #8: advanced options with description */}
          <div
            style={{
              marginTop: "16px",
              borderTop: "1px solid #f1f2f3",
              paddingTop: "14px",
            }}
          >
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              style={{
                background: "none",
                border: "none",
                color: "#006fbb",
                fontSize: "13px",
                cursor: "pointer",
                padding: 0,
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {es.nuevaPorcentaje.opAvanzadas}
            </button>
            {showAdvanced && (
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  marginTop: "12px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  name="useCompareAtPriceAsBase"
                  checked={useCompareAtPriceAsBase}
                  onChange={(e) => setUseCompareAtPriceAsBase(e.target.checked)}
                  style={{ marginTop: "3px", flexShrink: 0 }}
                />
                <div>
                  <span style={{ fontSize: "13px", fontWeight: "500", color: "#202223" }}>
                    {es.nuevaPorcentaje.checkCompare}
                  </span>
                  <p
                    style={{
                      fontSize: "12px",
                      color: "#6d7175",
                      margin: "3px 0 0",
                      lineHeight: "1.4",
                    }}
                  >
                    {es.nuevaPorcentaje.checkCompareDesc}
                  </p>
                </div>
              </label>
            )}
          </div>
        </Section>

        {/* ─── 3. Productos ─── */}
        <Section title={es.nuevaPorcentaje.secProductos} defaultOpen>
          {/* Selector de modo + botón picker (50/50) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              marginTop: "16px",
              alignItems: "flex-end",
            }}
          >
            {/* Izquierda: label + select */}
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: "500",
                  color: "#202223",
                  marginBottom: "5px",
                }}
              >
                {es.nuevaPorcentaje.modoLabel}
              </label>
              <select
                name="selectionMode"
                value={selectionMode}
                onChange={(e) => setSelectionMode(e.target.value as SelectionMode)}
                style={inputStyle}
              >
                <option value="products">{es.nuevaPorcentaje.modoProductos}</option>
                <option value="collections">{es.nuevaPorcentaje.modoColecciones}</option>
                <option value="tags">{es.nuevaPorcentaje.modoTags}</option>
                <option value="vendors">{es.nuevaPorcentaje.modoVendedor}</option>
                <option value="productTypes">{es.nuevaPorcentaje.modoTipo}</option>
                <option value="all">{es.nuevaPorcentaje.modoTienda}</option>
              </select>
            </div>

            {/* Derecha: botón picker (misma altura visual que el select) */}
            <div>
              {selectionMode === "products" && (
                <button
                  type="button"
                  onClick={handleSelectProducts}
                  style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
                >
                  {es.nuevaPorcentaje.btnSeleccionarProductos}
                </button>
              )}
              {selectionMode === "collections" && (
                <button
                  type="button"
                  onClick={handleSelectCollections}
                  style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
                >
                  {es.nuevaPorcentaje.btnSeleccionarColecciones}
                </button>
              )}
              {selectionMode === "tags" && (
                <button
                  type="button"
                  onClick={() => setPickerMode("tags")}
                  style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
                >
                  {es.nuevaPorcentaje.btnSeleccionarTags}
                </button>
              )}
              {selectionMode === "vendors" && (
                <button
                  type="button"
                  onClick={() => setPickerMode("vendors")}
                  style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
                >
                  {es.nuevaPorcentaje.btnSeleccionarVendedores}
                </button>
              )}
              {selectionMode === "productTypes" && (
                <button
                  type="button"
                  onClick={() => setPickerMode("productTypes")}
                  style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
                >
                  {es.nuevaPorcentaje.btnSeleccionarTipos}
                </button>
              )}
            </div>
          </div>

          {errors.products && (
            <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>
              {errors.products}
            </p>
          )}

          {/* Chips / info — debajo del grid, ancho completo */}
          {selectionMode === "products" && selectedProducts.length > 0 && (
            <div style={{ marginTop: "10px" }}>
              <ProductChips
                products={productChips}
                onRemove={(id) =>
                  setSelectedProducts((prev) => prev.filter((p) => p.id !== id))
                }
              />
              <p style={{ fontSize: "12px", color: "#6d7175", marginTop: "6px" }}>
                {selectedProducts.length} {es.nuevaPorcentaje.productosSeleccionados}
              </p>
            </div>
          )}

          {selectionMode === "collections" && selectedCollections.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
              {selectedCollections.map((c) => (
                <div key={c.id} style={chipStyle}>
                  {c.title}
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedCollections((prev) => prev.filter((x) => x.id !== c.id))
                    }
                    style={chipRemoveStyle}
                  >×</button>
                </div>
              ))}
            </div>
          )}

          {selectionMode === "tags" && selectedTags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
              {selectedTags.map((t) => (
                <div key={t} style={chipStyle}>
                  {t}
                  <button
                    type="button"
                    onClick={() => setSelectedTags((prev) => prev.filter((x) => x !== t))}
                    style={chipRemoveStyle}
                  >×</button>
                </div>
              ))}
            </div>
          )}

          {selectionMode === "vendors" && selectedVendors.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
              {selectedVendors.map((v) => (
                <div key={v} style={chipStyle}>
                  {v}
                  <button
                    type="button"
                    onClick={() => setSelectedVendors((prev) => prev.filter((x) => x !== v))}
                    style={chipRemoveStyle}
                  >×</button>
                </div>
              ))}
            </div>
          )}

          {selectionMode === "productTypes" && selectedProductTypes.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
              {selectedProductTypes.map((t) => (
                <div key={t} style={chipStyle}>
                  {t}
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedProductTypes((prev) => prev.filter((x) => x !== t))
                    }
                    style={chipRemoveStyle}
                  >×</button>
                </div>
              ))}
            </div>
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
              ✓ {es.nuevaPorcentaje.msgTodaTienda}
            </div>
          )}

          {/* Exclusions */}
          <div
            style={{
              marginTop: "18px",
              borderTop: "1px solid #f1f2f3",
              paddingTop: "14px",
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: "500",
                color: "#202223",
              }}
            >
              <input
                type="checkbox"
                name="enableExclusions"
                checked={enableExclusions}
                onChange={(e) => setEnableExclusions(e.target.checked)}
              />
              {es.nuevaPorcentaje.excluirToggle}
            </label>
            {enableExclusions && (
              <div style={{ marginTop: "10px" }}>
                <p
                  style={{
                    fontSize: "12px",
                    color: "#6d7175",
                    marginBottom: "8px",
                  }}
                >
                  {es.nuevaPorcentaje.excluirHelper}
                </p>
                <button
                  type="button"
                  onClick={handleSelectExcluded}
                  style={{
                    background: "#fff",
                    border: "1px solid #c9cccf",
                    borderRadius: "6px",
                    padding: "7px 14px",
                    fontSize: "13px",
                    cursor: "pointer",
                    color: "#202223",
                  }}
                >
                  {es.nuevaPorcentaje.btnExcluirProductos}
                </button>
                <ProductChips
                  products={excludedChips}
                  onRemove={(id) =>
                    setExcludedProducts((prev) => prev.filter((p) => p.id !== id))
                  }
                />
              </div>
            )}
          </div>
        </Section>

        {/* ─── 4. Programar campaña — Issue #6: no toggle, always show dates ─── */}
        <Section title={es.nuevaPorcentaje.secProgramacion} defaultOpen={false}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              marginTop: "8px",
            }}
          >
            <FieldGroup
              label={es.nuevaPorcentaje.fechaInicioLabel}
              helper={es.nuevaPorcentaje.fechaInicioHelper}
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
              label={es.nuevaPorcentaje.fechaFinLabel}
              helper={es.nuevaPorcentaje.fechaFinHelper}
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

          </div>{/* fin columna izquierda */}

          {/* Columna derecha: preview en vivo */}
          <div style={{ position: "sticky", top: "24px" }}>
            <DiscountPreview
              discountPercent={discountPercent}
              name={name}
              productsDescription={productsDescription}
              startsAt={startsAt}
              endsAt={endsAt}
            />
          </div>
        </div>{/* fin grid */}

        {/* ─── Action bar — Issue #7: better padding ─── */}
        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: "#ffffff",
            borderTop: "1px solid #e1e3e5",
            padding: "14px 24px",
            display: "flex",
            gap: "10px",
            alignItems: "center",
            zIndex: 10,
            marginLeft: "-24px",
            marginRight: "-24px",
          }}
        >
          <Link
            to="/app/campaigns"
            style={{
              color: "#6d7175",
              fontSize: "14px",
              textDecoration: "none",
              padding: "8px 4px",
            }}
          >
            {es.nuevaPorcentaje.btnCancelar}
          </Link>
          <div style={{ marginLeft: "auto", display: "flex", gap: "10px" }}>
            <Btn
              type="submit"
              name="intent"
              value="draft"
              variant="secondary"
              size="md"
              disabled={isSubmitting}
            >
              {es.nuevaPorcentaje.btnBorrador}
            </Btn>
            <Btn
              type="submit"
              name="intent"
              value="activate"
              variant="primary"
              size="md"
              disabled={isSubmitting}
              style={isSubmitting ? { background: "#4d9e8a" } : undefined}
            >
              {isSubmitting ? es.nuevaPorcentaje.btnCargando : es.nuevaPorcentaje.btnActivar}
            </Btn>
          </div>
        </div>
      </Form>

      {/* Pickers para tags / vendedores / tipos de producto */}
      <ItemPicker
        open={pickerMode === "tags"}
        title={es.nuevaPorcentaje.btnSeleccionarTags}
        items={availableTags.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={selectedTags}
        onConfirm={(ids) => { setSelectedTags(ids); setPickerMode(null); }}
        onCancel={() => setPickerMode(null)}
      />
      <ItemPicker
        open={pickerMode === "vendors"}
        title={es.nuevaPorcentaje.btnSeleccionarVendedores}
        items={availableVendors.map((v): PickerItem => ({ id: v, label: v }))}
        selectedIds={selectedVendors}
        onConfirm={(ids) => { setSelectedVendors(ids); setPickerMode(null); }}
        onCancel={() => setPickerMode(null)}
      />
      <ItemPicker
        open={pickerMode === "productTypes"}
        title={es.nuevaPorcentaje.btnSeleccionarTipos}
        items={availableProductTypes.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={selectedProductTypes}
        onConfirm={(ids) => { setSelectedProductTypes(ids); setPickerMode(null); }}
        onCancel={() => setPickerMode(null)}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
