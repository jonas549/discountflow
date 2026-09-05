// Formulario compartido de campañas CART_VALUE ("gastá $100 y ahorrás $10").
// Lo usan la ruta de creación y la de edición: la única diferencia entre ambas
// son los valores iniciales y las etiquetas de los botones.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 LA ESTRUCTURA NO ES LIBRE. Es la misma que las otras cinco campañas.
//
// La primera versión de esta pantalla se entregó a ancho completo, sin panel
// lateral, con la vista previa enterrada dentro de la sección de niveles. Se
// veía como si fuera otra app. La referencia es `PackCampaignForm` y las cuatro
// anteriores, no lo que parezca razonable mientras se escribe:
//
//   · Rejilla `minmax(0,1fr) 320px`, `gap: 20px`, `alignItems: start`.
//   · Secciones plegables numeradas a la izquierda (`Section`, `FieldGroup`).
//   · Panel `position: sticky; top: 12px` a la derecha, con DOS tarjetas
//     —«Vista previa» y «Resumen»— más las advertencias y las notas al pie.
//   · Los avisos que afectan a la campaña entera van de banner ARRIBA de la
//     rejilla, no sueltos entre las secciones.
//   · `ActionBar` al final: primario, borrador, y «Cancelar» empujado a la
//     derecha con `marginLeft: auto`.
//   · Todos los textos en `es.nuevoValorCarrito`, no incrustados acá.
//
// Antes de tocar esto, abrí `PackCampaignForm.tsx` al lado y comparalos.
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
  computeCartValue,
  cartValueSavings,
  normalizeCartValueTiers,
  validateCartValue,
  MAX_CART_VALUE_TIERS,
  type CartValueType,
  type CartValueTier,
} from "../lib/discounts/cart-value-calc";
import { es } from "../i18n";

export type CartValueFormErrors = {
  name?: string;
  tiers?: string;
  dates?: string;
  general?: string;
};

/** Un pack de la tienda, para la lista de exclusiones. */
export type PackParaExcluir = { id: string; name: string };

/** Lo que el formulario necesita saber sobre el resto de campañas de la tienda. */
export type CampanasQuePuedenChocar = {
  /** Packs: el merchant elige si se suman o se excluyen. */
  packs: PackParaExcluir[];
  /**
   * Escalonados y BxGy: NO se puede elegir. Sus descuentos se crean con
   * `combinesWith.orderDiscounts: false`, así que Shopify descarta este
   * descuento antes de que nuestra Function opine. Se listan para avisar.
   */
  bloqueantes: string[];
};

export type CartValueFormInitial = {
  name: string;
  valueType: CartValueType;
  message: string;
  tiers: CartValueTier[];
  excludedPackCampaignIds: string[];
  startsAt: string;
  endsAt: string;
};

const money = (n: number) =>
  `$${n.toLocaleString("es-CL", { maximumFractionDigits: 2 })}`;

