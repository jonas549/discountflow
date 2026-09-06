// Formulario compartido de campañas CODE_ORIGINAL_PRICE (cupón sobre el precio
// original). Lo usan la ruta de creación y la de edición: la única diferencia
// entre ambas son los valores iniciales y las etiquetas de los botones.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 LA ESTRUCTURA NO ES LIBRE. Es la misma que las otras seis campañas.
//
//   · Rejilla `minmax(0,1fr) 320px`, `gap: 20px`, `alignItems: start`.
//   · Secciones plegables numeradas a la izquierda (`Section`, `FieldGroup`).
//   · Panel `position: sticky; top: 12px` a la derecha, con DOS tarjetas
//     —«Vista previa» y «Resumen»— más las advertencias y las notas al pie.
//   · Los avisos que afectan a la campaña entera van de banner ARRIBA de la
//     rejilla, no sueltos entre las secciones.
//   · `ActionBar` al final: primario, borrador, y «Cancelar» a la derecha.
//   · Todos los textos en `es.nuevoCupon`, no incrustados acá.
//
// `campaign-forms.test.ts` lo comprueba sobre los siete formularios.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { Form, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Btn } from "./Btn";
import {
  Section,
  FieldGroup,
  ProductChips,
  CollectionChips,
  inputStyle,
  inputErrorStyle,
  ActionBar,
  GeneralErrorBanner,
  DecimalInput,
} from "./CampaignFormShared";
import {
  computeOriginalPriceDiscount,
  validateOriginalPrice,
  MAX_ORIGINAL_PRICE_PERCENT,
} from "../lib/discounts/original-price-calc";
import {
  normalizeDiscountCode,
  type OriginalPriceSelectionMode,
  type OriginalPriceMinimumType,
  type OriginalPriceMetodo,
  exclusionQueAnulaElCupon,
} from "../lib/discounts/original-price-client";
import type { CampanasQuePuedenChocar } from "./CartValueCampaignForm";
import { es } from "../i18n";

export type OriginalPriceFormErrors = {
  name?: string;
  code?: string;
  percent?: string;
  selection?: string;
  usageLimit?: string;
  minimum?: string;
  dates?: string;
  general?: string;
};

/** Un producto elegido, con lo que hace falta para pintar su chip. */
export type OriginalPriceProduct = { id: string; title: string; variantCount: number };
export type OriginalPriceCollection = { id: string; title: string };

export type OriginalPriceFormInitial = {
  name: string;
  code: string;
  percent: number;
  message: string;
  excludedPackCampaignIds: string[];
  excludedCartValueCampaignIds: string[];

  /** Código o automático. Ausente en las campañas viejas = código. */
  metodo: OriginalPriceMetodo;

  selectionMode: OriginalPriceSelectionMode;
  products: OriginalPriceProduct[];
  collections: OriginalPriceCollection[];

  limitarUsos: boolean;
  usageLimit: number | null;
  oncePerCustomer: boolean;

  minimumType: OriginalPriceMinimumType;
  minSubtotal: number | null;
  minQuantity: number | null;

  startsAt: string;
  endsAt: string;
};

/** Los tres modos que se ofrecen. El orden es el de la pantalla nativa. */
const MODOS: Array<{ value: OriginalPriceSelectionMode; labelKey: "modoTodo" | "modoProductos" | "modoColecciones" }> = [
  { value: "all", labelKey: "modoTodo" },
  { value: "products", labelKey: "modoProductos" },
  { value: "collections", labelKey: "modoColecciones" },
];

/** El producto de la vista previa: el ejemplo del brief, $100 hoy a $85. */
const EJEMPLO_LISTA = 100;
const EJEMPLO_HOY = 85;

const money = (n: number) =>
  `$${n.toLocaleString("es-CL", { maximumFractionDigits: 2 })}`;

