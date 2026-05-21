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
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import {
  applyPercentageDiscount,
  type SelectedProductInput,
} from "../lib/discounts/percentage";
import { getCollections } from "../lib/shopify/admin-api";
import { es } from "../i18n";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const collections = await getCollections(admin);
  return { collections };
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
  const collectionId = (formData.get("collectionId") as string) || "";
  const enableExclusions = formData.get("enableExclusions") === "on";
  const excludedProductsJson = (formData.get("excludedProductsJson") as string) || "[]";
  // Issue #6: no scheduleEnabled toggle — dates are always optional
  const startsAt = (formData.get("startsAt") as string) || "";
  const endsAt = (formData.get("endsAt") as string) || "";
  // Issue #3: intent comes directly from the submit button value
  const intent = (formData.get("intent") as "draft" | "activate") || "draft";

  const errors: ActionErrors = {};
  if (!name.trim()) errors.name = es.nuevaPorcentaje.errNombre;
  if (!discountPercent || discountPercent < 1 || discountPercent > 99)
    errors.discountPercent = es.nuevaPorcentaje.errDescuento;

  let selectedProducts: SelectedProductInput[] = [];
  try {
    selectedProducts = JSON.parse(selectedProductsJson);
  } catch {
    selectedProducts = [];
  }

  if (selectionMode === "products" && selectedProducts.length === 0)
    errors.products = es.nuevaPorcentaje.errProductos;
  if (selectionMode === "collections" && !collectionId)
    errors.products = "Debes seleccionar una colección";

  // Issue #6: validate dates without a toggle
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

  // Store selectionMode and collectionId in config for edit re-use
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
        collectionId: collectionId || null,
      },
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  let excludedVariantIds: Set<string> | undefined;
  if (enableExclusions) {
    try {
      const excluded: SelectedProductInput[] = JSON.parse(excludedProductsJson);
      excludedVariantIds = new Set(
        excluded.flatMap((p) => (p.variants ?? []).map((v) => v.id))
      );
    } catch {
      // ignore
    }
  }

  if (shouldActivate) {
    try {
      await applyPercentageDiscount(admin, campaign.id, {
        discountPercent,
        useCompareAtPriceAsBase,
        selectionMode: selectionMode as "products" | "collections" | "all",
        selectedProducts: selectionMode === "products" ? selectedProducts : undefined,
        collectionId: selectionMode === "collections" ? collectionId : undefined,
        excludedVariantIds,
      });
    } catch (err) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "DRAFT" },
      });
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

function DiscountPreview({
  discountPercent,
  name,
  productsCount,
  startsAt,
  endsAt,
}: {
  discountPercent: number;
  name: string;
  productsCount: number | "∞";
  startsAt: string;
  endsAt: string;
}) {
  const base = 100;
  const discounted = discountPercent > 0 ? base * (1 - discountPercent / 100) : base;
  const savings = base - discounted;

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
              <div style={{ fontSize: "12px", color: "#8c9196", textDecoration: "line-through" }}>
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
        {[
          { label: es.nuevaPorcentaje.resumenNombre, value: name || es.nuevaPorcentaje.sinDefinir },
          { label: es.nuevaPorcentaje.resumenTipo, value: es.nuevaPorcentaje.resumenTipoPorcentaje },
          {
            label: es.nuevaPorcentaje.resumenDescuento,
            value: discountPercent > 0 ? `${discountPercent}%` : es.nuevaPorcentaje.sinDefinir,
          },
          {
            label: es.nuevaPorcentaje.resumenProductos,
            value:
              productsCount === "∞"
                ? "Toda la tienda"
                : productsCount === 0
                ? es.nuevaPorcentaje.sinDefinir
                : String(productsCount),
          },
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
        ].map(({ label, value }) => (
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function NewPercentageCampaign() {
  const { collections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: ActionErrors }
    | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};

  const [name, setName] = useState("");
  const [discountPercent, setDiscountPercent] = useState(20);
  const [useCompareAtPriceAsBase, setUseCompareAtPriceAsBase] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectionMode, setSelectionMode] = useState<"products" | "collections" | "all">(
    "products"
  );
  const [collectionId, setCollectionId] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<
    Array<{ id: string; title: string; variants: Array<{ id: string }> }>
  >([]);
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
  const productsCount = selectionMode === "all" ? ("∞" as const) : selectedProducts.length;

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
            background: "#fde8e8",
            border: "1px solid #f97066",
            borderRadius: "8px",
            padding: "12px 16px",
            color: "#c0392b",
            fontSize: "14px",
            marginBottom: "16px",
          }}
        >
          {errors.general}
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
          name="excludedProductsJson"
          value={JSON.stringify(excludedProducts.map((p) => ({ id: p.id, variants: p.variants })))}
        />

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
              <div style={{ display: "flex" }}>
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
                    width: "100px",
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

        {/* ─── 3. Productos — Issue #5: select dropdown + ResourcePicker ─── */}
        <Section title={es.nuevaPorcentaje.secProductos} defaultOpen>
          {/* Mode selector + action button in one row */}
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
              {es.nuevaPorcentaje.modoLabel}
            </label>
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <select
                name="selectionMode"
                value={selectionMode}
                onChange={(e) =>
                  setSelectionMode(e.target.value as "products" | "collections" | "all")
                }
                style={{ ...inputStyle, flex: 1 }}
              >
                <option value="products">{es.nuevaPorcentaje.modoProductos}</option>
                <option value="collections">{es.nuevaPorcentaje.modoColecciones}</option>
                <option value="all">{es.nuevaPorcentaje.modoTienda}</option>
              </select>
              {selectionMode === "products" && (
                <button
                  type="button"
                  onClick={handleSelectProducts}
                  style={{
                    background: "#fff",
                    border: "1px solid #c9cccf",
                    borderRadius: "6px",
                    padding: "8px 14px",
                    fontSize: "13px",
                    fontWeight: "500",
                    cursor: "pointer",
                    color: "#202223",
                    whiteSpace: "nowrap",
                  }}
                >
                  {es.nuevaPorcentaje.btnSeleccionarProductos}
                </button>
              )}
            </div>
          </div>

          {/* Products mode content */}
          {selectionMode === "products" && (
            <div style={{ marginTop: "8px" }}>
              {errors.products && (
                <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "4px" }}>
                  {errors.products}
                </p>
              )}
              <ProductChips
                products={productChips}
                onRemove={(id) =>
                  setSelectedProducts((prev) => prev.filter((p) => p.id !== id))
                }
              />
              {selectedProducts.length > 0 && (
                <p style={{ fontSize: "12px", color: "#6d7175", marginTop: "6px" }}>
                  {selectedProducts.length} {es.nuevaPorcentaje.productosSeleccionados}
                </p>
              )}
            </div>
          )}

          {/* Collections mode */}
          {selectionMode === "collections" && (
            <FieldGroup label={es.nuevaPorcentaje.coleccionLabel} error={errors.products}>
              <select
                name="collectionId"
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
                style={inputStyle}
              >
                <option value="">{es.nuevaPorcentaje.coleccionPlaceholder}</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.productsCount} productos)
                  </option>
                ))}
              </select>
            </FieldGroup>
          )}

          {/* All store mode */}
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

      {/* Aside */}
      <s-section slot="aside">
        <DiscountPreview
          discountPercent={discountPercent}
          name={name}
          productsCount={productsCount}
          startsAt={startsAt}
          endsAt={endsAt}
        />
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
