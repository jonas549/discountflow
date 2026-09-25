// Crear una campaña de cupones de viaje. Sin el flag, 404.

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, redirect, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { TravelCouponCampaignForm } from "../components/TravelCouponCampaignForm";
import { abrirCuponesDeViaje, esProduccion } from "../lib/cupones-viaje/admin.server";
import { guardarCampana } from "../lib/cupones-viaje/cupones-viaje.server";
import {
  leerDatosDelFormulario,
  validarFormulario,
  MENSAJE_PAGO_TOTAL_POR_DEFECTO,
  MENSAJE_RESERVA_POR_DEFECTO,
  TITULO_POR_DEFECTO,
  type ErroresDelFormulario,
} from "../lib/cupones-viaje/cupones-viaje";
import { es } from "../i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await abrirCuponesDeViaje(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await abrirCuponesDeViaje(request);
  const form = await request.formData();

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
  const { errores, cupones } = validarFormulario(datos);
  if (Object.keys(errores).length > 0) return Response.json({ errors: errores }, { status: 422 });

  try {
    await guardarCampana(admin, shop.id, datos, cupones, {
      estado: form.get("intent") === "activate" ? "ACTIVE" : "DRAFT",
    });
    return redirect("/app/campaigns");
  } catch (err) {
    return Response.json(
      { errors: { general: es.cuponesViaje.errGuardar(err instanceof Error ? err.message : String(err)) } },
      { status: 500 }
    );
  }
};

export default function NuevaCampanaDeViaje() {
  const actionData = useActionData<typeof action>() as { errors?: ErroresDelFormulario } | undefined;
  const navigation = useNavigation();
  const t = es.cuponesViaje;

  return (
    <s-page heading={t.tituloNueva}>
      <div style={{ marginBottom: "4px" }}>
        <Link to="/app/campaigns" style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}>
          {t.volverCampanas}
        </Link>
      </div>
      <TravelCouponCampaignForm
        initial={{
          name: "",
          productId: "",
          productTitle: "",
          optionName: "",
          fullPaymentValue: "",
          reservationValue: "",
          visibleCount: 1,
          // Las campañas nuevas nacen con el cupón marcado: es lo que pidió
          // la agencia (2026-09-25). El merchant lo cambia en el formulario.
          autoApply: true,
          heading: TITULO_POR_DEFECTO,
          messageFullPayment: MENSAJE_PAGO_TOTAL_POR_DEFECTO,
          messageReservation: MENSAJE_RESERVA_POR_DEFECTO,
          coupons: [
            { key: "inicial-1", label: "Cupón 1", amount: "", stock: "5", used: 0, tieneCanjes: false },
          ],
        }}
        productoInicial={null}
        errors={actionData?.errors ?? {}}
        isSubmitting={navigation.state === "submitting"}
        primaryLabel={t.btnActivar}
        showDraftButton
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
