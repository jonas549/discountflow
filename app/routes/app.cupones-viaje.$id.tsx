// Editar una campaña de cupones de viaje: el formulario, su estado, los canjes
// (lo que mira la agencia al cobrar saldos), la instalación en el tema y, solo
// en desarrollo, la simulación de pedidos. Sin el flag, 404.

import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { TravelCouponCampaignForm } from "../components/TravelCouponCampaignForm";
import { Btn } from "../components/Btn";
import { abrirCuponesDeViaje, esProduccion } from "../lib/cupones-viaje/admin.server";
import {
  campanaDeLaTienda,
  canjesDeLaCampana,
  cambiarEstado,
  eliminarCampana,
  guardarCampana,
  leerProductoDeViaje,
  necesitaSincronizar,
  otraCampanaActivaDelProducto,
  registrarPedido,
  sincronizarConShopify,
  type ProductoDeViaje,
} from "../lib/cupones-viaje/cupones-viaje.server";
import {
  ATRIBUTO_CUPON,
  cuponesPublicados,
  formatoMonto,
  leerDatosDelFormulario,
  validarFormulario,
  type ErroresDelFormulario,
} from "../lib/cupones-viaje/cupones-viaje";
import { es, estadoLabel, formatDate } from "../i18n";

/**
 * El bloque que se pega en el tema. Una sola vez, sirve para todos los viajes.
 *
 * Va por el app proxy (`/apps/discountflow/…`) y no por un bloque de tema a
 * propósito: un bloque obliga a sacar una app version y aparece en el editor de
 * temas de TODAS las tiendas. Esto no existe para nadie más.
 */
const SNIPPET = `<div data-df-cupones-viaje data-product-id="{{ product.id }}" data-money-format="{{ shop.money_format | escape }}"></div>
<script src="/apps/discountflow/cupones-viaje.js" defer></script>`;

/**
 * La segunda línea, para la plantilla del CARRITO. No muestra nada: si el
 * comprador cambia la cantidad de pasajeros en la página del carrito, corrige el
 * total a descontar del saldo. Sin esto, ese total queda con la cantidad que
 * había cuando el comprador pinchó el cupón en la ficha.
 */
