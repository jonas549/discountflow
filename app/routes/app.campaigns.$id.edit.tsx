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
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import {
  applyPercentageDiscount,
  revertPercentageDiscount,
  reactivatePercentageDiscount,
  type SelectedProductInput,
} from "../lib/discounts/percentage";
import { getCollections } from "../lib/shopify/admin-api";
import { es } from "../i18n";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const campaign = await prisma.campaign.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!campaign) throw new Response("Not found", { status: 404 });

  const uniqueProducts = await prisma.campaignProduct.groupBy({
    by: ["shopifyProductId"],
    where: { campaignId: campaign.id },
  });

  const collections = await getCollections(admin);

  const config = campaign.config as {
    discountPercent: number;
    showCompareAtPrice?: boolean;
    selectionMode?: string;
    collectionId?: string;
  };

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      discountPercent: config.discountPercent,
      useCompareAtPriceAsBase: config.showCompareAtPrice ?? false,
      selectionMode: (config.selectionMode ?? "products") as
        | "products"
        | "collections"
        | "all",
      collectionId: config.collectionId ?? "",
      existingProductsCount: uniqueProducts.length,
      startsAt: campaign.startsAt
        ? campaign.startsAt.toISOString().slice(0, 16)
        : "",
      endsAt: campaign.endsAt
        ? campaign.endsAt.toISOString().slice(0, 16)
        : "",
    },
    collections,
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

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const campaignId = params.id!;

  const name = (formData.get("name") as string | null) ?? "";
  const discountPercent = Number(formData.get("discountPercent"));
  const useCompareAtPriceAsBase = formData.get("useCompareAtPriceAsBase") === "on";
  const selectionMode = (formData.get("selectionMode") as string) || "products";
  const selectedProductsJson = (formData.get("selectedProductsJson") as string) || "[]";
  const collectionId = (formData.get("collectionId") as string) || "";
  const enableExclusions = formData.get("enableExclusions") === "on";
  const excludedProductsJson = (formData.get("excludedProductsJson") as string) || "[]";
  const startsAt = (formData.get("startsAt") as string) || "";
  const endsAt = (formData.get("endsAt") as string) || "";
  const intent = (formData.get("intent") as "draft" | "activate") || "draft";

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const existing = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id },
  });
  if (!existing) throw new Response("Not found", { status: 404 });

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

  // For products mode, require at least one product OR existing products in DB
  if (selectionMode === "products" && selectedProducts.length === 0) {
    const existingCount = await prisma.campaignProduct.count({
      where: { campaignId },
    });
    if (existingCount === 0) errors.products = es.nuevaPorcentaje.errProductos;
  }
  if (selectionMode === "collections" && !collectionId)
    errors.products = "Debes seleccionar una colección";

  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))
    errors.dates = es.nuevaPorcentaje.errFechas;

  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  const campaignStartsAt = startsAt ? new Date(startsAt) : null;
  const campaignEndsAt = endsAt ? new Date(endsAt) : null;
  const isScheduled = campaignStartsAt !== null && campaignStartsAt > new Date();
  const shouldActivate = intent === "activate" && !isScheduled;

  // Revert prices if currently active
  if (existing.status === "ACTIVE") {
    await revertPercentageDiscount(admin, campaignId);
  }

  // Update campaign record with new config (including selectionMode for future edits)
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      name: name.trim(),
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

  if (shouldActivate) {
    const hasNewProducts = selectedProducts.length > 0;
    const isCollectionsWithId = selectionMode === "collections" && collectionId;
    const isAllStore = selectionMode === "all";

    if (hasNewProducts || isCollectionsWithId || isAllStore) {
      // User provided a new selection — replace existing CampaignProduct records
      await prisma.campaignProduct.deleteMany({ where: { campaignId } });

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

      try {
        await applyPercentageDiscount(admin, campaignId, {
          discountPercent,
          useCompareAtPriceAsBase,
          selectionMode: selectionMode as "products" | "collections" | "all",
          selectedProducts: selectionMode === "products" ? selectedProducts : undefined,
          collectionId: selectionMode === "collections" ? collectionId : undefined,
          excludedVariantIds,
        });
      } catch (err) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "DRAFT" },
        });
        return Response.json(
          { errors: { general: `Error al aplicar el descuento: ${String(err)}` } },
          { status: 500 }
        );
      }
    } else {
      // No new products provided — re-apply to existing CampaignProduct records
      try {
        await reactivatePercentageDiscount(admin, campaignId);
      } catch (err) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "DRAFT" },
        });
        return Response.json(
          { errors: { general: `Error al reactivar el descuento: ${String(err)}` } },
          { status: 500 }
        );
      }
    }
  }

  return redirect("/app/campaigns");
};

