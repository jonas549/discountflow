// Formulario de campañas de CUPONES DE VIAJE (crear y editar).
//
// Feature de una sola tienda (flag `cupones:viaje`). Las reglas viven en
// `app/lib/cupones-viaje/cupones-viaje.ts`; esto es solo la pantalla.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 LA ESTRUCTURA ES LA DE LAS OTRAS SIETE CAMPAÑAS, y lo comprueba
// `campaign-forms.test.ts`: rejilla `minmax(0,1fr) 320px`, secciones numeradas,
// panel fijo con «Vista previa» y «Resumen», y `ActionBar` al final.
//
// 🔴 Y TODO EL ESTADO VIAJA EN UN SOLO INPUT OCULTO ARRIBA DEL <Form>.
// `Section` desmonta a sus hijos al plegarse, y un input desmontado no viaja en
// el FormData: plegar una sección antes de guardar borraba sus campos en
// silencio (el bug del 2026-09-06). Acá ningún control visible tiene `name`;
// lo que se envía es `datos`, serializado del estado de React.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Form, Link, useFetcher } from "react-router";
import { Btn } from "./Btn";
import {
  Section,
  FieldGroup,
  inputStyle,
  inputErrorStyle,
  pickerBtnStyle,
  chipStyle,
  ActionBar,
  GeneralErrorBanner,
} from "./CampaignFormShared";
import {
  clasificarVariantes,
  cuponesAMostrar,
  cuponesPublicados,
  cuponesQueSuperanElPrecio,
  precioPagoTotalMasBarato,
  formatoMonto,
  parseMontoEntero,
  rellenarMensaje,
  sugerirModalidades,
  MAX_CUPONES,
  MAX_VISIBLES,
  type ErroresDelFormulario,
  type OpcionDeProducto,
  type VarianteConOpciones,
} from "../lib/cupones-viaje/cupones-viaje";
import { es } from "../i18n";

export type FilaDeCupon = {
  /** Clave de React. Estable aunque el cupón todavía no tenga id. */
  key: string;
  id?: string;
  label: string;
  amount: string;
  stock: string;
  used: number;
  tieneCanjes: boolean;
};

export type TravelFormInitial = {
  name: string;
  productId: string;
  productTitle: string;
  optionName: string;
  fullPaymentValue: string;
  reservationValue: string;
  visibleCount: number;
  autoApply: boolean;
  heading: string;
  messageFullPayment: string;
  messageReservation: string;
  coupons: FilaDeCupon[];
};

type ProductoLeido = { options: OpcionDeProducto[]; variants: VarianteConOpciones[] };

let contadorDeFilas = 0;
const nuevaClave = () => `nueva-${++contadorDeFilas}-${Date.now()}`;