const SNIPPET_CARRITO = `<div data-df-cupones-viaje-carrito hidden data-money-format="{{ shop.money_format | escape }}"></div>
<script src="/apps/discountflow/cupones-viaje.js" defer></script>`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, shop } = await abrirCuponesDeViaje(request);
  let campana = await campanaDeLaTienda(shop.id, params.id ?? "");
  if (!campana) throw new Response("No encontrado", { status: 404 });

  // Reconciliador: si un código no está como debería (un canje llegó sin sesión,
  // o una llamada a Shopify falló a medias), se arregla al abrir la campaña.
  let avisoSincronizacion: string | null = null;
  if (necesitaSincronizar(campana)) {
    try {
      await sincronizarConShopify(admin, campana.id);
      campana = (await campanaDeLaTienda(shop.id, campana.id)) ?? campana;
    } catch (err) {
      avisoSincronizacion = String(err instanceof Error ? err.message : err);
    }
  }

  let producto: ProductoDeViaje | null = null;
  try {
    producto = await leerProductoDeViaje(admin, campana.productId);
  } catch {
    // El formulario sigue funcionando: al guardar se vuelve a leer y, si falla,
    // el error sale ahí con su mensaje.
    producto = null;
  }

  const [canjes, otra] = await Promise.all([
    canjesDeLaCampana(campana.id),
    otraCampanaActivaDelProducto(shop.id, campana.productId, campana.id),
  ]);

  return {
    campana: {
      id: campana.id,
      name: campana.name,
      status: campana.status,
      productId: campana.productId,
      productTitle: campana.productTitle,
      optionName: campana.optionName,
      fullPaymentValue: campana.fullPaymentValue,
      reservationValue: campana.reservationValue,
      visibleCount: campana.visibleCount,
      autoApply: campana.autoApply,
      heading: campana.heading,
      messageFullPayment: campana.messageFullPayment,
      messageReservation: campana.messageReservation,
      coupons: campana.coupons.map((c) => ({
        id: c.id,
        label: c.label,
        amount: Number(c.amount),
        stock: c.stock,
        used: c.used,
      })),
    },
    cuponesConCanjes: [...new Set(canjes.map((r) => r.couponId))],
    producto: producto ? { options: producto.options, variants: producto.variants } : null,
    canjes: canjes.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      orderId: r.shopifyOrderId,
      orderName: r.orderName,
      mode: r.mode,
      cupon: r.coupon.label,
      passengers: r.passengers,
      excessPassengers: r.excessPassengers,
      amount: Number(r.amount),
      excess: r.excess,
      source: r.source,
    })),
    otraActiva: otra?.name ?? null,
    avisoSincronizacion,
    puedeSimular: !esProduccion(),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, shop } = await abrirCuponesDeViaje(request);
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fallo = (err: unknown, status = 500) =>
    Response.json(
      { errors: { general: es.cuponesViaje.errGuardar(err instanceof Error ? err.message : String(err)) } },
      { status }
    );

  // El listado de campañas manda acá pausar, activar y eliminar con un fetcher,
  // igual que para los otros tipos. Ahí no se navega: se responde JSON con la
  // forma que ya entiende su banner (`{ error }`).
  const desdeListado = form.get("desde") === "listado";

  try {
    if (intent === "pausar" || intent === "activar-campana") {
      await cambiarEstado(admin, shop.id, id, intent === "pausar" ? "PAUSED" : "ACTIVE");
      return desdeListado ? Response.json({ ok: true }) : redirect(`/app/cupones-viaje/${id}`);
    }
    if (intent === "eliminar") {
      await eliminarCampana(admin, shop.id, id);
      return desdeListado ? Response.json({ ok: true }) : redirect("/app/campaigns");
    }
    if (intent === "simular-total" || intent === "simular-reserva") {
      // 🔴 Solo desarrollo. En producción el canje llega por el webhook real.
      if (esProduccion()) return fallo("La simulación no existe en producción.", 403);
      return Response.json({ simulacion: await simular(admin, shop.id, id, intent) });
    }

    // Guardar el formulario.
    const campana = await campanaDeLaTienda(shop.id, id);
    if (!campana) throw new Response("No encontrado", { status: 404 });
    let crudo: unknown = null;
    try {
      crudo = JSON.parse(String(form.get("datos") ?? ""));
    } catch {
      crudo = null;
    }
    const datos = leerDatosDelFormulario(crudo);
    // 🔎 SOLO EN DESARROLLO: lo que el formulario mandó, tal cual. Existe por un
    // reporte que no se pudo reproducir (un cupón que se tecleó 100.000 / 5 y se
    // guardó 500.000 / 1): si vuelve a pasar, esta línea en la terminal de
    // `shopify app dev` dice si el valor ya salió así del navegador.
    if (!esProduccion())
      console.info("[cupones-viaje] cupones recibidos:", JSON.stringify(datos.coupons));
    const usados = Object.fromEntries(campana.coupons.map((c) => [c.id, c.used]));
    const { errores, cupones } = validarFormulario(datos, usados);
    if (Object.keys(errores).length > 0) return Response.json({ errors: errores }, { status: 422 });

    // «Guardar y activar» solo cambia el estado de un BORRADOR. En una campaña
    // activa o pausada, guardar es guardar: no la despausa sin que lo pidan.
    const estado = campana.status === "DRAFT" && intent === "activate" ? "ACTIVE" : undefined;
    await guardarCampana(admin, shop.id, datos, cupones, { campaignId: id, estado });
    return redirect("/app/campaigns");
  } catch (err) {
    if (err instanceof Response) throw err;
    if (desdeListado)
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 422 });
    return fallo(err);
  }
};

/**
 * Un pedido FALSO que recorre exactamente el mismo camino que el webhook
 * (`registrarPedido`), para ver en desarrollo cómo baja el stock y se libera el
 * siguiente cupón. Existe porque la app de dev NO recibe `orders/create`
 * (falta la aprobación de Protected Customer Data): sin esto, la liberación
 * automática no se podría probar desde la app.
 */
async function simular(
  admin: Parameters<typeof registrarPedido>[2],
  shopId: string,
  campaignId: string,
  intent: "simular-total" | "simular-reserva"
) {
  const campana = await campanaDeLaTienda(shopId, campaignId);
  if (!campana) throw new Error("La campaña no existe.");
  const cupon = cuponesPublicados(campana.coupons, campana.visibleCount)[0];
  if (!cupon) return { texto: es.cuponesViaje.simularSinPublicado };

  const esTotal = intent === "simular-total";
  const lista = (esTotal ? campana.fullPaymentVariantIds : campana.reservationVariantIds) as string[];
  const variante = Number(String(lista[0] ?? "").split("/").pop());
  if (!variante) throw new Error("El viaje no tiene variantes de esa modalidad.");

  const sello = Date.now();
  const resultado = await registrarPedido(
    shopId,
    {
      admin_graphql_api_id: `gid://shopify/Order/SIMULADO-${sello}`,
      name: `#SIM-${String(sello).slice(-5)}`,
      line_items: [{ variant_id: variante, quantity: 1 }],
      discount_codes: esTotal ? [{ code: cupon.code }] : [],
      // Como lo escribe el widget: el nombre del cupón, no el código.
      note_attributes: esTotal
        ? []
        : [{ name: ATRIBUTO_CUPON, value: `${cupon.label} · ${formatoMonto(Number(cupon.amount))} por pasajero` }],
    },
    admin,
    "simulado"
  );
  return {
    texto: es.cuponesViaje.simulado_ok(cupon.label, resultado[0]?.resultado ?? "sin consumo"),
  };
}

