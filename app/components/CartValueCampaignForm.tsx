// Formulario compartido de campañas CART_VALUE ("gastá $100 y ahorrás $10").
// Lo usan la ruta de creación y la de edición: la única diferencia entre ambas
// son los valores iniciales y las etiquetas de los botones.

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
  normalizeCartValueTiers,
  validateCartValue,
  MAX_CART_VALUE_PERCENT,
  MAX_CART_VALUE_TIERS,
  type CartValueType,
  type CartValueTier,
} from "../lib/discounts/cart-value-calc";

export type CartValueFormErrors = {
  name?: string;
  tiers?: string;
  dates?: string;
  general?: string;
};

/** Un pack activo de la tienda, para la lista de exclusiones. */
export type PackParaExcluir = { id: string; name: string };

/** Lo que el formulario necesita saber sobre el resto de campanas de la tienda. */
export type CampanasQuePuedenChocar = {
  /** Packs: el merchant elige si se suman o se excluyen. */
  packs: PackParaExcluir[];
  /**
   * Escalonados y BxGy: NO se puede elegir. Sus descuentos se crean con
   * `combinesWith.orderDiscounts: false`, asi que Shopify descarta este
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
  /** Packs (excluibles) y campanas que bloquean sin remedio. */
  campanas: CampanasQuePuedenChocar;
  errors: CartValueFormErrors;
  limitExceeded?: boolean;
  isSubmitting: boolean;
  showDraftButton: boolean;
  primaryLabel: string;
}) {
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
    setTocado((t) => (t[k] ? t : { ...t, [k]: true }));

  const esPorcentaje = valueType === "PERCENT";
  const normalizados = normalizeCartValueTiers(tiers, valueType);
  const validacion = validateCartValue(valueType, tiers);

  const setTier = (i: number, patch: Partial<CartValueTier>) => {
    marcar("tiers");
    setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  };

  const toggleExcluido = (id: string) =>
    setExcluidos((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.concat(id)));

  /**
   * Vista previa con un carrito de ejemplo: el umbral más alto más un poco.
   * Sale del MISMO módulo que la Function del checkout, así que no puede
   * mostrar un número distinto del que el comprador va a pagar.
   */
  const carritoEjemplo = normalizados.length
    ? normalizados[normalizados.length - 1].minSubtotal * 1.2
    : 0;
  const preview = computeCartValue(valueType, normalizados, carritoEjemplo);
  const ahorroPreview = preview.applies
    ? preview.emit === "PERCENTAGE"
      ? (carritoEjemplo * (preview.percent ?? 0)) / 100
      : preview.amount ?? 0
    : 0;

  var nSeccion = 0;
  const num = (titulo: string) => `${++nSeccion} · ${titulo}`;

  return (
    <Form method="post">
      {errors.general && (
        <GeneralErrorBanner message={errors.general} limitExceeded={limitExceeded} />
      )}

      <Section title={num("Información general")}>
        <FieldGroup
          label="Nombre de la campaña"
          helper="Solo lo ves tú, para identificarla en tu lista."
          error={err("name")}
        >
          <input
            name="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              marcar("name");
            }}
            placeholder="Ej. Ahorro por monto de compra"
            style={err("name") ? inputErrorStyle : inputStyle}
          />
        </FieldGroup>

        <FieldGroup
          label="Texto que ve el comprador"
          helper="Aparece junto al descuento en el carrito y el checkout."
        >
          <input
            name="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Descuento por monto de compra"
            style={inputStyle}
          />
        </FieldGroup>
      </Section>

      <Section title={num("¿En qué se descuenta?")}>
        <input type="hidden" name="valueType" value={valueType} />
        <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
          {(
            [
              ["PERCENT", "Porcentaje", "Un % del subtotal del carrito."],
              ["AMOUNT", "Monto fijo", "Una cantidad de dinero, sea cual sea el carrito."],
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

      <Section title={num("Niveles por monto de carrito")}>
        <input type="hidden" name="tiersJson" value={JSON.stringify(tiers)} />
        <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
          Definí desde qué monto de carrito aplica cada descuento. Por encima del
          último nivel el descuento se mantiene.
        </p>

        {/* 🔴 El umbral se mide sobre el subtotal YA REBAJADO por otros
            descuentos (decisión de producto del 2026-09-05, opción B). Decirlo
            acá y no en la documentación: es donde el merchant escribe el número
            y donde la diferencia le cambia la cuenta. */}
        <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "6px" }}>
          El monto se mide sobre el subtotal <strong>después</strong> de otros
          descuentos de producto.
        </p>

        {tiers.map((t, i) => (
          <div
            key={i}
            style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "10px" }}
          >
            <span style={{ fontSize: "13px", color: "#6d7175" }}>Desde</span>
            <DecimalInput
              value={t.minSubtotal}
              onChange={(n) => setTier(i, { minSubtotal: n })}
              style={{ ...inputStyle, width: "120px" }}
            />
            <span style={{ fontSize: "13px", color: "#6d7175" }}>
              {esPorcentaje ? "→ descontar" : "→ descontar $"}
            </span>
            <DecimalInput
              value={(esPorcentaje ? t.percent : t.amount) ?? 0}
              onChange={(n) => setTier(i, esPorcentaje ? { percent: n } : { amount: n })}
              style={{ ...inputStyle, width: "100px" }}
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
              Quitar
            </Btn>
          </div>
        ))}

        {tiers.length < MAX_CART_VALUE_TIERS && (
          <div style={{ marginTop: "12px" }}>
            <Btn
              variant="secondary"
              onClick={() => {
                marcar("tiers");
                const ultimo = tiers[tiers.length - 1];
                setTiers((ts) =>
                  ts.concat(
                    esPorcentaje
                      ? { minSubtotal: (ultimo?.minSubtotal ?? 0) + 50000, percent: 5 }
                      : { minSubtotal: (ultimo?.minSubtotal ?? 0) + 50000, amount: 5000 }
                  )
                );
              }}
            >
              + Agregar nivel
            </Btn>
          </div>
        )}

        {err("tiers") && (
          <p style={{ fontSize: "12px", color: "#d82c0d", marginTop: "8px" }}>
            {err("tiers")}
          </p>
        )}
        {validacion.warnings.map((w) => (
          <p key={w} style={{ fontSize: "12px", color: "#a05c00", marginTop: "8px" }}>
            {w}
          </p>
        ))}

        {preview.applies && (
          <div
            style={{
              marginTop: "16px",
              padding: "12px 14px",
              background: "#f6f6f7",
              borderRadius: "8px",
              fontSize: "13px",
            }}
          >
            <strong>Vista previa.</strong> Un carrito de {money(carritoEjemplo)}{" "}
            ahorraría {money(ahorroPreview)} y pagaría{" "}
            {money(carritoEjemplo - ahorroPreview)}.
          </div>
        )}
      </Section>

      {/* ── La exclusión entre campañas ──
       *
       * 🔴 Existe por un fallo medido, no por si acaso. El 2026-09-05, en dev,
       * un pack aplicó su 30% y este descuento desapareció sin que nadie se
       * enterara: ni el comprador, ni el merchant, ni un log. La causa era
       * `combinesWith`, ya arreglado — pero arreglarlo solo deja dos opciones:
       * que se sumen, o que Shopify elija en silencio. Acá el merchant elige.
       */}
      {campanas.packs.length > 0 && (
        <Section title={num("Cuándo NO aplicar este descuento")}>
          <input
            type="hidden"
            name="excludedPacksJson"
            value={JSON.stringify(excluidos)}
          />
          <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
            Si el comprador tiene en el carrito un pack de los que marques acá,
            este descuento no se aplica. Los que dejes sin marcar se suman al
            descuento del pack.
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
                No aplicar si está aplicando <strong>{p.name}</strong>
              </span>
            </label>
          ))}

          <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "12px" }}>
            Solo aparecen packs: son las únicas campañas que dejan una marca en
            las líneas del carrito, y sin esa marca no hay forma de saber desde
            el checkout si están aplicando.
          </p>
        </Section>
      )}

      {campanas.bloqueantes.length > 0 && (
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #f9a825",
            borderRadius: "8px",
            padding: "12px 16px",
            color: "#a05c00",
            fontSize: "13px",
            marginBottom: "16px",
            lineHeight: 1.5,
          }}
        >
          <strong>Estas campañas anulan este descuento y no se puede evitar:</strong>{" "}
          {campanas.bloqueantes.join(" · ")}. Si alguna de ellas está aplicando en
          el carrito, el descuento por monto de compra no se suma. Es una
          limitación de cómo están configuradas hoy, no algo que puedas cambiar
          desde acá.
        </div>
      )}

      <Section title={num("Programar campaña")} defaultOpen={false}>
        <FieldGroup
          label="Fecha de inicio"
          helper="Vacío = empieza de inmediato."
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
        <FieldGroup label="Fecha de fin" helper="Vacío = sin fecha de fin.">
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

      <ActionBar>
        <Btn type="submit" name="intent" value="activate" disabled={isSubmitting}>
          {primaryLabel}
        </Btn>
        {showDraftButton && (
          <Btn
            type="submit"
            name="intent"
            value="draft"
            variant="secondary"
            disabled={isSubmitting}
          >
            Guardar borrador
          </Btn>
        )}
        <Link to="/app/campaigns" style={{ fontSize: "13px", color: "#6d7175" }}>
          Cancelar
        </Link>
      </ActionBar>

      <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "8px" }}>
        El descuento se calcula en el carrito y el checkout. Los precios de las
        páginas de producto no cambian. El máximo por nivel es{" "}
        {MAX_CART_VALUE_PERCENT}%.
      </p>
    </Form>
  );
}
