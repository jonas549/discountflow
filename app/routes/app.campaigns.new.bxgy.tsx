import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, Link } from "react-router";
import { Form } from "react-router";
import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Btn } from "../components/Btn";
import { ItemPicker, type PickerItem } from "../components/ItemPicker";
import {
  Section,
  FieldGroup,
  ProductChips,
  StringChips,
  CollectionChips,
  inputStyle,
  inputErrorStyle,
  chipStyle,
  chipRemoveStyle,
  ActionBar,
  GeneralErrorBanner,
} from "../components/CampaignFormShared";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { getCollections, getProductMetadata } from "../lib/shopify/admin-api";
import {
  createBxgyDiscount,
  type BxgyCampaignConfig,
  type BxgyYMode,
} from "../lib/discounts/bxgy";
import type { SelectionMode } from "../lib/discounts/percentage";
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
  xProducts?: string;
  yProducts?: string;
  xQuantity?: string;
  yQuantity?: string;
  discountValue?: string;
  dates?: string;
  general?: string;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();

  const name = (fd.get("name") as string | null)?.trim() ?? "";
  const intent = (fd.get("intent") as "draft" | "activate") ?? "draft";

  // X
  const xMode = (fd.get("xMode") as string) || "products";
  const xMinQuantity = Math.max(1, Number(fd.get("xMinQuantity") ?? 2));
  const xProductsJson = (fd.get("xProductsJson") as string) || "[]";
  const xCollectionIdsJson = (fd.get("xCollectionIdsJson") as string) || "[]";
  const xTagsJson = (fd.get("xTagsJson") as string) || "[]";
  const xVendorsJson = (fd.get("xVendorsJson") as string) || "[]";
  const xTypesJson = (fd.get("xTypesJson") as string) || "[]";
  const enableXExclusions = fd.get("enableXExclusions") === "on";
  const xExcludedJson = (fd.get("xExcludedJson") as string) || "[]";

  // Y
  const yMode = (fd.get("yMode") as string) || "same-as-x";
  const yQuantity = Math.max(1, Number(fd.get("yQuantity") ?? 1));
  const yProductsJson = (fd.get("yProductsJson") as string) || "[]";
  const yCollectionIdsJson = (fd.get("yCollectionIdsJson") as string) || "[]";
  const yTagsJson = (fd.get("yTagsJson") as string) || "[]";
  const yVendorsJson = (fd.get("yVendorsJson") as string) || "[]";
  const yTypesJson = (fd.get("yTypesJson") as string) || "[]";

  // Discount
  const discountType = (fd.get("discountType") as "free" | "percentage") || "free";
  const discountValue = Number(fd.get("discountValue") ?? 0);

  // Dates
  const startsAt = (fd.get("startsAt") as string) || "";
  const endsAt = (fd.get("endsAt") as string) || "";

  // Parse JSON
  let xProducts: Array<{ id: string; variants?: Array<{ id: string }> }> = [];
  let xCollectionIds: string[] = [];
  let xTags: string[] = [];
  let xVendors: string[] = [];
  let xTypes: string[] = [];
  let xExcluded: Array<{ id: string; variants?: Array<{ id: string }> }> = [];
  let yProducts: Array<{ id: string; variants?: Array<{ id: string }> }> = [];
  let yCollectionIds: string[] = [];
  let yTags: string[] = [];
  let yVendors: string[] = [];
  let yTypes: string[] = [];
  try { xProducts = JSON.parse(xProductsJson); } catch { /* noop */ }
  try { xCollectionIds = JSON.parse(xCollectionIdsJson); } catch { /* noop */ }
  try { xTags = JSON.parse(xTagsJson); } catch { /* noop */ }
  try { xVendors = JSON.parse(xVendorsJson); } catch { /* noop */ }
  try { xTypes = JSON.parse(xTypesJson); } catch { /* noop */ }
  try { xExcluded = JSON.parse(xExcludedJson); } catch { /* noop */ }
  try { yProducts = JSON.parse(yProductsJson); } catch { /* noop */ }
  try { yCollectionIds = JSON.parse(yCollectionIdsJson); } catch { /* noop */ }
  try { yTags = JSON.parse(yTagsJson); } catch { /* noop */ }
  try { yVendors = JSON.parse(yVendorsJson); } catch { /* noop */ }
  try { yTypes = JSON.parse(yTypesJson); } catch { /* noop */ }

  // Validation
  const errors: ActionErrors = {};
  if (!name) errors.name = es.nuevaBxgy.errNombre;

  const xHasSelection =
    xMode === "all" ||
    (xMode === "products" && xProducts.length > 0) ||
    (xMode === "collections" && xCollectionIds.length > 0) ||
    (xMode === "tags" && xTags.length > 0) ||
    (xMode === "vendors" && xVendors.length > 0) ||
    (xMode === "productTypes" && xTypes.length > 0);
  if (!xHasSelection) errors.xProducts = es.nuevaBxgy.errXProductos;

  const yHasSelection =
    yMode === "same-as-x" ||
    yMode === "all" ||
    (yMode === "products" && yProducts.length > 0) ||
    (yMode === "collections" && yCollectionIds.length > 0) ||
    (yMode === "tags" && yTags.length > 0) ||
    (yMode === "vendors" && yVendors.length > 0) ||
    (yMode === "productTypes" && yTypes.length > 0);
  if (!yHasSelection) errors.yProducts = es.nuevaBxgy.errYProductos;

  if (discountType === "percentage" && (discountValue < 1 || discountValue > 99))
    errors.discountValue = es.nuevaBxgy.errDescuentoValor;

  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))
    errors.dates = es.nuevaBxgy.errFechas;

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

  const xExcludeProductIds = enableXExclusions
    ? xExcluded.map((p) => p.id)
    : [];

  const config: BxgyCampaignConfig = {
    xMode: xMode as SelectionMode,
    xProductIds: xProducts.map((p) => p.id),
    xCollectionIds,
    xRawItems: xMode === "tags" ? xTags : xMode === "vendors" ? xVendors : xMode === "productTypes" ? xTypes : [],
    xMinQuantity,
    xExcludeProductIds,
    yMode: yMode as BxgyYMode,
    yProductIds: yProducts.map((p) => p.id),
    yCollectionIds,
    yRawItems: yMode === "tags" ? yTags : yMode === "vendors" ? yVendors : yMode === "productTypes" ? yTypes : [],
    yQuantity,
    discountType,
    discountValue: discountType === "free" ? 0 : discountValue,
  };

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name,
      type: "BXGY",
      status: shouldActivate ? "ACTIVE" : "DRAFT",
      config: config as unknown as Record<string, unknown>,
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  if (shouldActivate) {
    try {
      await createBxgyDiscount(admin, campaign.id, name, config, campaignStartsAt, campaignEndsAt);
    } catch (err) {
      await prisma.campaign.delete({ where: { id: campaign.id } });
      return Response.json(
        { errors: { general: `Error al crear el descuento en Shopify: ${String(err)}` } },
        { status: 500 }
      );
    }
  }

  return redirect("/app/campaigns");
};