export function CartValueCampaignForm({
  initial,
  campanas,
  errors,
  limitExceeded,
  isSubmitting,
  showDraftButton,
  primaryLabel,
}: {
  initial: CartValueFormInitial;
  /** Packs (excluibles) y campañas que bloquean sin remedio. */
  campanas: CampanasQuePuedenChocar;
  errors: CartValueFormErrors;
  limitExceeded?: boolean;
  isSubmitting: boolean;
  showDraftButton: boolean;
  primaryLabel: string;
}) {
  const t = es.nuevoValorCarrito;

  const [name, setName] = useState(initial.name);
  const [valueType, setValueType] = useState<CartValueType>(initial.valueType);
  const [message, setMessage] = useState(initial.message);
  const [tiers, setTiers] = useState<CartValueTier[]>(initial.tiers);
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
  const err = (k: keyof CartValueFormErrors) => (tocado[k] ? undefined : errors[k]);
  const marcar = (k: keyof CartValueFormErrors) =>
    setTocado((prev) => (prev[k] ? prev : { ...prev, [k]: true }));

  const esPorcentaje = valueType === "PERCENT";
  const normalizados = normalizeCartValueTiers(tiers, valueType);
  const advertencias = validateCartValue(valueType, tiers).warnings;

  const setTier = (i: number, patch: Partial<CartValueTier>) => {
    marcar("tiers");
    setTiers((ts) => ts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };

  const toggleExcluido = (id: string) =>
    setExcluidos((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.concat(id)));

  /**
   * La vista previa sale del MISMO módulo que la Function del checkout, así que
   * no puede mostrar un número distinto del que el comprador va a pagar.
   *
   * Se calcula el carrito EN cada umbral —el momento exacto en que ese nivel
   * empieza a valer— y además un ejemplo por encima del último.
   */
  const filas = normalizados.map((tier) => {
    const outcome = computeCartValue(valueType, normalizados, tier.minSubtotal);
    return { carrito: tier.minSubtotal, ahorro: cartValueSavings(outcome, valueType) };
  });

  const carritoEjemplo = normalizados.length
    ? Math.round(normalizados[normalizados.length - 1].minSubtotal * 1.25)
    : 0;
  const ejemplo = computeCartValue(valueType, normalizados, carritoEjemplo);
  const ahorroEjemplo = cartValueSavings(ejemplo, valueType);

  const maximo = normalizados.reduce(
    (m, x) => Math.max(m, (esPorcentaje ? x.percent : x.amount) ?? 0),
    0
  );

  let nSeccion = 0;
  const num = (titulo: string) => `${++nSeccion} · ${titulo}`;

  return (
    <Form method="post">
      {errors.general && (
        <GeneralErrorBanner message={errors.general} limitExceeded={limitExceeded} />
      )}

      {/* 🔴 Arriba de la rejilla, igual que el aviso de solapamiento de packs:
          es una advertencia sobre la campaña entera, no sobre un campo. */}
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

          {/* ── 2 · Modo ── */}
          <Section title={num(t.secModo)}>
            <input type="hidden" name="valueType" value={valueType} />
            <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
              {(
                [
                  ["PERCENT", t.modoPorcentaje, t.modoPorcentajeDesc],
                  ["AMOUNT", t.modoMonto, t.modoMontoDesc],
                ] as const
              ).map(([v, titulo, desc]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setValueType(v);
                    marcar("tiers");
                  }}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    padding: "12px 14px",
                    borderRadius: "8px",
                    cursor: "pointer",
                    background: valueType === v ? "#f1f8f5" : "#fff",
                    border: `1px solid ${valueType === v ? "#008060" : "#e1e3e5"}`,
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 600 }}>{titulo}</div>
                  <div style={{ fontSize: "12px", color: "#8c9196", marginTop: "2px" }}>
                    {desc}
                  </div>
                </button>
              ))}
            </div>
          </Section>

          {/* ── 3 · Niveles ── */}
          <Section title={num(t.secNiveles)}>
            <input type="hidden" name="tiersJson" value={JSON.stringify(tiers)} />
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
              {t.nivelesHelper}
            </p>
            <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>
              {t.nivelesUmbral}
            </p>

            {tiers.map((tier, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  marginTop: "10px",
                }}
              >
                <span style={{ fontSize: "13px", color: "#6d7175" }}>{t.nivelDesde}</span>
                <span style={{ fontSize: "13px", color: "#6d7175" }}>$</span>
                <DecimalInput
                  value={tier.minSubtotal}
                  onChange={(n) => setTier(i, { minSubtotal: n })}
                  style={{ ...inputStyle, width: "110px" }}
                />
                <span style={{ fontSize: "13px", color: "#6d7175" }}>
                  → {t.nivelDescontar}
                </span>
                {!esPorcentaje && (
                  <span style={{ fontSize: "13px", color: "#6d7175" }}>$</span>
                )}
                <DecimalInput
                  value={(esPorcentaje ? tier.percent : tier.amount) ?? 0}
                  onChange={(n) => setTier(i, esPorcentaje ? { percent: n } : { amount: n })}
                  style={{ ...inputStyle, width: "90px" }}
                />
                {esPorcentaje && <span style={{ fontSize: "13px" }}>%</span>}
                <Btn
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    marcar("tiers");
                    setTiers((ts) => ts.filter((_, j) => j !== i));
                  }}
                >
                  {t.btnQuitarNivel}
                </Btn>
              </div>
            ))}

            {tiers.length < MAX_CART_VALUE_TIERS && (
              <div style={{ marginTop: "12px" }}>
                <Btn
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    marcar("tiers");
                    const ultimo = tiers[tiers.length - 1];
                    const base = (ultimo?.minSubtotal ?? 0) + 50000;
                    setTiers((ts) =>
                      ts.concat(
                        esPorcentaje
                          ? { minSubtotal: base, percent: 5 }
                          : { minSubtotal: base, amount: 5000 }
                      )
                    );
                  }}
                >
                  {t.btnAgregarNivel}
                </Btn>
              </div>
            )}

            {err("tiers") && (
              <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>
                {err("tiers")}
              </p>
            )}
          </Section>

          {/* ── 4 · Exclusiones ──
           *
           * 🔴 Existe por un fallo medido, no por si acaso. El 2026-09-05, en
           * dev, un pack aplicó su 30% y este descuento desapareció sin que
           * nadie se enterara: ni el comprador, ni el merchant, ni un log. La
           * causa era `combinesWith`, ya arreglado — pero arreglarlo solo deja
           * dos opciones: que se sumen, o que Shopify elija en silencio. Acá
           * elige el merchant. */}
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

            {filas.length === 0 ? (
              <p style={{ fontSize: "13px", color: "#8c9196", marginTop: "12px" }}>
                {t.previewSinNiveles}
              </p>
            ) : (
              <>
                <table style={{ width: "100%", marginTop: "12px", fontSize: "13px" }}>
                  <tbody>
                    {filas.map((f) => (
                      <tr key={f.carrito}>
                        <td style={{ color: "#6d7175", padding: "3px 0" }}>
                          {t.previewCarrito} {money(f.carrito)}
                        </td>
                        <td style={{ textAlign: "right", color: "#008060" }}>
                          −{money(f.ahorro)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p
                  style={{
                    fontSize: "12px",
                    color: "#8c9196",
                    margin: "12px 0 0",
                    borderTop: "1px solid #f1f2f3",
                    paddingTop: "10px",
                  }}
                >
                  {t.previewEjemplo(money(carritoEjemplo))}
                </p>
                <table style={{ width: "100%", marginTop: "6px", fontSize: "13px" }}>
                  <tbody>
                    <tr>
                      <td style={{ color: "#6d7175", padding: "3px 0" }}>
                        {t.previewSubtotal}
                      </td>
                      <td style={{ textAlign: "right" }}>{money(carritoEjemplo)}</td>
                    </tr>
                    <tr>
                      <td style={{ color: "#008060", padding: "3px 0" }}>
                        {t.previewAhorro}
                      </td>
                      <td style={{ textAlign: "right", color: "#008060" }}>
                        −{money(ahorroEjemplo)}
                      </td>
                    </tr>
                    <tr style={{ borderTop: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "6px 0", fontWeight: 600 }}>{t.previewTotal}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>
                        {money(carritoEjemplo - ahorroEjemplo)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
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
                  [t.resumenTipo, t.resumenTipoValorCarrito],
                  [t.resumenModo, esPorcentaje ? t.modoPorcentaje : t.modoMonto],
                  [t.resumenNiveles, String(normalizados.length)],
                  [
                    t.resumenDesde,
                    normalizados.length ? money(normalizados[0].minSubtotal) : "—",
                  ],
                  [
                    t.resumenMaximo,
                    maximo > 0 ? (esPorcentaje ? `${maximo}%` : money(maximo)) : "—",
                  ],
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
    </Form>
  );
}
