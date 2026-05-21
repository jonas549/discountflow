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
  const useCompareAtPriceAsBase =
    formData.get("useCompareAtPriceAsBase") === "on";
  const selectionMode = (formData.get("selectionMode") as string) || "products";
  const selectedProductsJson =
    (formData.get("selectedProductsJson") as string) || "[]";
  const collectionId = (formData.get("collectionId") as string) || "";
  const enableExclusions = formData.get("enableExclusions") === "on";
  const excludedProductsJson =
    (formData.get("excludedProductsJson") as string) || "[]";
  const scheduleEnabled = formData.get("scheduleEnabled") === "on";
  const startsAt = (formData.get("startsAt") as string) || "";
  const endsAt = (formData.get("endsAt") as string) || "";
  const intent = (formData.get("intent") as "draft" | "activate") || "draft";

  // Validation
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

  if (scheduleEnabled && startsAt && endsAt) {
    if (new Date(endsAt) <= new Date(startsAt))
      errors.dates = es.nuevaPorcentaje.errFechas;
  }

  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  // Get/create shop
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  // Determine scheduling
  const campaignStartsAt =
    scheduleEnabled && startsAt ? new Date(startsAt) : null;
  const campaignEndsAt =
    scheduleEnabled && endsAt ? new Date(endsAt) : null;
  const isScheduled =
    campaignStartsAt !== null && campaignStartsAt > new Date();
  const shouldActivate = intent === "activate" && !isScheduled;

  // Create campaign
  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name: name.trim(),
      type: "PERCENTAGE",
      status: shouldActivate ? "ACTIVE" : "DRAFT",
      config: { discountPercent, showCompareAtPrice: useCompareAtPriceAsBase },
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  // Resolve excluded variant IDs
  let excludedVariantIds: Set<string> | undefined;
  if (enableExclusions) {
    try {
      const excluded: SelectedProductInput[] = JSON.parse(excludedProductsJson);
      excludedVariantIds = new Set(
        excluded.flatMap((p) => (p.variants ?? []).map((v) => v.id))
      );
    } catch {
      // ignore parse error
    }
  }

  // Apply discount if activating immediately
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
      // Revert campaign to DRAFT if activation fails
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "DRAFT" },
      });
      return Response.json(
        {
          errors: {
            general: `Error al aplicar el descuento: ${String(err)}`,
          },
        },
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
        <div
          style={{
            padding: "0 18px 18px",
            borderTop: "1px solid #f1f2f3",
          }}
        >
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
        <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>
          {helper}
        </p>
      )}
      {error && (
        <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "4px" }}>
          {error}
        </p>
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

const inputErrorStyle: React.CSSProperties = {
  ...inputStyle,
  borderColor: "#d82c0d",
};

// ─── Product chip display ─────────────────────────────────────────────────────

type ProductChip = {
  id: string;
  title: string;
  variantCount: number;
};

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
          <span style={{ color: "#8c9196", fontSize: "11px" }}>
            ({p.variantCount} var.)
          </span>
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

// ─── Preview panel ────────────────────────────────────────────────────────────