// ─── Local UI helpers ─────────────────────────────────────────────────────────

type ProductItem = { id: string; title: string; variants: Array<{ id: string }> };
type CollectionItem = { id: string; title: string };

const SELECTION_MODES = [
  { value: "products", label: es.nuevaBxgy.modoProductos },
  { value: "collections", label: es.nuevaBxgy.modoColecciones },
  { value: "tags", label: es.nuevaBxgy.modoTags },
  { value: "vendors", label: es.nuevaBxgy.modoVendedor },
  { value: "productTypes", label: es.nuevaBxgy.modoTipo },
  { value: "all", label: es.nuevaBxgy.modoTienda },
];

const Y_SELECTION_MODES = [
  { value: "same-as-x", label: es.nuevaBxgy.modoSameAsX },
  ...SELECTION_MODES,
];

// Inline selection panel — renders mode dropdown + picker button (50/50) + chips
function SelectionPanel({
  prefix,
  modes,
  selectionMode,
  onModeChange,
  selectedProducts,
  selectedCollections,
  selectedTags,
  selectedVendors,
  selectedProductTypes,
  onSelectProducts,
  onSelectCollections,
  onOpenTagPicker,
  onOpenVendorPicker,
  onOpenTypePicker,
  onRemoveProduct,
  onRemoveCollection,
  onRemoveTag,
  onRemoveVendor,
  onRemoveType,
  error,
  btnProductos,
  btnColecciones,
  btnTags,
  btnVendedores,
  btnTipos,
}: {
  prefix: string;
  modes: Array<{ value: string; label: string }>;
  selectionMode: string;
  onModeChange: (m: string) => void;
  selectedProducts: ProductItem[];
  selectedCollections: CollectionItem[];
  selectedTags: string[];
  selectedVendors: string[];
  selectedProductTypes: string[];
  onSelectProducts: () => void;
  onSelectCollections: () => void;
  onOpenTagPicker: () => void;
  onOpenVendorPicker: () => void;
  onOpenTypePicker: () => void;
  onRemoveProduct: (id: string) => void;
  onRemoveCollection: (id: string) => void;
  onRemoveTag: (t: string) => void;
  onRemoveVendor: (v: string) => void;
  onRemoveType: (t: string) => void;
  error?: string;
  btnProductos: string;
  btnColecciones: string;
  btnTags: string;
  btnVendedores: string;
  btnTipos: string;
}) {
  const productChips = selectedProducts.map((p) => ({
    id: p.id,
    title: p.title,
    variantCount: p.variants.length,
  }));

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px",
          marginTop: "16px",
          alignItems: "flex-end",
        }}
      >
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
            {es.nuevaBxgy.modoLabel}
          </label>
          <select
            name={`${prefix}Mode`}
            value={selectionMode}
            onChange={(e) => onModeChange(e.target.value)}
            style={inputStyle}
          >
            {modes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          {selectionMode === "products" && (
            <button
              type="button"
              onClick={onSelectProducts}
              style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
            >
              {btnProductos}
            </button>
          )}
          {selectionMode === "collections" && (
            <button
              type="button"
              onClick={onSelectCollections}
              style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
            >
              {btnColecciones}
            </button>
          )}
          {selectionMode === "tags" && (
            <button
              type="button"
              onClick={onOpenTagPicker}
              style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
            >
              {btnTags}
            </button>
          )}
          {selectionMode === "vendors" && (
            <button
              type="button"
              onClick={onOpenVendorPicker}
              style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
            >
              {btnVendedores}
            </button>
          )}
          {selectionMode === "productTypes" && (
            <button
              type="button"
              onClick={onOpenTypePicker}
              style={{ ...inputStyle, cursor: "pointer", textAlign: "left" as const }}
            >
              {btnTipos}
            </button>
          )}
          {selectionMode === "same-as-x" && (
            <div
              style={{
                ...inputStyle,
                background: "#f8fafb",
                color: "#6d7175",
                display: "flex",
                alignItems: "center",
              }}
            >
              ↑ Igual que X
            </div>
          )}
        </div>
      </div>

      {error && (
        <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>{error}</p>
      )}

      {selectionMode === "products" && (
        <ProductChips products={productChips} onRemove={onRemoveProduct} />
      )}
      {selectionMode === "collections" && (
        <CollectionChips collections={selectedCollections} onRemove={onRemoveCollection} />
      )}
      {selectionMode === "tags" && (
        <StringChips values={selectedTags} onRemove={onRemoveTag} />
      )}
      {selectionMode === "vendors" && (
        <StringChips values={selectedVendors} onRemove={onRemoveVendor} />
      )}
      {selectionMode === "productTypes" && (
        <StringChips values={selectedProductTypes} onRemove={onRemoveType} />
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
          ✓ {es.nuevaBxgy.msgTodaTienda}
        </div>
      )}
      {selectionMode === "same-as-x" && (
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
          ✓ Se usarán los mismos productos configurados en la sección anterior.
        </div>
      )}

      {/* Hidden JSON inputs */}
      <input
        type="hidden"
        name={`${prefix}ProductsJson`}
        value={JSON.stringify(selectedProducts.map((p) => ({ id: p.id, variants: p.variants })))}
      />
      <input
        type="hidden"
        name={`${prefix}CollectionIdsJson`}
        value={JSON.stringify(selectedCollections.map((c) => c.id))}
      />
      <input
        type="hidden"
        name={`${prefix}TagsJson`}
        value={JSON.stringify(selectedTags)}
      />
      <input
        type="hidden"
        name={`${prefix}VendorsJson`}
        value={JSON.stringify(selectedVendors)}
      />
      <input
        type="hidden"
        name={`${prefix}TypesJson`}
        value={JSON.stringify(selectedProductTypes)}
      />
    </>
  );
}