export function OriginalPriceCampaignForm({
  initial,
  campanas,
  errors,
  limitExceeded,
  isSubmitting,
  showDraftButton,
  primaryLabel,
}: {
  initial: OriginalPriceFormInitial;
  /** Packs (excluibles) y campañas que bloquean sin remedio. */
  campanas: CampanasQuePuedenChocar;
  errors: OriginalPriceFormErrors;
  limitExceeded?: boolean;
  isSubmitting: boolean;
  showDraftButton: boolean;
  primaryLabel: string;
}) {
  const t = es.nuevoCupon;

  const [name, setName] = useState(initial.name);
  const [code, setCode] = useState(initial.code);
  const [percent, setPercent] = useState(initial.percent);
  const [message, setMessage] = useState(initial.message);
  const [excluidos, setExcluidos] = useState<string[]>(initial.excludedPackCampaignIds);
  const [excluidosMonto, setExcluidosMonto] = useState<string[]>(
    initial.excludedCartValueCampaignIds
  );
  const [metodo, setMetodo] = useState<OriginalPriceMetodo>(initial.metodo);
  const usaCodigo = metodo === "CODE";
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);

  // ── A qué aplica ──────────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState<OriginalPriceSelectionMode>(
    initial.selectionMode
  );
  const [products, setProducts] = useState<OriginalPriceProduct[]>(initial.products);
  const [collections, setCollections] = useState<OriginalPriceCollection[]>(
    initial.collections
  );

  // ── Límite de usos ────────────────────────────────────────────────────────
  const [limitarUsos, setLimitarUsos] = useState(initial.limitarUsos);
  const [usageLimit, setUsageLimit] = useState<string>(
    initial.usageLimit === null ? "" : String(initial.usageLimit)
  );
  const [oncePerCustomer, setOncePerCustomer] = useState(initial.oncePerCustomer);

  // ── Requisitos mínimos ────────────────────────────────────────────────────
  const [minimumType, setMinimumType] = useState<OriginalPriceMinimumType>(
    initial.minimumType
  );
  const [minSubtotal, setMinSubtotal] = useState<number>(initial.minSubtotal ?? 0);
  const [minQuantity, setMinQuantity] = useState<string>(
    initial.minQuantity === null ? "" : String(initial.minQuantity)
  );

  /**
   * Los errores del servidor se ocultan en cuanto el merchant toca el campo que
   * los provocó. Sin esto el formulario parece trancado: los mensajes vienen de
   * `actionData`, que React Router conserva hasta el siguiente envío, y nada
   * los recalcula. Es el bug que se arregló el 2026-08-08 en los otros.
   */
  const [tocado, setTocado] = useState<Record<string, boolean>>({});
  const err = (k: keyof OriginalPriceFormErrors) => (tocado[k] ? undefined : errors[k]);
  const marcar = (k: keyof OriginalPriceFormErrors) =>
    setTocado((prev) => (prev[k] ? prev : { ...prev, [k]: true }));

  const shopify = useAppBridge();

  /**
   * Los dos selectores son el resourcePicker de App Bridge, el mismo que usan
   * Escalonado y BxGy. No es "el mismo aspecto": es el mismo componente, así
   * que el merchant no tiene que aprender una segunda forma de elegir.
   */
  const elegirProductos = async () => {
    const elegidos = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: products.map((p) => ({ id: p.id })),
    });
    if (elegidos)
      setProducts(
        (
          elegidos as Array<{ id: string; title: string; variants?: Array<{ id: string }> }>
        ).map((p) => ({
          id: p.id,
          title: p.title,
          variantCount: p.variants?.length ?? 0,
        }))
      );
    marcar("selection");
  };

  const elegirColecciones = async () => {
    const elegidas = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: collections.map((c) => ({ id: c.id })),
    });
    if (elegidas)
      setCollections(
        (elegidas as Array<{ id: string; title: string }>).map((c) => ({
          id: c.id,
          title: c.title,
        }))
      );
    marcar("selection");
  };

  const advertencias = validateOriginalPrice(percent).warnings;

  /**
   * 🔴 La combinación que no puede aplicar nunca. Ver `exclusionQueAnulaElCupon`.
   *
   * Se calcula en vivo, con los umbrales que ya trae el loader, así que el
   * merchant lo ve mientras configura y no después de guardar y no entender por
   * qué su cupón no hace nada.
   */
  const anulado = exclusionQueAnulaElCupon(
    { minimumType, minSubtotal },
    campanas.montosDeCompra.filter((m) => excluidosMonto.includes(m.id))
  );

  const toggleExcluido = (id: string) =>
    setExcluidos((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.concat(id)));

  const toggleExcluidoMonto = (id: string) =>
    setExcluidosMonto((xs) =>
      xs.includes(id) ? xs.filter((x) => x !== id) : xs.concat(id)
    );

  /** Estilo de las casillas de exclusión. Idéntico en los dos grupos. */
  const casillaStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginTop: "10px",
    fontSize: "13px",
    cursor: "pointer",
  };

  /** Encabezado de un grupo dentro de la sección de exclusiones. */
  const grupoStyle: React.CSSProperties = {
    fontSize: "12px",
    fontWeight: 600,
    color: "#6d7175",
    margin: "16px 0 0",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };

  /**
   * La vista previa sale del MISMO módulo que la Function del checkout, así que
   * no puede mostrar un número distinto del que el comprador va a pagar.
   *
   * El ejemplo es fijo —$100 de lista, $85 hoy— a propósito: lo que el merchant
   * necesita entender de un vistazo no es su catálogo, es la DIFERENCIA con un
   * cupón normal. Con un ejemplo estable esa diferencia se lee sola.
   */
  const preview = computeOriginalPriceDiscount(percent, [
    {
      lineId: "preview",
      unitPrice: EJEMPLO_HOY,
      compareAtUnitPrice: EJEMPLO_LISTA,
      quantity: 1,
    },
  ]);
  const descuento = preview.applies ? preview.lines[0].discountPerUnit : 0;
  const normal = Math.round(EJEMPLO_HOY * percent) / 100;
  const extra = Math.round((descuento - normal) * 100) / 100;

  let nSeccion = 0;
  const num = (titulo: string) => `${++nSeccion} · ${titulo}`;

  return (
    <Form method="post">
      {/* ═══════════════════════════════════════════════════════════════════
          🔴 TODO EL ESTADO VA ACÁ, FUERA DE LAS SECCIONES.

          `Section` pinta `{open && (...)}`: al plegarse DESMONTA sus hijos, y
          un input desmontado NO viaja en el FormData. Con los campos dentro,
          plegar «A qué aplica» antes de guardar dejaba la campaña en «toda la
          tienda» sin avisar, y plegar «Programación» —que arranca plegada—
          borraba las fechas.

          Los controles visibles de abajo NO llevan `name` a propósito: solo
          mueven el estado. La única fuente de lo que se envía es este bloque.
          Es el mismo patrón que `TieredCampaignForm`.
          ═══════════════════════════════════════════════════════════════════ */}
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="message" value={message} />
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="percent" value={String(percent)} />

      <input type="hidden" name="selectionMode" value={selectionMode} />
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

      <input type="hidden" name="minimumType" value={minimumType} />
      <input type="hidden" name="minSubtotal" value={String(minSubtotal)} />
      <input type="hidden" name="minQuantity" value={minQuantity} />

      {/* Las casillas se envían como "on" para que el parseo sea el mismo que
          si vinieran de un checkbox de verdad. */}
      <input type="hidden" name="limitarUsos" value={limitarUsos ? "on" : ""} />
      <input type="hidden" name="usageLimit" value={usageLimit} />
      <input
        type="hidden"
        name="oncePerCustomer"
        value={oncePerCustomer ? "on" : ""}
      />

      <input type="hidden" name="metodo" value={metodo} />
      <input type="hidden" name="excludedPacksJson" value={JSON.stringify(excluidos)} />
      <input
        type="hidden"
        name="excludedMontosJson"
        value={JSON.stringify(excluidosMonto)}
      />

      <input type="hidden" name="startsAt" value={startsAt} />
      <input type="hidden" name="endsAt" value={endsAt} />

      {errors.general && (
        <GeneralErrorBanner message={errors.general} limitExceeded={limitExceeded} />
      )}

      {/* Arriba de la rejilla, igual que en los otros: es una advertencia sobre
          la campaña entera, no sobre un campo. */}
      {anulado && (
        <div
          style={{
            background: "#fbeae5",
            border: "1px solid #d82c0d",
            borderRadius: "8px",
            padding: "12px 16px",
            color: "#8e1f0b",
            fontSize: "14px",
            marginBottom: "16px",
            lineHeight: 1.5,
          }}
        >
          {t.avisoImposible(
            anulado.name,
            money(anulado.minSubtotal),
            money(minSubtotal)
          )}
        </div>
      )}

      {campanas.bloqueantes.length > 0 && (
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
          {t.avisoBloqueantes(campanas.bloqueantes.join(" · "))}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 320px",
          gap: "20px",
          alignItems: "start",
        }}
      >
        <div>
          {/* ── 1 · Información general ── */}
          <Section title={num(t.secInfoGeneral)}>
            <FieldGroup label={t.nombreLabel} helper={t.nombreHelper} error={err("name")}>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  marcar("name");
                }}
                placeholder={t.nombrePlaceholder}
                style={err("name") ? inputErrorStyle : inputStyle}
              />
            </FieldGroup>

            <FieldGroup label={t.mensajeLabel} helper={t.mensajeHelper}>
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                style={inputStyle}
              />
            </FieldGroup>
          </Section>

          {/* ── 2 · Método ── */}
          <Section title={num(t.secMetodo)}>
            <FieldGroup label={t.metodoLabel}>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {(
                  [
                    ["CODE", t.metodoCodigo, t.metodoCodigoHelper],
                    ["AUTOMATIC", t.metodoAutomatico, t.metodoAutomaticoHelper],
                  ] as const
                ).map(([valor, etiqueta, ayuda]) => (
                  <label
                    key={valor}
                    style={{
                      display: "flex",
                      gap: "10px",
                      alignItems: "flex-start",
                      border: `1px solid ${metodo === valor ? "#008060" : "#c9cccf"}`,
                      background: metodo === valor ? "#f1f8f5" : "#fff",
                      borderRadius: "8px",
                      padding: "12px 14px",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="metodoRadio"
                      checked={metodo === valor}
                      onChange={() => setMetodo(valor)}
                      style={{ marginTop: "2px" }}
                    />
                    <span>
                      <strong style={{ fontSize: "13px" }}>{etiqueta}</strong>
                      <span
                        style={{
                          display: "block",
                          fontSize: "12px",
                          color: "#6d7175",
                          marginTop: "2px",
                          lineHeight: 1.45,
                        }}
                      >
                        {ayuda}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </FieldGroup>

            {/* Que el código se conserva hay que DECIRLO: el campo desaparece
                de la pantalla, y sin este aviso el merchant no tiene forma de
                saber si lo perdió. Fue el bug reportado el 2026-09-06. */}
            {!usaCodigo && code.trim().length > 0 && (
              <p
                style={{
                  fontSize: "12px",
                  color: "#6d7175",
                  marginTop: "12px",
                  lineHeight: 1.5,
                }}
              >
                {t.codigoConservado(code)}
              </p>
            )}
          </Section>

          {/* ── 3 · El código — solo si el método lo usa ── */}
          {usaCodigo && (
          <Section title={num(t.secCodigo)}>
            <FieldGroup label={t.codigoLabel} helper={t.codigoHelper} error={err("code")}>
              <input
                value={code}
                onChange={(e) => {
                  // Se normaliza mientras escribe: lo que el merchant ve es
                  // exactamente lo que se va a guardar y lo que Shopify va a
                  // aceptar. Sin esto, escribir "maria 10" guardaría "MARIA10" y
                  // el merchant le dictaría al influencer un código que no es.
                  setCode(normalizeDiscountCode(e.target.value));
                  marcar("code");
                }}
                placeholder={t.codigoPlaceholder}
                style={{
                  ...(err("code") ? inputErrorStyle : inputStyle),
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  letterSpacing: "0.04em",
                }}
              />
            </FieldGroup>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "10px" }}>
              {t.codigoUno}
            </p>
          </Section>
          )}

          {/* ── 3 · El descuento ── */}
          <Section title={num(t.secDescuento)}>
            <FieldGroup
              label={t.porcentajeLabel}
              helper={t.porcentajeHelper}
              error={err("percent")}
            >
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <DecimalInput
                  value={percent}
                  onChange={(n) => {
                    setPercent(n);
                    marcar("percent");
                  }}
                  style={{ ...inputStyle, width: "110px" }}
                />
                <span style={{ fontSize: "13px" }}>%</span>
              </div>
            </FieldGroup>

            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
              {t.comoFunciona}
            </p>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>
              {t.sinComparativo}
            </p>
          </Section>

          {/* ── 4 · A qué aplica ── */}
          <Section title={num(t.secAplicabilidad)}>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "16px",
                alignItems: "flex-end",
              }}
            >
              <FieldGroup label={t.modoLabel}>
                <select
                  value={selectionMode}
                  onChange={(e) => {
                    setSelectionMode(e.target.value as OriginalPriceSelectionMode);
                    marcar("selection");
                  }}
                  style={inputStyle}
                >
                  {MODOS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {t[m.labelKey]}
                    </option>
                  ))}
                </select>
              </FieldGroup>
              <div>
                {selectionMode === "products" && (
                  <button
                    type="button"
                    onClick={elegirProductos}
                    style={{ ...inputStyle, cursor: "pointer", textAlign: "left" }}
                  >
                    {t.btnElegirProductos}
                  </button>
                )}
                {selectionMode === "collections" && (
                  <button
                    type="button"
                    onClick={elegirColecciones}
                    style={{ ...inputStyle, cursor: "pointer", textAlign: "left" }}
                  >
                    {t.btnElegirColecciones}
                  </button>
                )}
              </div>
            </div>

            {err("selection") && (
              <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>
                {err("selection")}
              </p>
            )}

            {selectionMode === "products" && (
              <ProductChips
                products={products}
                onRemove={(id) => setProducts((prev) => prev.filter((p) => p.id !== id))}
              />
            )}
            {selectionMode === "collections" && (
              <>
                <CollectionChips
                  collections={collections}
                  onRemove={(id) =>
                    setCollections((prev) => prev.filter((c) => c.id !== id))
                  }
                />
                <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
                  {t.aplicabilidadHelper}
                </p>
              </>
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
                ✓ {t.msgTodaLaTienda}
              </div>
            )}
          </Section>

          {/* ── 5 · Requisitos mínimos de compra ── */}
          <Section title={num(t.secMinimos)}>

            {(
              [
                ["none", t.minNingunoLabel],
                ["subtotal", t.minMontoLabel],
                ["quantity", t.minCantidadLabel],
              ] as const
            ).map(([valor, etiqueta]) => (
              <label
                key={valor}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  marginTop: "10px",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="minimumTypeRadio"
                  checked={minimumType === valor}
                  onChange={() => {
                    setMinimumType(valor);
                    marcar("minimum");
                  }}
                />
                <span>{etiqueta}</span>
              </label>
            ))}

            {minimumType === "subtotal" && (
              <div style={{ marginTop: "14px" }}>
                <FieldGroup label={t.minMontoCampoLabel} error={err("minimum")}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <span style={{ fontSize: "13px" }}>$</span>
                    <DecimalInput
                      value={minSubtotal}
                      onChange={(n) => {
                        setMinSubtotal(n);
                        marcar("minimum");
                      }}
                      style={{ ...inputStyle, width: "140px" }}
                    />
                  </div>
                </FieldGroup>
              </div>
            )}

            {minimumType === "quantity" && (
              <div style={{ marginTop: "14px" }}>
                <FieldGroup label={t.minCantidadCampoLabel} error={err("minimum")}>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={minQuantity}
                    onChange={(e) => {
                      setMinQuantity(e.target.value);
                      marcar("minimum");
                    }}
                    style={{ ...inputStyle, width: "140px" }}
                  />
                </FieldGroup>
              </div>
            )}

            {minimumType !== "none" && (
              <>
                <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
                  {t.minAlcanceNota(
                    selectionMode === "all" ? t.minAlcanceTodo : t.minAlcanceSeleccion
                  )}
                </p>
                <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>
                  {t.minPrecioHoyNota}
                </p>
              </>
            )}
          </Section>

          {/* ── Límite de usos — 🔴 SOLO en el método de código.
                 `DiscountAutomaticAppInput` no tiene `usageLimit` ni
                 `appliesOncePerCustomer` (verificado por introspección contra
                 la tienda). Mostrar los campos y guardarlos sería ofrecer un
                 límite que Shopify no va a hacer cumplir. ── */}
          {usaCodigo ? (
          <Section title={num(t.secUsos)}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={limitarUsos}
                onChange={(e) => {
                  setLimitarUsos(e.target.checked);
                  marcar("usageLimit");
                }}
              />
              <span>{t.limitarUsosLabel}</span>
            </label>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>
              {t.limitarUsosHelper}
            </p>

            {limitarUsos && (
              <div style={{ marginTop: "14px" }}>
                <FieldGroup label={t.usosLabel} error={err("usageLimit")}>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={usageLimit}
                    onChange={(e) => {
                      setUsageLimit(e.target.value);
                      marcar("usageLimit");
                    }}
                    placeholder={t.usosPlaceholder}
                    style={{
                      ...(err("usageLimit") ? inputErrorStyle : inputStyle),
                      width: "140px",
                    }}
                  />
                </FieldGroup>
              </div>
            )}

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginTop: "14px",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={oncePerCustomer}
                onChange={(e) => setOncePerCustomer(e.target.checked)}
              />
              <span>{t.oncePerCustomerLabel}</span>
            </label>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>
              {t.oncePerCustomerHelper}
            </p>

            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
              {t.usosNativoNota}
            </p>
          </Section>
          ) : (
            <Section title={num(t.secUsos)}>
              <p style={{ fontSize: "13px", color: "#6d7175", lineHeight: 1.5 }}>
                {t.metodoAutomaticoSinLimites}
              </p>
            </Section>
          )}

          {/* ── Exclusiones entre campañas ── */}
          {(campanas.montosDeCompra.length > 0 || campanas.packs.length > 0) && (
            <Section title={num(t.secExclusiones)}>
              <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
                {t.exclusionesHelper}
              </p>

              {/* Los descuentos por MONTO DE COMPRA van primero: son el único
                  tipo que se suma de verdad a este cupón, así que es la
                  decisión que el merchant va a tomar de hecho. */}
              {campanas.montosDeCompra.length > 0 && (
                <>
                  <p style={grupoStyle}>{t.exclusionesMontoTitulo}</p>
                  <p
                    style={{
                      fontSize: "12px",
                      color: "#8c9196",
                      margin: "6px 0 0",
                      lineHeight: 1.45,
                    }}
                  >
                    {t.exclusionesMontoHelper}
                  </p>

                  {campanas.montosDeCompra.map((m) => (
                    <label key={m.id} style={casillaStyle}>
                      <input
                        type="checkbox"
                        checked={excluidosMonto.includes(m.id)}
                        onChange={() => toggleExcluidoMonto(m.id)}
                      />
                      <span>
                        {t.exclusionNoAplicar} <strong>{m.name}</strong>{" "}
                        <span style={{ color: "#8c9196" }}>
                          ({t.exclusionMontoUmbral(money(m.minSubtotal))})
                        </span>
                      </span>
                    </label>
                  ))}

                  <p
                    style={{
                      fontSize: "12px",
                      color: "#8c9196",
                      margin: "10px 0 0",
                      lineHeight: 1.45,
                    }}
                  >
                    {t.exclusionesMontoFoto}
                  </p>
                </>
              )}

              {campanas.packs.length > 0 && (
                <>
                  <p style={grupoStyle}>{t.exclusionesPacksTitulo}</p>

                  {campanas.packs.map((p) => (
                    <label key={p.id} style={casillaStyle}>
                      <input
                        type="checkbox"
                        checked={excluidos.includes(p.id)}
                        onChange={() => toggleExcluido(p.id)}
                      />
                      <span>
                        {t.exclusionNoAplicar} <strong>{p.name}</strong>
                      </span>
                    </label>
                  ))}

                  <p
                    style={{
                      fontSize: "12px",
                      color: "#8c9196",
                      margin: "10px 0 0",
                      lineHeight: 1.45,
                    }}
                  >
                    {t.exclusionesSoloPacks}
                  </p>
                </>
              )}
            </Section>
          )}

          {/* ── 8 · Programación ── */}
          <Section title={num(t.secProgramacion)} defaultOpen={false}>
            <FieldGroup
              label={t.fechaInicioLabel}
              helper={t.fechaInicioHelper}
              error={err("dates")}
            >
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => {
                  setStartsAt(e.target.value);
                  marcar("dates");
                }}
                style={inputStyle}
              />
            </FieldGroup>
            <FieldGroup label={t.fechaFinLabel} helper={t.fechaFinHelper}>
              <input
                type="datetime-local"
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
              {t.previewTitulo}
            </h3>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>
              {t.previewHelper}
            </p>

            <table style={{ width: "100%", marginTop: "12px", fontSize: "13px" }}>
              <tbody>
                <tr>
                  <td style={{ color: "#6d7175", padding: "3px 0" }}>
                    {t.previewPrecioLista}
                  </td>
                  <td style={{ textAlign: "right", textDecoration: "line-through" }}>
                    {money(EJEMPLO_LISTA)}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "#6d7175", padding: "3px 0" }}>
                    {t.previewPrecioHoy}
                  </td>
                  <td style={{ textAlign: "right" }}>{money(EJEMPLO_HOY)}</td>
                </tr>
                <tr>
                  <td style={{ color: "#008060", padding: "3px 0", fontWeight: 600 }}>
                    {t.previewCupon}
                  </td>
                  <td style={{ textAlign: "right", color: "#008060", fontWeight: 600 }}>
                    −{money(descuento)}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "#8c9196", padding: "3px 0" }}>
                    {t.previewCuponNormal}
                  </td>
                  <td style={{ textAlign: "right", color: "#8c9196" }}>
                    −{money(normal)}
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid #f1f2f3" }}>
                  <td style={{ padding: "6px 0", fontWeight: 600 }}>{t.previewPaga}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>
                    {money(EJEMPLO_HOY - descuento)}
                  </td>
                </tr>
              </tbody>
            </table>

            {extra > 0 && (
              <p
                style={{
                  fontSize: "12px",
                  color: "#008060",
                  margin: "10px 0 0",
                  lineHeight: 1.5,
                }}
              >
                {t.previewExtra(money(extra))}
              </p>
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
              {t.resumenTitulo}
            </h3>
            <dl style={{ margin: "12px 0 0", fontSize: "13px" }}>
              {(
                [
                  [t.resumenNombre, name || t.sinDefinir],
                  [t.resumenTipo, t.resumenTipoCupon],
                  [
                    t.resumenMetodo,
                    usaCodigo ? t.resumenMetodoCodigo : t.resumenMetodoAutomatico,
                  ],
                  // El código solo se muestra si el método lo usa: una fila
                  // "Código: Sin definir" en un descuento automático es ruido.
                  ...(usaCodigo
                    ? ([[t.resumenCodigo, code || t.sinDefinir]] as const)
                    : []),
                  [t.resumenDescuento, percent > 0 ? `${percent}%` : "—"],
                  [t.resumenBase, t.resumenBaseValor],
                  [
                    t.resumenAplica,
                    selectionMode === "all"
                      ? t.resumenAplicaTodo
                      : selectionMode === "products"
                        ? t.resumenAplicaProductos(products.length)
                        : t.resumenAplicaColecciones(collections.length),
                  ],
                  [
                    t.resumenMinimo,
                    minimumType === "subtotal"
                      ? money(minSubtotal)
                      : minimumType === "quantity"
                        ? t.resumenMinimoCantidad(Number(minQuantity) || 0)
                        : t.resumenSinMinimo,
                  ],
                  [
                    t.resumenUsos,
                    usaCodigo
                      ? [
                          limitarUsos && Number(usageLimit) > 0
                            ? t.resumenUsosTotal(Number(usageLimit))
                            : t.resumenUsosSinLimite,
                          oncePerCustomer ? t.resumenUsosPorCliente : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : t.resumenUsosSinLimite,
                  ],
                  [
                    t.resumenExcluye,
                    [
                      excluidosMonto.length
                        ? t.resumenExcluyeMontos(excluidosMonto.length)
                        : null,
                      excluidos.length ? t.resumenExcluyePacks(excluidos.length) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || t.resumenSinExclusiones,
                  ],
                  [t.resumenInicio, startsAt || t.resumenInmediato],
                  [t.resumenFin, endsAt || t.resumenSinFin],
                ] as const
              ).map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "10px",
                    padding: "3px 0",
                  }}
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

          <p
            style={{ fontSize: "12px", color: "#6d7175", marginTop: "12px", lineHeight: 1.5 }}
          >
            {usaCodigo ? t.avisoCarrito : t.avisoCarritoAutomatico}
          </p>
          <p
            style={{ fontSize: "12px", color: "#6d7175", marginTop: "8px", lineHeight: 1.5 }}
          >
            {t.avisoSinBloque}
          </p>
        </div>
      </div>

      <ActionBar>
        <Btn
          type="submit"
          name="intent"
          value="activate"
          variant="primary"
          size="md"
          disabled={isSubmitting}
        >
          {isSubmitting ? t.btnCargando : primaryLabel}
        </Btn>
        {showDraftButton && (
          <Btn
            type="submit"
            name="intent"
            value="draft"
            variant="secondary"
            size="md"
            disabled={isSubmitting}
          >
            {t.btnBorrador}
          </Btn>
        )}
        <Link
          to="/app/campaigns"
          style={{
            fontSize: "14px",
            color: "#6d7175",
            textDecoration: "none",
            marginLeft: "auto",
          }}
        >
          {t.btnCancelar}
        </Link>
      </ActionBar>

      <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "8px" }}>
        El descuento máximo es {MAX_ORIGINAL_PRICE_PERCENT}%.
      </p>
    </Form>
  );
}