export default function EditarCampanaDeViaje() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: ErroresDelFormulario; simulacion?: { texto: string } }
    | undefined;
  const navigation = useNavigation();
  const t = es.cuponesViaje;
  const c = data.campana;
  const [copiado, setCopiado] = useState(false);

  const estadoTexto =
    c.status === "ACTIVE" ? t.estadoActiva : c.status === "PAUSED" ? t.estadoPausada : t.estadoBorrador;
  const tieneCanjes = data.canjes.length > 0;
  const celda: React.CSSProperties = { padding: "8px 6px", borderBottom: "1px solid #f1f2f3", fontSize: "13px" };
  const tarjeta: React.CSSProperties = {
    border: "1px solid #e1e3e5",
    borderRadius: "10px",
    background: "#fff",
    padding: "16px 18px",
    marginTop: "20px",
  };

  return (
    <s-page heading={t.tituloEditar}>
      <div style={{ marginBottom: "4px" }}>
        <Link to="/app/campaigns" style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}>
          {t.volverCampanas}
        </Link>
      </div>

      {/* Estado de la campaña y sus acciones. Fuera del <Form> del formulario:
          pausar no debe mandar (ni validar) los campos que se estén editando. */}
      <div
        style={{
          ...tarjeta,
          marginTop: 0,
          marginBottom: "16px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: "14px" }}>{estadoLabel(c.status)}</strong>
        <span style={{ fontSize: "13px", color: "#6d7175", flex: 1 }}>{estadoTexto}</span>
        <Form method="post" style={{ display: "flex", gap: "8px" }}>
          {c.status === "ACTIVE" && (
            <Btn type="submit" name="intent" value="pausar" variant="muted" size="sm">
              {t.btnPausar}
            </Btn>
          )}
          {c.status !== "ACTIVE" && (
            <Btn type="submit" name="intent" value="activar-campana" variant="primary" size="sm">
              {t.btnActivarCampana}
            </Btn>
          )}
          <Btn
            type="submit"
            name="intent"
            value="eliminar"
            variant="destructive"
            size="sm"
            disabled={tieneCanjes}
            onClick={(e: React.MouseEvent) => {
              if (!confirm(t.confirmarEliminar)) e.preventDefault();
            }}
          >
            {t.btnEliminar}
          </Btn>
        </Form>
        {tieneCanjes && (
          <span style={{ fontSize: "12px", color: "#8c9196", width: "100%" }}>{t.eliminarBloqueado}</span>
        )}
      </div>

      {data.avisoSincronizacion && (
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
          {data.avisoSincronizacion}
        </div>
      )}

      <TravelCouponCampaignForm
        key={c.id + c.coupons.map((x) => `${x.id}:${x.used}`).join(",")}
        initial={{
          name: c.name,
          productId: c.productId,
          productTitle: c.productTitle,
          optionName: c.optionName,
          fullPaymentValue: c.fullPaymentValue,
          reservationValue: c.reservationValue,
          visibleCount: c.visibleCount,
          autoApply: c.autoApply,
          heading: c.heading,
          messageFullPayment: c.messageFullPayment,
          messageReservation: c.messageReservation,
          coupons: c.coupons.map((x) => ({
            key: x.id,
            id: x.id,
            label: x.label,
            amount: String(Math.round(x.amount)),
            stock: String(x.stock),
            used: x.used,
            tieneCanjes: x.used > 0 || data.cuponesConCanjes.includes(x.id),
          })),
        }}
        productoInicial={data.producto}
        errors={actionData?.errors ?? {}}
        isSubmitting={navigation.state === "submitting"}
        primaryLabel={c.status === "DRAFT" ? t.btnActivar : t.btnGuardar}
        showDraftButton={c.status === "DRAFT"}
        avisoOtraActiva={data.otraActiva ? t.avisoOtraActiva(data.otraActiva) : null}
      />

      {/* ── Canjes: lo que mira la agencia al cobrar el saldo ── */}
      <div style={tarjeta}>
        <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>{t.secCanjes}</h3>
        <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>{t.canjesHelper}</p>
        {data.canjes.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#6d7175", marginTop: "12px" }}>{t.sinCanjes}</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "10px" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6d7175", fontSize: "12px" }}>
                <th style={celda}>{t.colFecha}</th>
                <th style={celda}>{t.colPedido}</th>
                <th style={celda}>{t.colModalidad}</th>
                <th style={celda}>{t.colCupon}</th>
                <th style={celda}>{t.colPasajeros}</th>
                <th style={celda}>{t.colDescuento}</th>
                <th style={celda}>{t.colValidez}</th>
              </tr>
            </thead>
            <tbody>
              {data.canjes.map((r) => {
                const numero = r.orderId.split("/").pop() ?? "";
                const real = /^\d+$/.test(numero);
                return (
                  <tr key={r.id}>
                    <td style={celda}>{formatDate(r.createdAt)}</td>
                    <td style={celda}>
                      {real ? (
                        <a href={`shopify://admin/orders/${numero}`} target="_top" style={{ color: "#006fbb" }}>
                          {r.orderName}
                        </a>
                      ) : (
                        <span>
                          {r.orderName} <em style={{ color: "#8c9196" }}>({t.simulado})</em>
                        </span>
                      )}
                    </td>
                    <td style={celda}>{r.mode === "RESERVATION" ? t.modalidadReserva : t.modalidadTotal}</td>
                    <td style={celda}>{r.cupon}</td>
                    <td style={celda}>{r.passengers}</td>
                    <td style={{ ...celda, fontWeight: r.mode === "RESERVATION" ? 600 : 400 }}>
                      {formatoMonto(r.amount)}
                    </td>
                    <td style={{ ...celda, color: r.excess ? "#a05c00" : "#008060" }}>
                      {r.excess ? t.excedente(r.excessPassengers, r.passengers) : t.valido}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Instalación en el tema ── */}
      <div style={tarjeta}>
        <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>{t.secInstalacion}</h3>
        <ol style={{ fontSize: "13px", paddingLeft: "18px", margin: "10px 0" }}>
          {t.instalacionPasos.map((p) => (
            <li key={p} style={{ marginBottom: "4px" }}>
              {p}
            </li>
          ))}
        </ol>
        <textarea
          readOnly
          value={SNIPPET}
          rows={3}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "monospace",
            fontSize: "12px",
            padding: "8px",
            border: "1px solid #c9cccf",
            borderRadius: "6px",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "8px" }}>
          <Btn
            variant="secondary"
            size="sm"
            onClick={() => {
              navigator.clipboard
                ?.writeText(SNIPPET)
                .then(() => setCopiado(true))
                .catch(() => setCopiado(false));
            }}
          >
            {copiado ? t.copiado : t.btnCopiar}
          </Btn>
          <span style={{ fontSize: "12px", color: "#8c9196" }}>{t.instalacionNota}</span>
        </div>

        <h4 style={{ margin: "18px 0 0", fontSize: "13px", fontWeight: 600 }}>{t.instalacionCarritoTitulo}</h4>
        <p style={{ fontSize: "12px", color: "#6d7175", margin: "4px 0 8px" }}>{t.instalacionCarritoTexto}</p>
        <textarea
          readOnly
          value={SNIPPET_CARRITO}
          rows={2}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "monospace",
            fontSize: "12px",
            padding: "8px",
            border: "1px solid #c9cccf",
            borderRadius: "6px",
          }}
        />
      </div>

      {/* ── Simulación: SOLO en desarrollo ── */}
      {data.puedeSimular && (
        <div style={{ ...tarjeta, borderStyle: "dashed" }}>
          <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>{t.secSimular}</h3>
          <p style={{ fontSize: "12px", color: "#8c9196", marginTop: "4px" }}>{t.simularHelper}</p>
          <Form method="post" style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
            <Btn type="submit" name="intent" value="simular-total" variant="secondary" size="sm">
              {t.btnSimularTotal}
            </Btn>
            <Btn type="submit" name="intent" value="simular-reserva" variant="secondary" size="sm">
              {t.btnSimularReserva}
            </Btn>
          </Form>
          {actionData?.simulacion && (
            <p style={{ fontSize: "13px", marginTop: "10px" }}>{actionData.simulacion.texto}</p>
          )}
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