// ─── Preview panel ─────────────────────────────────────────────────────────────

function BxgyPreview({
  name,
  xMode,
  xProductCount,
  xMinQuantity,
  yMode,
  yProductCount,
  yQuantity,
  discountType,
  discountValue,
  startsAt,
  endsAt,
}: {
  name: string;
  xMode: string;
  xProductCount: number;
  xMinQuantity: number;
  yMode: string;
  yProductCount: number;
  yQuantity: number;
  discountType: "free" | "percentage";
  discountValue: number;
  startsAt: string;
  endsAt: string;
}) {
  const discountBadge =
    discountType === "free" ? "GRATIS" : `${discountValue}% OFF`;
  const discountBadgeColor = discountType === "free" ? "#008060" : "#8b5e00";
  const discountBadgeBg = discountType === "free" ? "#d3f5e2" : "#fff3cd";

  const xDesc =
    xMode === "all"
      ? "toda la tienda"
      : xMode === "products" && xProductCount > 0
      ? `${xProductCount} producto${xProductCount !== 1 ? "s" : ""}`
      : xMode === "collections"
      ? "colecciones"
      : xMode === "tags"
      ? "tags"
      : xMode === "vendors"
      ? "vendedor"
      : xMode === "productTypes"
      ? "tipo de producto"
      : "—";

  const yDesc =
    yMode === "same-as-x"
      ? xDesc
      : yMode === "all"
      ? "toda la tienda"
      : yMode === "products" && yProductCount > 0
      ? `${yProductCount} producto${yProductCount !== 1 ? "s" : ""}`
      : yMode === "collections"
      ? "colecciones"
      : "—";

  const summaryRows = [
    { label: es.nuevaBxgy.resumenNombre, value: name || es.nuevaBxgy.sinDefinir },
    { label: es.nuevaBxgy.resumenTipo, value: es.nuevaBxgy.resumenTipoBxgy },
    {
      label: es.nuevaBxgy.resumenCompra,
      value: xProductCount > 0 || xMode === "all" ? `${xMinQuantity} × ${xDesc}` : es.nuevaBxgy.sinDefinir,
    },
    {
      label: es.nuevaBxgy.resumenRecibe,
      value: yDesc !== "—" ? `${yQuantity} × ${yDesc}` : es.nuevaBxgy.sinDefinir,
    },
    { label: es.nuevaBxgy.resumenDescuento, value: discountBadge },
    {
      label: es.nuevaBxgy.resumenInicio,
      value: startsAt
        ? new Date(startsAt).toLocaleDateString("es-MX")
        : es.nuevaBxgy.resumenInmediato,
    },
    {
      label: es.nuevaBxgy.resumenFin,
      value: endsAt
        ? new Date(endsAt).toLocaleDateString("es-MX")
        : es.nuevaBxgy.resumenSinFin,
    },
  ];

  return (
    <>
      {/* Card 1 — Vista previa */}
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
          {es.nuevaBxgy.previewTitulo}
        </p>
        <div
          style={{
            background: "#f8fafb",
            border: "1px solid #e1e3e5",
            borderRadius: "8px",
            padding: "14px",
          }}
        >
          {/* Compra X */}
          <p style={{ fontSize: "11px", color: "#8c9196", marginBottom: "8px" }}>
            Compra {xMinQuantity} de {xDesc}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            {Array.from({ length: Math.min(xMinQuantity, 3) }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: "34px",
                  height: "34px",
                  background: "#e1e3e5",
                  borderRadius: "6px",
                  flexShrink: 0,
                }}
              />
            ))}
            {xMinQuantity > 3 && (
              <span style={{ fontSize: "12px", color: "#8c9196" }}>+{xMinQuantity - 3}</span>
            )}
          </div>
          {/* Arrow */}
          <div
            style={{
              textAlign: "center",
              fontSize: "18px",
              color: "#008060",
              marginBottom: "12px",
              fontWeight: "700",
            }}
          >
            ↓
          </div>
          {/* Recibe Y */}
          <p style={{ fontSize: "11px", color: "#8c9196", marginBottom: "8px" }}>
            Lleva {yQuantity} de {yDesc}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {Array.from({ length: Math.min(yQuantity, 3) }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: "34px",
                  height: "34px",
                  background: yMode === "same-as-x" ? "#e1e3e5" : "#d3f5e2",
                  border: yMode === "same-as-x" ? "none" : "1px solid #b5e3d8",
                  borderRadius: "6px",
                  flexShrink: 0,
                }}
              />
            ))}
            <span
              style={{
                background: discountBadgeBg,
                color: discountBadgeColor,
                fontSize: "11px",
                fontWeight: "700",
                padding: "2px 8px",
                borderRadius: "12px",
              }}
            >
              {discountBadge}
            </span>
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
          {es.nuevaBxgy.resumenTitulo}
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function NewBxgyCampaign() {
  const { availableTags, availableVendors, availableProductTypes } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { errors?: ActionErrors } | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};

  // General
  const [name, setName] = useState("");

  // X state
  const [xMode, setXMode] = useState<string>("products");
  const [xProducts, setXProducts] = useState<ProductItem[]>([]);
  const [xCollections, setXCollections] = useState<CollectionItem[]>([]);
  const [xTags, setXTags] = useState<string[]>([]);
  const [xVendors, setXVendors] = useState<string[]>([]);
  const [xTypes, setXTypes] = useState<string[]>([]);
  const [xMinQuantity, setXMinQuantity] = useState(2);
  const [enableXExclusions, setEnableXExclusions] = useState(false);
  const [xExcluded, setXExcluded] = useState<ProductItem[]>([]);
  const [xPickerMode, setXPickerMode] = useState<"tags" | "vendors" | "productTypes" | null>(null);

  // Y state
  const [yMode, setYMode] = useState<string>("same-as-x");
  const [yProducts, setYProducts] = useState<ProductItem[]>([]);
  const [yCollections, setYCollections] = useState<CollectionItem[]>([]);
  const [yTags, setYTags] = useState<string[]>([]);
  const [yVendors, setYVendors] = useState<string[]>([]);
  const [yTypes, setYTypes] = useState<string[]>([]);
  const [yQuantity, setYQuantity] = useState(1);
  const [yPickerMode, setYPickerMode] = useState<"tags" | "vendors" | "productTypes" | null>(null);

  // Discount
  const [discountType, setDiscountType] = useState<"free" | "percentage">("free");
  const [discountValue, setDiscountValue] = useState(50);

  // Dates
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  // Resource pickers
  const pickProducts = async (
    current: ProductItem[],
    onSet: (v: ProductItem[]) => void
  ) => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: current.map((p) => ({ id: p.id })),
    });
    if (selected)
      onSet(
        selected.map((p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
          id: p.id,
          title: p.title,
          variants: p.variants ?? [],
        }))
      );
  };

  const pickCollections = async (
    current: CollectionItem[],
    onSet: (v: CollectionItem[]) => void
  ) => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: current.map((c) => ({ id: c.id })),
    });
    if (selected)
      onSet(
        (selected as Array<{ id: string; title: string }>).map((c) => ({
          id: c.id,
          title: c.title,
        }))
      );
  };

  const xExcludedChips = xExcluded.map((p) => ({
    id: p.id,
    title: p.title,
    variantCount: p.variants.length,
  }));

  return (
    <s-page heading={es.nuevaBxgy.titulo}>
      <div style={{ marginBottom: "4px" }}>
        <Link
          to="/app/campaigns"
          style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}
        >
          {es.nuevaBxgy.volver}
        </Link>
      </div>

      {errors.general && <GeneralErrorBanner message={errors.general} />}

      <Form method="post">
        {/* Hidden excluded X products */}
        <input
          type="hidden"
          name="xExcludedJson"
          value={JSON.stringify(xExcluded.map((p) => ({ id: p.id, variants: p.variants })))}
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            gap: "24px",
            alignItems: "start",
          }}
        >
          <div>
            {/* 1. Info general */}
            <Section title={es.nuevaBxgy.secInfoGeneral} defaultOpen>
              <FieldGroup
                label={es.nuevaBxgy.nombreLabel}
                helper={es.nuevaBxgy.nombreHelper}
                error={errors.name}
              >
                <input
                  name="name"
                  type="text"
                  placeholder={es.nuevaBxgy.nombrePlaceholder}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={errors.name ? inputErrorStyle : inputStyle}
                />
              </FieldGroup>
            </Section>

            {/* 2. Compra X */}
            <Section title={es.nuevaBxgy.secCompraX} defaultOpen>
              <SelectionPanel
                prefix="x"
                modes={SELECTION_MODES}
                selectionMode={xMode}
                onModeChange={setXMode}
                selectedProducts={xProducts}
                selectedCollections={xCollections}
                selectedTags={xTags}
                selectedVendors={xVendors}
                selectedProductTypes={xTypes}
                onSelectProducts={() => pickProducts(xProducts, setXProducts)}
                onSelectCollections={() => pickCollections(xCollections, setXCollections)}
                onOpenTagPicker={() => setXPickerMode("tags")}
                onOpenVendorPicker={() => setXPickerMode("vendors")}
                onOpenTypePicker={() => setXPickerMode("productTypes")}
                onRemoveProduct={(id) => setXProducts((p) => p.filter((x) => x.id !== id))}
                onRemoveCollection={(id) => setXCollections((c) => c.filter((x) => x.id !== id))}
                onRemoveTag={(t) => setXTags((v) => v.filter((x) => x !== t))}
                onRemoveVendor={(v) => setXVendors((a) => a.filter((x) => x !== v))}
                onRemoveType={(t) => setXTypes((a) => a.filter((x) => x !== t))}
                error={errors.xProducts}
                btnProductos={es.nuevaBxgy.btnSeleccionarProductos}
                btnColecciones={es.nuevaBxgy.btnSeleccionarColecciones}
                btnTags={es.nuevaBxgy.btnSeleccionarTags}
                btnVendedores={es.nuevaBxgy.btnSeleccionarVendedores}
                btnTipos={es.nuevaBxgy.btnSeleccionarTipos}
              />

              <FieldGroup
                label={es.nuevaBxgy.xCantidadLabel}
                helper={es.nuevaBxgy.xCantidadHelper}
                error={errors.xQuantity}
              >
                <div style={{ display: "flex", width: "160px" }}>
                  <input
                    name="xMinQuantity"
                    type="number"
                    min={1}
                    value={xMinQuantity}
                    onChange={(e) => setXMinQuantity(Math.max(1, Number(e.target.value)))}
                    style={{
                      ...inputStyle,
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
                      whiteSpace: "nowrap",
                    }}
                  >
                    unidades
                  </span>
                </div>
              </FieldGroup>

              {/* Exclusiones X */}
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
                    name="enableXExclusions"
                    checked={enableXExclusions}
                    onChange={(e) => setEnableXExclusions(e.target.checked)}
                  />
                  {es.nuevaBxgy.excluirToggle}
                </label>
                {enableXExclusions && (
                  <div style={{ marginTop: "10px" }}>
                    <p style={{ fontSize: "12px", color: "#6d7175", marginBottom: "8px" }}>
                      {es.nuevaBxgy.excluirHelper}
                    </p>
                    <button
                      type="button"
                      onClick={() => pickProducts(xExcluded, setXExcluded)}
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
                      {es.nuevaBxgy.btnExcluirProductos}
                    </button>
                    <ProductChips
                      products={xExcludedChips}
                      onRemove={(id) => setXExcluded((p) => p.filter((x) => x.id !== id))}
                    />
                  </div>
                )}
              </div>
            </Section>

            {/* 3. Recibe Y */}
            <Section title={es.nuevaBxgy.secRecibeY} defaultOpen>
              <SelectionPanel
                prefix="y"
                modes={Y_SELECTION_MODES}
                selectionMode={yMode}
                onModeChange={setYMode}
                selectedProducts={yProducts}
                selectedCollections={yCollections}
                selectedTags={yTags}
                selectedVendors={yVendors}
                selectedProductTypes={yTypes}
                onSelectProducts={() => pickProducts(yProducts, setYProducts)}
                onSelectCollections={() => pickCollections(yCollections, setYCollections)}
                onOpenTagPicker={() => setYPickerMode("tags")}
                onOpenVendorPicker={() => setYPickerMode("vendors")}
                onOpenTypePicker={() => setYPickerMode("productTypes")}
                onRemoveProduct={(id) => setYProducts((p) => p.filter((x) => x.id !== id))}
                onRemoveCollection={(id) => setYCollections((c) => c.filter((x) => x.id !== id))}
                onRemoveTag={(t) => setYTags((v) => v.filter((x) => x !== t))}
                onRemoveVendor={(v) => setYVendors((a) => a.filter((x) => x !== v))}
                onRemoveType={(t) => setYTypes((a) => a.filter((x) => x !== t))}
                error={errors.yProducts}
                btnProductos={es.nuevaBxgy.btnSeleccionarProductos}
                btnColecciones={es.nuevaBxgy.btnSeleccionarColecciones}
                btnTags={es.nuevaBxgy.btnSeleccionarTags}
                btnVendedores={es.nuevaBxgy.btnSeleccionarVendedores}
                btnTipos={es.nuevaBxgy.btnSeleccionarTipos}
              />

              <FieldGroup
                label={es.nuevaBxgy.yCantidadLabel}
                helper={es.nuevaBxgy.yCantidadHelper}
                error={errors.yQuantity}
              >
                <div style={{ display: "flex", width: "160px" }}>
                  <input
                    name="yQuantity"
                    type="number"
                    min={1}
                    value={yQuantity}
                    onChange={(e) => setYQuantity(Math.max(1, Number(e.target.value)))}
                    style={{
                      ...inputStyle,
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
                      whiteSpace: "nowrap",
                    }}
                  >
                    unidades
                  </span>
                </div>
              </FieldGroup>
            </Section>

            {/* 4. Descuento sobre Y */}
            <Section title={es.nuevaBxgy.secDescuento} defaultOpen>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                  marginTop: "8px",
                }}
              >
                <FieldGroup label={es.nuevaBxgy.descuentoTipoLabel}>
                  <select
                    name="discountType"
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as "free" | "percentage")}
                    style={inputStyle}
                  >
                    <option value="free">{es.nuevaBxgy.descuentoGratis}</option>
                    <option value="percentage">{es.nuevaBxgy.descuentoPorcentaje}</option>
                  </select>
                </FieldGroup>

                {discountType === "percentage" && (
                  <FieldGroup
                    label={es.nuevaBxgy.descuentoValorLabel}
                    helper={es.nuevaBxgy.descuentoValorHelper}
                    error={errors.discountValue}
                  >
                    <div style={{ display: "flex", width: "100%" }}>
                      <input
                        name="discountValue"
                        type="number"
                        min={1}
                        max={99}
                        value={discountValue}
                        onChange={(e) =>
                          setDiscountValue(Math.max(1, Math.min(99, Number(e.target.value))))
                        }
                        style={{
                          ...(errors.discountValue ? inputErrorStyle : inputStyle),
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
                )}
              </div>
            </Section>

            {/* 5. Programar campaña */}
            <Section title={es.nuevaBxgy.secProgramacion} defaultOpen={false}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                  marginTop: "8px",
                }}
              >
                <FieldGroup
                  label={es.nuevaBxgy.fechaInicioLabel}
                  helper={es.nuevaBxgy.fechaInicioHelper}
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
                  label={es.nuevaBxgy.fechaFinLabel}
                  helper={es.nuevaBxgy.fechaFinHelper}
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

          {/* Preview panel */}
          <div style={{ position: "sticky", top: "24px" }}>
            <BxgyPreview
              name={name}
              xMode={xMode}
              xProductCount={xProducts.length}
              xMinQuantity={xMinQuantity}
              yMode={yMode}
              yProductCount={yProducts.length}
              yQuantity={yQuantity}
              discountType={discountType}
              discountValue={discountValue}
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
            {es.nuevaBxgy.btnCancelar}
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
              {es.nuevaBxgy.btnBorrador}
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
              {isSubmitting ? es.nuevaBxgy.btnCargando : es.nuevaBxgy.btnActivar}
            </Btn>
          </div>
        </ActionBar>
      </Form>

      {/* ItemPickers — X */}
      <ItemPicker
        open={xPickerMode === "tags"}
        title={es.nuevaBxgy.btnSeleccionarTags}
        items={availableTags.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={xTags}
        onConfirm={(ids) => { setXTags(ids); setXPickerMode(null); }}
        onCancel={() => setXPickerMode(null)}
      />
      <ItemPicker
        open={xPickerMode === "vendors"}
        title={es.nuevaBxgy.btnSeleccionarVendedores}
        items={availableVendors.map((v): PickerItem => ({ id: v, label: v }))}
        selectedIds={xVendors}
        onConfirm={(ids) => { setXVendors(ids); setXPickerMode(null); }}
        onCancel={() => setXPickerMode(null)}
      />
      <ItemPicker
        open={xPickerMode === "productTypes"}
        title={es.nuevaBxgy.btnSeleccionarTipos}
        items={availableProductTypes.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={xTypes}
        onConfirm={(ids) => { setXTypes(ids); setXPickerMode(null); }}
        onCancel={() => setXPickerMode(null)}
      />

      {/* ItemPickers — Y */}
      <ItemPicker
        open={yPickerMode === "tags"}
        title={es.nuevaBxgy.btnSeleccionarTags}
        items={availableTags.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={yTags}
        onConfirm={(ids) => { setYTags(ids); setYPickerMode(null); }}
        onCancel={() => setYPickerMode(null)}
      />
      <ItemPicker
        open={yPickerMode === "vendors"}
        title={es.nuevaBxgy.btnSeleccionarVendedores}
        items={availableVendors.map((v): PickerItem => ({ id: v, label: v }))}
        selectedIds={yVendors}
        onConfirm={(ids) => { setYVendors(ids); setYPickerMode(null); }}
        onCancel={() => setYPickerMode(null)}
      />
      <ItemPicker
        open={yPickerMode === "productTypes"}
        title={es.nuevaBxgy.btnSeleccionarTipos}
        items={availableProductTypes.map((t): PickerItem => ({ id: t, label: t }))}
        selectedIds={yTypes}
        onConfirm={(ids) => { setYTypes(ids); setYPickerMode(null); }}
        onCancel={() => setYPickerMode(null)}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
