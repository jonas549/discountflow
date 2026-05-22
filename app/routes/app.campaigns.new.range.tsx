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
import { Btn } from "../components/Btn";
import { RangeDiscountPreview } from "../components/RangeDiscountPreview";
import { ItemPicker, type PickerItem } from "../components/ItemPicker";
import {
  Section,
  FieldGroup,
  ProductChips,
  StringChips,
  CollectionChips,
  ActionBar,
  GeneralErrorBanner,
  inputStyle,
  inputErrorStyle,
} from "../components/CampaignFormShared";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { applyRangeDiscount, type RangeMode } from "../lib/discounts/range";
import type { SelectedProductInput, SelectionMode } from "../lib/shopify/resolve-variants";
import { getCollections, getProductMetadata } from "../lib/shopify/admin-api";
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
  value?: string;
  products?: string;
  dates?: string;
  general?: string;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const name = (formData.get("name") as string | null) ?? "";
  const mode = (formData.get("mode") as RangeMode | null) ?? "fixedPrice";
  const value = Number(formData.get("value"));
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
  if (!name.trim()) errors.name = es.nuevaRango.errNombre;
  if (!value || value <= 0) errors.value = es.nuevaRango.errValor;

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
    errors.products = es.nuevaRango.errProductos;
  if (selectionMode === "collections" && collectionIds.length === 0)
    errors.products = "Debes seleccionar al menos una colección";
  if (selectionMode === "tags" && selectedTags.length === 0)
    errors.products = "Debes seleccionar al menos un tag";
  if (selectionMode === "vendors" && selectedVendors.length === 0)
    errors.products = "Debes seleccionar al menos un vendedor";
  if (selectionMode === "productTypes" && selectedProductTypes.length === 0)
    errors.products = "Debes seleccionar al menos un tipo de producto";

  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))
    errors.dates = es.nuevaRango.errFechas;

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

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name: name.trim(),
      type: "RANGE",
      status: shouldActivate ? "ACTIVE" : "DRAFT",
      config: {
        mode,
        value,
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

  let skipped = 0;
  if (shouldActivate) {
    try {
      const result = await applyRangeDiscount(admin, campaign.id, {
        mode,
        value,
        selectionMode: selectionMode as SelectionMode,
        selectedProducts: selectionMode === "products" ? selectedProducts : undefined,
        collectionIds: selectionMode === "collections" ? collectionIds : undefined,
        selectedTags: selectionMode === "tags" ? selectedTags : undefined,
        selectedVendors: selectionMode === "vendors" ? selectedVendors : undefined,
        selectedProductTypes: selectionMode === "productTypes" ? selectedProductTypes : undefined,
        excludedVariantIds,
      });
      skipped = result.skipped;
    } catch (err) {
      await prisma.campaign.delete({ where: { id: campaign.id } });
      return Response.json(
        { errors: { general: `Error al aplicar el descuento: ${String(err)}` } },
        { status: 500 }
      );
    }
  }

  return redirect(`/app/campaigns${skipped > 0 ? `?skipped=${skipped}` : ""}`);
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewRangeCampaign() {
  const { collections, availableTags, availableVendors, availableProductTypes } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: ActionErrors }
    | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};

  const [name, setName] = useState("");
  const [mode, setMode] = useState<RangeMode>("fixedPrice");
  const [value, setValue] = useState(0);
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
        selected.map((p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
          id: p.id,
          title: p.title,
          variants: p.variants ?? [],
        }))
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
        selected.map((p: { id: string; title: string; variants: Array<{ id: string }> }) => ({
          id: p.id,
          title: p.title,
          variants: p.variants ?? [],
        }))
      );
    }
  };

  const valueHelper =
    mode === "fixedPrice" ? es.nuevaRango.helperFijo : es.nuevaRango.helperMonto;

  return (
    <s-page heading={es.nuevaRango.titulo}>
      <div style={{ marginBottom: "4px" }}>
        <Link to="/app/campaigns" style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}>
          {es.nuevaRango.volver}
        </Link>
      </div>

      {errors.general && <GeneralErrorBanner message={errors.general} />}

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
        <input type="hidden" name="selectedTagsJson" value={JSON.stringify(selectedTags)} />
        <input type="hidden" name="selectedVendorsJson" value={JSON.stringify(selectedVendors)} />
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            gap: "24px",
            alignItems: "start",
          }}
        >
          <div>
            {/* ─── 1. Información general ─── */}
            <Section title={es.nuevaRango.secInfoGeneral} defaultOpen>
              <FieldGroup
                label={es.nuevaRango.nombreLabel}
                helper={es.nuevaRango.nombreHelper}
                error={errors.name}
              >
                <input
                  name="name"
                  type="text"
                  placeholder={es.nuevaRango.nombrePlaceholder}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={errors.name ? inputErrorStyle : inputStyle}
                />
              </FieldGroup>
            </Section>

            {/* ─── 2. Precio promocional ─── */}
            <Section title={es.nuevaRango.secPrecio} defaultOpen>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <FieldGroup label={es.nuevaRango.tipoDescuentoLabel}>
                  <select
                    name="mode"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as RangeMode)}
                    style={inputStyle}
                  >
                    <option value="fixedPrice">{es.nuevaRango.modoFijo}</option>
                    <option value="fixedAmount">{es.nuevaRango.modoMonto}</option>
                  </select>
                </FieldGroup>

                <FieldGroup
                  label={es.nuevaRango.valorLabel}
                  helper={valueHelper}
                  error={errors.value}
                >
                  <div style={{ display: "flex", width: "100%" }}>
                    <span
                      style={{
                        background: "#f1f2f3",
                        border: "1px solid #c9cccf",
                        borderRight: "none",
                        borderRadius: "6px 0 0 6px",
                        padding: "8px 12px",
                        fontSize: "14px",
                        color: "#6d7175",
                      }}
                    >
                      $
                    </span>
                    <input
                      name="value"
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={value === 0 ? "" : value}
                      placeholder="0.00"
                      onChange={(e) => setValue(Math.max(0, Number(e.target.value)))}
                      style={{
                        ...(errors.value ? inputErrorStyle : inputStyle),
                        borderRadius: "0 6px 6px 0",
                        flex: 1,
                        minWidth: 0,
                      }}
                    />
                  </div>
                </FieldGroup>
              </div>
            </Section>

            {/* ─── 3. Productos ─── */}
            <Section title={es.nuevaRango.secProductos} defaultOpen>
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

              {selectionMode === "products" && selectedProducts.length > 0 && (
                <div style={{ marginTop: "10px" }}>
                  <ProductChips
                    products={selectedProducts.map((p) => ({
                      id: p.id,
                      title: p.title,
                      variantCount: p.variants.length,
                    }))}
                    onRemove={(id) =>
                      setSelectedProducts((prev) => prev.filter((p) => p.id !== id))
                    }
                  />
                  <p style={{ fontSize: "12px", color: "#6d7175", marginTop: "6px" }}>
                    {selectedProducts.length} {es.nuevaRango.productosSeleccionados}
                  </p>
                </div>
              )}

              {selectionMode === "collections" && (
                <CollectionChips
                  collections={selectedCollections}
                  onRemove={(id) =>
                    setSelectedCollections((prev) => prev.filter((c) => c.id !== id))
                  }
                />
              )}

              {selectionMode === "tags" && (
                <StringChips
                  values={selectedTags}
                  onRemove={(v) => setSelectedTags((prev) => prev.filter((x) => x !== v))}
                />
              )}

              {selectionMode === "vendors" && (
                <StringChips
                  values={selectedVendors}
                  onRemove={(v) => setSelectedVendors((prev) => prev.filter((x) => x !== v))}
                />
              )}

              {selectionMode === "productTypes" && (
                <StringChips
                  values={selectedProductTypes}
                  onRemove={(v) =>
                    setSelectedProductTypes((prev) => prev.filter((x) => x !== v))
                  }
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
                  ✓ {es.nuevaRango.msgTodaTienda}
                </div>
              )}

              {/* Exclusiones */}
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
                  {es.nuevaRango.excluirToggle}
                </label>
                {enableExclusions && (
                  <div style={{ marginTop: "10px" }}>
                    <p style={{ fontSize: "12px", color: "#6d7175", marginBottom: "8px" }}>
                      {es.nuevaRango.excluirHelper}
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
                      {es.nuevaRango.btnExcluirProductos}
                    </button>
                    <ProductChips
                      products={excludedProducts.map((p) => ({
                        id: p.id,
                        title: p.title,
                        variantCount: p.variants.length,
                      }))}
                      onRemove={(id) =>
                        setExcludedProducts((prev) => prev.filter((p) => p.id !== id))
                      }
                    />
                  </div>
                )}
              </div>
            </Section>

            {/* ─── 4. Programar campaña ─── */}
            <Section title={es.nuevaRango.secProgramacion} defaultOpen={false}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                  marginTop: "8px",
                }}
              >
                <FieldGroup
                  label={es.nuevaRango.fechaInicioLabel}
                  helper={es.nuevaRango.fechaInicioHelper}
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
                  label={es.nuevaRango.fechaFinLabel}
                  helper={es.nuevaRango.fechaFinHelper}
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

          {/* Columna derecha: preview */}
          <div style={{ position: "sticky", top: "24px" }}>
            <RangeDiscountPreview
              mode={mode}
              value={value}
              name={name}
              productsDescription={productsDescription}
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
            {es.nuevaRango.btnCancelar}
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
              {es.nuevaRango.btnBorrador}
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
              {isSubmitting ? es.nuevaRango.btnCargando : es.nuevaRango.btnActivar}
            </Btn>
          </div>
        </ActionBar>
      </Form>

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