// ─── UI helpers (same as new.percentage) ─────────────────────────────────────

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

// ─── Main component ───────────────────────────────────────────────────────────

export default function EditPercentageCampaign() {
  const { campaign, collections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: ActionErrors }
    | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};

  const [name, setName] = useState(campaign.name);
  const [discountPercent, setDiscountPercent] = useState(campaign.discountPercent);
  const [useCompareAtPriceAsBase, setUseCompareAtPriceAsBase] = useState(
    campaign.useCompareAtPriceAsBase
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectionMode, setSelectionMode] = useState<"products" | "collections" | "all">(
    campaign.selectionMode
  );
  const [collectionId, setCollectionId] = useState(campaign.collectionId);
  const [selectedProducts, setSelectedProducts] = useState<
    Array<{ id: string; title: string; variants: Array<{ id: string }> }>
  >([]);
  const [enableExclusions, setEnableExclusions] = useState(false);
  const [excludedProducts, setExcludedProducts] = useState<
    Array<{ id: string; title: string; variants: Array<{ id: string }> }>
  >([]);
  const [startsAt, setStartsAt] = useState(campaign.startsAt);
  const [endsAt, setEndsAt] = useState(campaign.endsAt);

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

  // Cantidad de productos para el panel de preview
  const productsCount =
    selectionMode === "all"
      ? ("∞" as const)
      : selectedProducts.length > 0
      ? selectedProducts.length
      : campaign.existingProductsCount;

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
    <s-page heading={es.editarPorcentaje.titulo}>
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

        {/* Layout 2 columnas: secciones izquierda + preview derecha */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "24px", alignItems: "start" }}>
          <div>

        {/* 1. Información general */}
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

        {/* 2. Descuento */}
        <Section title={es.nuevaPorcentaje.secDescuento} defaultOpen>
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

          <div
            style={{ marginTop: "16px", borderTop: "1px solid #f1f2f3", paddingTop: "14px" }}
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

        {/* 3. Productos */}
        <Section title={es.nuevaPorcentaje.secProductos} defaultOpen>
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
                  {campaign.existingProductsCount > 0
                    ? es.editarPorcentaje.reemplazarSeleccion
                    : es.nuevaPorcentaje.btnSeleccionarProductos}
                </button>
              )}
            </div>
          </div>

          {selectionMode === "products" && (
            <div style={{ marginTop: "8px" }}>
              {campaign.existingProductsCount > 0 && selectedProducts.length === 0 && (
                <div
                  style={{
                    marginTop: "10px",
                    background: "#f1f8f5",
                    border: "1px solid #b5e3d8",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    fontSize: "12px",
                    color: "#007a5a",
                  }}
                >
                  ✓ {campaign.existingProductsCount} {es.editarPorcentaje.productosActuales}
                </div>
              )}
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
            style={{ marginTop: "18px", borderTop: "1px solid #f1f2f3", paddingTop: "14px" }}
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

        {/* 4. Programar campaña */}
        <Section title={es.nuevaPorcentaje.secProgramacion} defaultOpen>
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
              productsCount={productsCount}
              startsAt={startsAt}
              endsAt={endsAt}
              currentStatus={campaign.status}
            />
          </div>
        </div>{/* fin grid */}

        {/* Action bar */}
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
              {isSubmitting
                ? es.editarPorcentaje.btnCargando
                : es.editarPorcentaje.btnGuardar}
            </Btn>
          </div>
        </div>
      </Form>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