function DiscountPreview({
  discountPercent,
  name,
  productsCount,
  scheduleEnabled,
  startsAt,
  endsAt,
}: {
  discountPercent: number;
  name: string;
  productsCount: number | "∞";
  scheduleEnabled: boolean;
  startsAt: string;
  endsAt: string;
}) {
  const base = 100;
  const discounted = discountPercent > 0 ? base * (1 - discountPercent / 100) : base;
  const savings = base - discounted;

  return (
    <>
      {/* Visual preview */}
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
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: "700",
                  color: "#008060",
                }}
              >
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

      {/* Summary */}
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
          {
            label: es.nuevaPorcentaje.resumenNombre,
            value: name || es.nuevaPorcentaje.sinDefinir,
          },
          {
            label: es.nuevaPorcentaje.resumenTipo,
            value: es.nuevaPorcentaje.resumenTipoPorcentaje,
          },
          {
            label: es.nuevaPorcentaje.resumenDescuento,
            value:
              discountPercent > 0
                ? `${discountPercent}%`
                : es.nuevaPorcentaje.sinDefinir,
          },
          {
            label: es.nuevaPorcentaje.resumenProductos,
            value:
              productsCount === 0 || productsCount === "∞"
                ? productsCount === "∞"
                  ? "Toda la tienda"
                  : es.nuevaPorcentaje.sinDefinir
                : String(productsCount),
          },
          {
            label: es.nuevaPorcentaje.resumenInicio,
            value:
              scheduleEnabled && startsAt
                ? new Date(startsAt).toLocaleDateString("es-MX")
                : es.nuevaPorcentaje.resumenInmediato,
          },
          {
            label: es.nuevaPorcentaje.resumenFin,
            value:
              scheduleEnabled && endsAt
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

  // Form state
  const [name, setName] = useState("");
  const [discountPercent, setDiscountPercent] = useState(20);
  const [useCompareAtPriceAsBase, setUseCompareAtPriceAsBase] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectionMode, setSelectionMode] = useState<
    "products" | "collections" | "all"
  >("products");
  const [collectionId, setCollectionId] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<
    Array<{ id: string; title: string; variants: Array<{ id: string }> }>
  >([]);
  const [enableExclusions, setEnableExclusions] = useState(false);
  const [excludedProducts, setExcludedProducts] = useState<
    Array<{ id: string; title: string; variants: Array<{ id: string }> }>
  >([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [intent, setIntent] = useState<"draft" | "activate">("activate");

  // Computed
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
  const productsCount =
    selectionMode === "all" ? ("∞" as const) : selectedProducts.length;

  // ResourcePicker handlers
  const handleSelectProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: selectedProducts.map((p) => ({ id: p.id })),
    });
    if (selected) {
      setSelectedProducts(
        selected.map((p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
          id: p.id,
          title: p.title,
          variants: p.variants ?? [],
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
        selected.map((p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
          id: p.id,
          title: p.title,
          variants: p.variants ?? [],
        }))
      );
    }
  };

  return (
    <s-page heading={es.nuevaPorcentaje.titulo}>
      {/* Back link */}
      <div style={{ marginBottom: "4px" }}>
        <Link
          to="/app/campaigns"
          style={{
            fontSize: "13px",
            color: "#006fbb",
            textDecoration: "none",
          }}
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
        {/* Hidden fields for complex state */}
        <input
          type="hidden"
          name="selectedProductsJson"
          value={JSON.stringify(
            selectedProducts.map((p) => ({
              id: p.id,
              variants: p.variants,
            }))
          )}
        />
        <input
          type="hidden"
          name="excludedProductsJson"
          value={JSON.stringify(
            excludedProducts.map((p) => ({
              id: p.id,
              variants: p.variants,
            }))
          )}
        />
        <input type="hidden" name="intent" value={intent} />

        {/* ─── Sección 1: Info general ─── */}
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

        {/* ─── Sección 2: Descuento ─── */}
        <Section title={es.nuevaPorcentaje.secDescuento} defaultOpen>
          <FieldGroup
            label={es.nuevaPorcentaje.tipoLabel}
          >
            <input
              type="text"
              value={es.nuevaPorcentaje.tipoPorcentaje}
              disabled
              style={{ ...inputStyle, background: "#f8fafb", color: "#6d7175" }}
            />
          </FieldGroup>

          <FieldGroup
            label={es.nuevaPorcentaje.descuentoLabel}
            helper={es.nuevaPorcentaje.descuentoHelper}
            error={errors.discountPercent}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0" }}>
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

          <div style={{ marginTop: "14px" }}>
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
                  gap: "8px",
                  marginTop: "10px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  name="useCompareAtPriceAsBase"
                  checked={useCompareAtPriceAsBase}
                  onChange={(e) => setUseCompareAtPriceAsBase(e.target.checked)}
                  style={{ marginTop: "2px", flexShrink: 0 }}
                />
                <span style={{ fontSize: "13px", color: "#202223" }}>
                  {es.nuevaPorcentaje.checkCompare}
                </span>
              </label>
            )}
          </div>
        </Section>

        {/* ─── Sección 3: Productos ─── */}
        <Section title={es.nuevaPorcentaje.secProductos} defaultOpen>
          <FieldGroup label={es.nuevaPorcentaje.modoLabel}>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "6px" }}>
              {(
                [
                  { value: "products", label: es.nuevaPorcentaje.modoProductos },
                  { value: "collections", label: es.nuevaPorcentaje.modoColecciones },
                  { value: "all", label: es.nuevaPorcentaje.modoTienda },
                ] as const
              ).map(({ value, label }) => (
                <label
                  key={value}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                    fontSize: "13px",
                    color: "#202223",
                  }}
                >
                  <input
                    type="radio"
                    name="selectionMode"
                    value={value}
                    checked={selectionMode === value}
                    onChange={() => setSelectionMode(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </FieldGroup>

          {/* Selector por modo */}
          {selectionMode === "products" && (
            <div style={{ marginTop: "14px" }}>
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
                }}
              >
                {es.nuevaPorcentaje.btnSeleccionarProductos}
              </button>
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
                <p style={{ fontSize: "12px", color: "#6d7175", marginTop: "8px" }}>
                  {selectedProducts.length} {es.nuevaPorcentaje.productosSeleccionados}
                </p>
              )}
            </div>
          )}

          {selectionMode === "collections" && (
            <FieldGroup
              label={es.nuevaPorcentaje.coleccionLabel}
              error={errors.products}
            >
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

          {/* Exclusiones */}
          <div style={{ marginTop: "18px", borderTop: "1px solid #f1f2f3", paddingTop: "14px" }}>
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
                <p style={{ fontSize: "12px", color: "#6d7175", marginBottom: "8px" }}>
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

        {/* ─── Sección 4: Programación ─── */}
        <Section title={es.nuevaPorcentaje.secProgramacion} defaultOpen={false}>
          <div style={{ marginTop: "8px" }}>
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
                name="scheduleEnabled"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />
              {es.nuevaPorcentaje.programarToggle}
            </label>

            {!scheduleEnabled && (
              <p
                style={{
                  fontSize: "13px",
                  color: "#6d7175",
                  marginTop: "10px",
                  background: "#f8fafb",
                  padding: "8px 12px",
                  borderRadius: "6px",
                }}
              >
                ⚡ {es.nuevaPorcentaje.msgInmediato}
              </p>
            )}

            {scheduleEnabled && (
              <div style={{ marginTop: "14px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <FieldGroup
                  label={es.nuevaPorcentaje.fechaInicioLabel}
                  error={errors.dates}
                >
                  <input
                    type="datetime-local"
                    name="startsAt"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    style={inputStyle}
                  />
                </FieldGroup>
                <FieldGroup label={es.nuevaPorcentaje.fechaFinLabel}>
                  <input
                    type="datetime-local"
                    name="endsAt"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    style={inputStyle}
                  />
                </FieldGroup>
              </div>
            )}
          </div>
        </Section>

        {/* Sticky action bar */}
        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: "#ffffff",
            borderTop: "1px solid #e1e3e5",
            padding: "12px 0",
            display: "flex",
            gap: "10px",
            alignItems: "center",
            zIndex: 10,
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
            <button
              type="submit"
              disabled={isSubmitting}
              onClick={() => setIntent("draft")}
              style={{
                background: "#fff",
                border: "1px solid #c9cccf",
                borderRadius: "6px",
                padding: "8px 16px",
                fontSize: "14px",
                fontWeight: "500",
                cursor: isSubmitting ? "not-allowed" : "pointer",
                color: "#202223",
                opacity: isSubmitting ? 0.7 : 1,
              }}
            >
              {es.nuevaPorcentaje.btnBorrador}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              onClick={() => setIntent("activate")}
              style={{
                background: isSubmitting ? "#4d9e8a" : "#008060",
                border: "none",
                borderRadius: "6px",
                padding: "8px 20px",
                fontSize: "14px",
                fontWeight: "600",
                cursor: isSubmitting ? "not-allowed" : "pointer",
                color: "#ffffff",
              }}
            >
              {isSubmitting ? es.nuevaPorcentaje.btnCargando : es.nuevaPorcentaje.btnActivar}
            </button>
          </div>
        </div>
      </Form>

      {/* Aside: Preview + Summary */}
      <s-section slot="aside">
        <DiscountPreview
          discountPercent={discountPercent}
          name={name}
          productsCount={productsCount}
          scheduleEnabled={scheduleEnabled}
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
