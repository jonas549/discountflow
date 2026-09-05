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
import { Btn } from "./Btn";
import {
  Section,
  FieldGroup,
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
import { normalizeDiscountCode } from "../lib/discounts/original-price-client";
import type { CampanasQuePuedenChocar } from "./CartValueCampaignForm";
import { es } from "../i18n";

export type OriginalPriceFormErrors = {
  name?: string;
  code?: string;
  percent?: string;
  dates?: string;
  general?: string;
};

export type OriginalPriceFormInitial = {
  name: string;
  code: string;
  percent: number;
  message: string;
  excludedPackCampaignIds: string[];
  startsAt: string;
  endsAt: string;
};

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
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);

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

  const advertencias = validateOriginalPrice(percent).warnings;

  const toggleExcluido = (id: string) =>
    setExcluidos((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.concat(id)));

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
      {errors.general && (
        <GeneralErrorBanner message={errors.general} limitExceeded={limitExceeded} />
      )}

      {/* Arriba de la rejilla, igual que en los otros: es una advertencia sobre
          la campaña entera, no sobre un campo. */}
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
                name="name"
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
                name="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                style={inputStyle}
              />
            </FieldGroup>
          </Section>

          {/* ── 2 · El código ── */}
          <Section title={num(t.secCodigo)}>
            <FieldGroup label={t.codigoLabel} helper={t.codigoHelper} error={err("code")}>
              <input
                name="code"
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
            <input type="hidden" name="percent" value={String(percent)} />

            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
              {t.comoFunciona}
            </p>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>
              {t.sinComparativo}
            </p>
          </Section>

          {/* ── 4 · Exclusiones ── */}
          {campanas.packs.length > 0 && (
            <Section title={num(t.secExclusiones)}>
              <input
                type="hidden"
                name="excludedPacksJson"
                value={JSON.stringify(excluidos)}
              />
              <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
                {t.exclusionesHelper}
              </p>

              {campanas.packs.map((p) => (
                <label
                  key={p.id}
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
                    type="checkbox"
                    checked={excluidos.includes(p.id)}
                    onChange={() => toggleExcluido(p.id)}
                  />
                  <span>
                    {t.exclusionNoAplicar} <strong>{p.name}</strong>
                  </span>
                </label>
              ))}

              <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
                {t.exclusionesSoloPacks}
              </p>
            </Section>
          )}

          {/* ── 5 · Programación ── */}
          <Section title={num(t.secProgramacion)} defaultOpen={false}>
            <FieldGroup
              label={t.fechaInicioLabel}
              helper={t.fechaInicioHelper}
              error={err("dates")}
            >
              <input
                type="datetime-local"
                name="startsAt"
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
                name="endsAt"
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
                  [t.resumenCodigo, code || t.sinDefinir],
                  [t.resumenDescuento, percent > 0 ? `${percent}%` : "—"],
                  [t.resumenBase, t.resumenBaseValor],
                  [
                    t.resumenExcluye,
                    excluidos.length
                      ? t.resumenExcluyePacks(excluidos.length)
                      : t.resumenSinExclusiones,
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
            {t.avisoCarrito}
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