export function TravelCouponCampaignForm({
  initial,
  productoInicial,
  errors,
  isSubmitting,
  primaryLabel,
  showDraftButton,
  avisoOtraActiva,
}: {
  initial: TravelFormInitial;
  /** En edición, el viaje ya leído: permite mostrar la clasificación sin esperar. */
  productoInicial: ProductoLeido | null;
  errors: ErroresDelFormulario;
  isSubmitting: boolean;
  primaryLabel: string;
  showDraftButton: boolean;
  avisoOtraActiva?: string | null;
}) {
  const t = es.cuponesViaje;

  const [name, setName] = useState(initial.name);
  const [productId, setProductId] = useState(initial.productId);
  const [productTitle, setProductTitle] = useState(initial.productTitle);
  const [producto, setProducto] = useState<ProductoLeido | null>(productoInicial);
  const [optionName, setOptionName] = useState(initial.optionName);
  const [fullPaymentValue, setFullPaymentValue] = useState(initial.fullPaymentValue);
  const [reservationValue, setReservationValue] = useState(initial.reservationValue);
  const [coupons, setCoupons] = useState<FilaDeCupon[]>(initial.coupons);
  const [visibleCount, setVisibleCount] = useState(initial.visibleCount);
  const [autoApply, setAutoApply] = useState(initial.autoApply);
  const [heading, setHeading] = useState(initial.heading);
  const [messageFullPayment, setMessageFullPayment] = useState(initial.messageFullPayment);
  const [messageReservation, setMessageReservation] = useState(initial.messageReservation);
  const [modoPreview, setModoPreview] = useState<"FULL_PAYMENT" | "RESERVATION">("FULL_PAYMENT");

  // Los errores del servidor se ocultan en cuanto se toca el campo que los
  // provocó; si no, el formulario parece trancado (bug del 2026-08-08).
  const [tocado, setTocado] = useState<Record<string, boolean>>({});
  // 🔴 Cada respuesta NUEVA del servidor vuelve a mostrar sus errores. Sin esto,
  // un campo tocado antes de guardar escondía para siempre el error que el
  // servidor devolvía sobre él: el formulario no guardaba y no decía por qué
  // (cupos en 0, 2026-09-25). `errors` cambia de identidad solo con una
  // respuesta nueva; el `{}` vacío de «sin errores» no reinicia nada.
  useEffect(() => {
    if (Object.keys(errors).length > 0) setTocado({});
  }, [errors]);
  const err = (k: keyof ErroresDelFormulario) => (tocado[k] ? undefined : errors[k]);
  const marcar = (k: keyof ErroresDelFormulario) =>
    setTocado((p) => (p[k] ? p : { ...p, [k]: true }));

  // ── El viaje ──────────────────────────────────────────────────────────────
  const fetcher = useFetcher<{ producto?: ProductoLeido & { id: string; title: string }; error?: string }>();
  const pedido = useRef<string | null>(null);

  useEffect(() => {
    const leido = fetcher.data?.producto;
    if (!leido || leido.id !== pedido.current) return;
    setProducto({ options: leido.options, variants: leido.variants });
    // Se propone la modalidad solo si la actual no existe en este producto: al
    // editar, lo que eligió el merchant manda sobre la sugerencia.
    const valida = leido.options.some(
      (o) => o.name === optionName && o.values.includes(fullPaymentValue) && o.values.includes(reservationValue)
    );
    if (!valida) {
      const s = sugerirModalidades(leido.options);
      setOptionName(s?.optionName ?? leido.options[0]?.name ?? "");
      setFullPaymentValue(s?.fullPaymentValue ?? "");
      setReservationValue(s?.reservationValue ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const elegirViaje = async () => {
    const elegidos = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      selectionIds: productId ? [{ id: productId }] : [],
    });
    const p = (elegidos as Array<{ id: string; title: string }> | undefined)?.[0];
    if (!p) return;
    marcar("product");
    marcar("modalidades");
    setProductId(p.id);
    setProductTitle(p.title);
    setProducto(null);
    pedido.current = p.id;
    fetcher.load(`/app/cupones-viaje/producto?id=${encodeURIComponent(p.id)}`);
  };

  const opcionElegida = producto?.options.find((o) => o.name === optionName);
  const clasificadas = producto
    ? clasificarVariantes(producto.variants, optionName, fullPaymentValue, reservationValue)
    : null;

  // ── Cupones ───────────────────────────────────────────────────────────────
  const setCupon = (i: number, patch: Partial<FilaDeCupon>) => {
    marcar("coupons");
    setCoupons((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  };
  const mover = (i: number, d: -1 | 1) => {
    marcar("coupons");
    setCoupons((cs) => {
      const j = i + d;
      if (j < 0 || j >= cs.length) return cs;
      const out = [...cs];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  };

  // La vista previa usa las MISMAS funciones que el proxy de la tienda, con los
  // usos reales de hoy: lo que se ve acá es lo que ve el comprador.
  const paraReglas = coupons.map((c, i) => ({
    key: c.key,
    position: i + 1,
    label: c.label || `Cupón ${i + 1}`,
    amount: parseMontoEntero(c.amount) ?? 0,
    stock: parseMontoEntero(c.stock) ?? 0,
    used: c.used,
  }));
  const mostrados = cuponesAMostrar(paraReglas, visibleCount);
  // Un cupón que iguala o supera el Pago total más barato dejaría ese carrito en
  // $0 sin avisar a nadie. Solo avisa: puede ser a propósito.
  const minimoPagoTotal =
    producto && clasificadas ? precioPagoTotalMasBarato(producto.variants, clasificadas.fullPayment) : null;
  const superanElPrecio = cuponesQueSuperanElPrecio(paraReglas, minimoPagoTotal);
  const publicados = cuponesPublicados(paraReglas, visibleCount);
  const primero = publicados[0];
  const mensajePreview = rellenarMensaje(
    modoPreview === "FULL_PAYMENT" ? messageFullPayment : messageReservation,
    { monto: primero ? formatoMonto(primero.amount) : "—", cupon: primero?.label ?? "—" }
  );

  const datos = {
    name,
    productId,
    productTitle,
    optionName,
    fullPaymentValue,
    reservationValue,
    visibleCount,
    autoApply,
    heading,
    messageFullPayment,
    messageReservation,
    coupons: coupons.map((c) => ({ id: c.id, label: c.label, amount: c.amount, stock: c.stock })),
  };

  let nSeccion = 0;
  const num = (titulo: string) => `${++nSeccion} · ${titulo}`;

  return (
    <Form method="post">
      {/* 🔴 La ÚNICA fuente de lo que se guarda. Ver la cabecera. */}
      <input type="hidden" name="datos" value={JSON.stringify(datos)} />

      {errors.general && <GeneralErrorBanner message={errors.general} />}
      {avisoOtraActiva && (
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
          {avisoOtraActiva}
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
          </Section>

          {/* ── 2 · Viaje y modalidades ── */}
          <Section title={num(t.secViaje)}>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>{t.viajeHelper}</p>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "10px" }}>
              <button type="button" onClick={elegirViaje} style={pickerBtnStyle}>
                {productId ? t.btnCambiarViaje : t.btnElegirViaje}
              </button>
              {productId && <span style={chipStyle}>{productTitle}</span>}
            </div>
            {err("product") && (
              <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>{err("product")}</p>
            )}
            {fetcher.state === "loading" && (
              <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "8px" }}>{t.cargandoViaje}</p>
            )}
            {fetcher.data?.error && (
              <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>{fetcher.data.error}</p>
            )}

            {producto && (
              <>
                <FieldGroup label={t.opcionLabel} helper={t.opcionHelper} error={err("modalidades")}>
                  <select
                    value={optionName}
                    onChange={(e) => {
                      marcar("modalidades");
                      setOptionName(e.target.value);
                      setFullPaymentValue("");
                      setReservationValue("");
                    }}
                    style={inputStyle}
                  >
                    <option value="" disabled>
                      —
                    </option>
                    {producto.options.map((o) => (
                      <option key={o.name} value={o.name}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </FieldGroup>
                <div style={{ display: "flex", gap: "12px" }}>
                  {(
                    [
                      [t.totalLabel, fullPaymentValue, setFullPaymentValue],
                      [t.reservaLabel, reservationValue, setReservationValue],
                    ] as const
                  ).map(([label, valor, set]) => (
                    <div key={label} style={{ flex: 1 }}>
                      <FieldGroup label={label}>
                        <select
                          value={valor}
                          onChange={(e) => {
                            marcar("modalidades");
                            set(e.target.value);
                          }}
                          style={inputStyle}
                        >
                          <option value="" disabled>
                            —
                          </option>
                          {(opcionElegida?.values ?? []).map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </FieldGroup>
                    </div>
                  ))}
                </div>
                {clasificadas && (
                  <p style={{ fontSize: "12.5px", color: "#202223", marginTop: "12px" }}>
                    {t.clasificacion(
                      clasificadas.fullPayment.length,
                      clasificadas.reservation.length,
                      clasificadas.sinClasificar.length
                    )}
                  </p>
                )}
                <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>{t.avisoFechasNuevas}</p>
              </>
            )}
          </Section>

          {/* ── 3 · Cupones ── */}
          <Section title={num(t.secCupones)}>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>{t.cuponesHelper}</p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) 130px 80px 60px auto",
                gap: "8px",
                alignItems: "center",
                marginTop: "12px",
                fontSize: "12px",
                color: "#6d7175",
              }}
            >
              <span>{t.colEtiqueta}</span>
              <span>{t.colMonto}</span>
              <span>{t.colStock}</span>
              <span>{t.colUsados}</span>
              <span />
              {coupons.map((c, i) => (
                <FilaCupon
                  key={c.key}
                  c={c}
                  i={i}
                  total={coupons.length}
                  onChange={(patch) => setCupon(i, patch)}
                  onMover={(d) => mover(i, d)}
                  onQuitar={() => {
                    marcar("coupons");
                    setCoupons((cs) => cs.filter((_, j) => j !== i));
                  }}
                />
              ))}
            </div>

            {coupons.length < MAX_CUPONES && (
              <div style={{ marginTop: "12px" }}>
                <Btn
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    marcar("coupons");
                    const ultimo = coupons[coupons.length - 1];
                    setCoupons((cs) =>
                      cs.concat({
                        key: nuevaClave(),
                        label: `Cupón ${cs.length + 1}`,
                        // El siguiente arranca con los valores del anterior: lo
                        // habitual es cambiar solo el monto.
                        amount: ultimo?.amount ?? "",
                        stock: ultimo?.stock ?? "5",
                        used: 0,
                        tieneCanjes: false,
                      })
                    );
                  }}
                >
                  {t.btnAgregarCupon}
                </Btn>
              </div>
            )}
            {err("coupons") && (
              <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>{err("coupons")}</p>
            )}
            {superanElPrecio.length > 0 && minimoPagoTotal !== null && (
              <div
                style={{
                  background: "#fff8e1",
                  border: "1px solid #f9a825",
                  borderRadius: "8px",
                  padding: "10px 12px",
                  fontSize: "12.5px",
                  color: "#a05c00",
                  marginTop: "10px",
                }}
              >
                {t.avisoSuperaPrecio(
                  superanElPrecio.map((c) => `«${c.label}» (${formatoMonto(c.amount)})`).join(", "),
                  formatoMonto(minimoPagoTotal)
                )}
              </div>
            )}
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "8px" }}>{t.montoHelper}</p>

            <FieldGroup label={t.visiblesLabel} helper={t.visiblesHelper}>
              <select
                value={visibleCount}
                onChange={(e) => setVisibleCount(Number(e.target.value))}
                style={{ ...inputStyle, width: "90px" }}
              >
                {Array.from({ length: MAX_VISIBLES }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </FieldGroup>
            <p style={{ fontSize: "12px", color: "#6d7175", marginTop: "10px" }}>{t.unaVezPorPedido}</p>

            <FieldGroup label={t.autoLabel}>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {(
                  [
                    [true, t.autoSi, t.autoSiHelper],
                    [false, t.autoNo, t.autoNoHelper],
                  ] as const
                ).map(([valor, etiqueta, ayuda]) => (
                  <label
                    key={String(valor)}
                    style={{
                      display: "flex",
                      gap: "10px",
                      alignItems: "flex-start",
                      border: `1px solid ${autoApply === valor ? "#008060" : "#c9cccf"}`,
                      background: autoApply === valor ? "#f1f8f5" : "#fff",
                      borderRadius: "8px",
                      padding: "12px 14px",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="autoApplyRadio"
                      checked={autoApply === valor}
                      onChange={() => setAutoApply(valor)}
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
          </Section>

          {/* ── 4 · Mensajes en la tienda ── */}
          <Section title={num(t.secMensajes)}>
            <div
              style={{
                background: "#fff8e1",
                border: "1px solid #ffe082",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "12.5px",
                color: "#8b5e00",
                marginTop: "12px",
              }}
            >
              {t.avisoPrecioArriba}
            </div>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "10px" }}>{t.mensajesHelper}</p>
            <FieldGroup label={t.tituloTiendaLabel} error={err("messages")}>
              <input
                value={heading}
                onChange={(e) => {
                  setHeading(e.target.value);
                  marcar("messages");
                }}
                style={inputStyle}
              />
            </FieldGroup>
            <FieldGroup label={t.mensajeTotalLabel}>
              <textarea
                value={messageFullPayment}
                rows={3}
                onChange={(e) => {
                  setMessageFullPayment(e.target.value);
                  marcar("messages");
                  setModoPreview("FULL_PAYMENT");
                }}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </FieldGroup>
            <FieldGroup label={t.mensajeReservaLabel}>
              <textarea
                value={messageReservation}
                rows={3}
                onChange={(e) => {
                  setMessageReservation(e.target.value);
                  marcar("messages");
                  setModoPreview("RESERVATION");
                }}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </FieldGroup>
          </Section>
        </div>

        {/* ── Panel lateral: vista previa + resumen ── */}
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
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>{t.previewTitulo}</h3>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>{t.previewHelper}</p>

            <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "12px" }}>{t.previewModalidad}</div>
            <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
              {(
                [
                  ["FULL_PAYMENT", t.previewTotal],
                  ["RESERVATION", t.previewReserva],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModoPreview(m)}
                  style={{
                    ...cuadradito(modoPreview === m, false),
                    fontSize: "12px",
                    padding: "5px 10px",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ fontSize: "13px", fontWeight: 600, marginTop: "14px" }}>{heading || "—"}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
              {mostrados.length === 0 && (
                <span style={{ fontSize: "12px", color: "#8c9196" }}>{t.sinDefinir}</span>
              )}
              {mostrados.map((c) => (
                <span key={c.key} style={cuadradito(false, c.agotado)}>
                  <span style={{ textDecoration: c.agotado ? "line-through" : "none" }}>{c.label}</span>
                  <span style={{ display: "block", fontSize: "11px", color: "#6d7175" }}>
                    {c.agotado
                      ? t.agotado
                      : `${formatoMonto(c.amount)} · ${t.quedan(Math.max(0, c.stock - c.used))}`}
                  </span>
                </span>
              ))}
            </div>
            <p style={{ fontSize: "12.5px", color: "#202223", marginTop: "12px", lineHeight: 1.5 }}>
              {mensajePreview}
            </p>
          </div>

          <div
            style={{
              border: "1px solid #e1e3e5",
              borderRadius: "10px",
              background: "#fff",
              padding: "16px 18px",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>{t.resumenTitulo}</h3>
            <dl style={{ margin: "12px 0 0", fontSize: "13px" }}>
              {(
                [
                  [t.resumenNombre, name || t.sinDefinir],
                  [t.resumenViaje, productTitle || t.sinDefinir],
                  [t.resumenCupones, String(coupons.length)],
                  [
                    t.resumenPublicado,
                    coupons.length === 0
                      ? t.sinDefinir
                      : publicados.length
                        ? publicados.map((c) => c.label).join(", ")
                        : t.ninguno,
                  ],
                  [t.resumenStockTotal, String(paraReglas.reduce((s, c) => s + c.stock, 0))],
                  [t.resumenVisibles, String(visibleCount)],
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
        </div>
      </div>

      <ActionBar>
        <Btn type="submit" name="intent" value="activate" variant="primary" size="md" disabled={isSubmitting}>
          {isSubmitting ? t.btnCargando : primaryLabel}
        </Btn>
        {showDraftButton && (
          <Btn type="submit" name="intent" value="draft" variant="secondary" size="md" disabled={isSubmitting}>
            {t.btnBorrador}
          </Btn>
        )}
        <Link
          to="/app/campaigns"
          style={{ fontSize: "14px", color: "#6d7175", textDecoration: "none", marginLeft: "auto" }}
        >
          {t.btnCancelar}
        </Link>
      </ActionBar>
    </Form>
  );
}

/** El cuadradito de la vista previa: el mismo aspecto que un selector de variante. */
function cuadradito(elegido: boolean, agotado: boolean): React.CSSProperties {
  return {
    display: "inline-block",
    textAlign: "center",
    padding: "7px 12px",
    borderRadius: "6px",
    fontSize: "12.5px",
    cursor: agotado ? "not-allowed" : "pointer",
    background: elegido ? "#202223" : "#fff",
    color: elegido ? "#fff" : "#202223",
    border: `1px solid ${agotado ? "#d2d5d8" : "#202223"}`,
    opacity: agotado ? 0.5 : 1,
  };
}

function FilaCupon({
  c,
  i,
  total,
  onChange,
  onMover,
  onQuitar,
}: {
  c: FilaDeCupon;
  i: number;
  total: number;
  onChange: (patch: Partial<FilaDeCupon>) => void;
  onMover: (d: -1 | 1) => void;
  onQuitar: () => void;
}) {
  const t = es.cuponesViaje;
  const chico: React.CSSProperties = {
    background: "none",
    border: "1px solid #e1e3e5",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "11px",
    padding: "2px 6px",
    color: "#6d7175",
  };
  return (
    <>
      <input value={c.label} onChange={(e) => onChange({ label: e.target.value })} style={inputStyle} />
      <MontoInput value={c.amount} onChange={(amount) => onChange({ amount })} />
      <input
        value={c.stock}
        inputMode="numeric"
        onChange={(e) => onChange({ stock: e.target.value })}
        style={parseMontoEntero(c.stock) === null && c.stock !== "" ? inputErrorStyle : inputStyle}
      />
      <span style={{ fontSize: "13px", color: "#202223", textAlign: "center" }}>{c.used}</span>
      <span style={{ display: "flex", gap: "4px", alignItems: "center" }}>
        <button type="button" title={t.subir} disabled={i === 0} onClick={() => onMover(-1)} style={chico}>
          ↑
        </button>
        <button type="button" title={t.bajar} disabled={i === total - 1} onClick={() => onMover(1)} style={chico}>
          ↓
        </button>
        <button
          type="button"
          disabled={c.tieneCanjes}
          title={c.tieneCanjes ? t.quitarBloqueado : t.btnQuitar}
          onClick={onQuitar}
          style={{ ...chico, opacity: c.tieneCanjes ? 0.4 : 1 }}
        >
          {t.btnQuitar}
        </button>
      </span>
    </>
  );
}

/** Separa miles con punto: "100000" → "100.000". Solo dígitos de entrada. */
export function conMiles(digitos: string): string {
  return digitos.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Posición en el texto formateado que deja `n` dígitos a la izquierda. */
export function posicionTrasDigitos(formateado: string, n: number): number {
  if (n <= 0) return 0;
  let vistos = 0;
  for (let i = 0; i < formateado.length; i++)
    if (/\d/.test(formateado[i]) && ++vistos === n) return i + 1;
  return formateado.length;
}

/**
 * Monto entero con separador de miles MIENTRAS se escribe: 100000 → 100.000.
 *
 * El valor que viaja es SOLO DÍGITOS ("100000"); los puntos son de la pantalla.
 * Así el parseo del servidor no depende de qué separador use el navegador.
 *
 * Dos detalles que hacen que se pueda escribir cómodo:
 *   · El cursor no salta al final. Al reformatear, React reemplaza el texto y
 *     el navegador manda el cursor al final; acá se recuerda cuántos dígitos
 *     había a su izquierda y se lo repone después del render.
 *   · Borrar justo detrás de un punto borra el DÍGITO anterior. Si no, el punto
 *     volvería a aparecer y parecería que la tecla no hace nada.
 */
function MontoInput({ value, onChange }: { value: string; onChange: (digitos: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const cursor = useRef<number | null>(null);
  const digitos = value.replace(/\D/g, "");
  const mostrado = conMiles(digitos);

  useLayoutEffect(() => {
    if (cursor.current === null || !ref.current) return;
    const pos = posicionTrasDigitos(mostrado, cursor.current);
    ref.current.setSelectionRange(pos, pos);
    cursor.current = null;
  });

  return (
    <input
      ref={ref}
      value={mostrado}
      inputMode="numeric"
      placeholder="100.000"
      onKeyDown={(e) => {
        const el = e.currentTarget;
        const a = el.selectionStart ?? 0;
        if (a !== el.selectionEnd) return;
        if (e.key === "Backspace" && el.value[a - 1] === ".") el.setSelectionRange(a - 1, a - 1);
        if (e.key === "Delete" && el.value[a] === ".") el.setSelectionRange(a + 1, a + 1);
      }}
      onChange={(e) => {
        const crudo = e.target.value;
        const izquierda = crudo.slice(0, e.target.selectionStart ?? crudo.length).replace(/\D/g, "").length;
        // Sin ceros a la izquierda: "0100" no es un monto.
        const nuevos = crudo.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
        cursor.current = Math.min(izquierda, nuevos.length);
        onChange(nuevos);
      }}
      style={digitos === "" && value !== "" ? inputErrorStyle : inputStyle}
    />
  );
}
