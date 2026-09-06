import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  OriginalPriceCampaignForm,
  type OriginalPriceFormErrors,
} from "../components/OriginalPriceCampaignForm";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { getProductsByIds, getCollectionsByIds } from "../lib/shopify/admin-api";
import { rejectIfCampaignBusy } from "../lib/jobs/enqueue.server";
import {
  createOriginalPriceDiscount,
  updateOriginalPriceDiscount,
  deleteOriginalPriceDiscount,
} from "../lib/discounts/original-price";
import {
  ORIGINAL_PRICE_DEFAULT_MESSAGE,
  originalPriceMetodo,
  originalPriceModo,
  type OriginalPriceCampaignConfig,
} from "../lib/discounts/original-price-client";
import { campanasQuePuedenChocar } from "../lib/discounts/cart-value.server";
import {
  parseOriginalPriceForm,
  validateOriginalPriceForm,
  buildOriginalPriceConfig,
} from "../lib/discounts/original-price-form";
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
    where: { id: params.id!, shopId: shop.id, type: "CODE_ORIGINAL_PRICE" },
  });
  if (!campaign) throw new Response("Not found", { status: 404 });

  const config = campaign.config as OriginalPriceCampaignConfig;

  /**
   * Los chips se rehidratan con los TÍTULOS, no con los IDs.
   *
   * La config guarda IDs, que es lo correcto —un título cambia y un ID no—,
   * pero un formulario que abre mostrando `gid://shopify/Product/123` no le
   * dice nada al merchant. Se piden solo si hay algo que pedir: una campaña de
   * toda la tienda no gasta ni una llamada.
   */
  const [productosElegidos, coleccionesElegidas] = await Promise.all([
    config.selectionMode === "products" && (config.productIds ?? []).length > 0
      ? getProductsByIds(admin, config.productIds ?? [])
      : Promise.resolve([]),
    config.selectionMode === "collections" && (config.collectionIds ?? []).length > 0
      ? getCollectionsByIds(admin, config.collectionIds ?? [])
      : Promise.resolve([]),
  ]);

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      startsAt: campaign.startsAt ? campaign.startsAt.toISOString().slice(0, 16) : "",
      endsAt: campaign.endsAt ? campaign.endsAt.toISOString().slice(0, 16) : "",
      config,
    },
    productosElegidos,
    coleccionesElegidas,
    campanas: await campanasQuePuedenChocar(shop.id),
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const ocupada = await rejectIfCampaignBusy(session.shop, params.id!);
  if (ocupada) return ocupada;

  const campaignId = params.id!;
  const f = parseOriginalPriceForm(await request.formData());

  const errors = validateOriginalPriceForm(f);
  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const existing = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id, type: "CODE_ORIGINAL_PRICE" },
  });
  if (!existing) throw new Response("Not found", { status: 404 });

  const previous = existing.config as OriginalPriceCampaignConfig;
  const campaignStartsAt = f.startsAt ? new Date(f.startsAt) : null;
  const campaignEndsAt = f.endsAt ? new Date(f.endsAt) : null;

  // Los handles de Shopify se conservan: son del descuento, no del formulario.
  const config: OriginalPriceCampaignConfig = {
    ...buildOriginalPriceConfig(f),
    shopifyDiscountId: previous.shopifyDiscountId,
    functionId: previous.functionId,
  };

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      name: f.name,
      config: config as unknown as Record<string, unknown>,
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  // El descuento en Shopify solo se toca si la campaña no es un borrador.
  if (existing.status === "ACTIVE" || existing.status === "PAUSED") {
    /**
     * 🔴 CAMBIAR DE MÉTODO NO ES UNA EDICIÓN: ES OTRO OBJETO.
     *
     * Un descuento de código y uno automático son dos familias distintas en
     * Shopify (`discountCodeApp*` vs `discountAutomaticApp*`). No hay mutación
     * que convierta uno en otro, así que hay que borrar el viejo y crear el
     * nuevo.
     *
     * El orden es BORRAR PRIMERO y a propósito: si se creara antes, un fallo al
     * borrar dejaría los dos descuentos vivos en la tienda y el comprador
     * podría recibir el cupón dos veces. Al revés, un fallo tras el borrado
     * deja la campaña sin descuento — visible, sin cobro de más, y se arregla
     * volviendo a guardar.
     */
    const metodoAnterior = originalPriceMetodo(previous);
    const metodoNuevo = originalPriceMetodo(config);
    const cambioDeMetodo =
      metodoAnterior !== metodoNuevo && Boolean(previous.shopifyDiscountId);

    if (cambioDeMetodo) {
      try {
        await deleteOriginalPriceDiscount(
          admin,
          previous.shopifyDiscountId!,
          metodoAnterior
        );
      } catch (err) {
        return Response.json(
          {
            errors: {
              general:
                "No se pudo quitar el descuento anterior al cambiar de método: " +
                `${String(err)}. La campaña quedó como estaba; volvé a intentarlo.`,
            },
          },
          { status: 500 }
        );
      }
    }

    try {
      if (previous.shopifyDiscountId && !cambioDeMetodo) {
        await updateOriginalPriceDiscount(
          admin,
          campaignId,
          f.name,
          previous.shopifyDiscountId,
          config,
          campaignStartsAt,
          campaignEndsAt
        );
      } else {
        // Dos caminos llegan acá: el cambio de método (el descuento viejo ya se
        // borró arriba) y una campaña activa sin descuento asociado, que no
        // debería pasar. En los dos, se crea de cero.
        await createOriginalPriceDiscount(
          admin,
          campaignId,
          f.name,
          config,
          campaignStartsAt,
          campaignEndsAt
        );
      }
    } catch (err) {
      /**
       * 🔴 LA CAUSA RAÍZ DEL BUG DEL 2026-09-06.
       *
       * Si veníamos de un CAMBIO DE MÉTODO, el descuento viejo ya se borró
       * arriba. Si además falla el `create`, la campaña queda ACTIVA apuntando
       * a un descuento que ya no existe — y desde ahí no se la puede pausar:
       * Shopify responde "discount does not exist", el motor de jobs lo toma
       * por transitorio, reintenta cinco veces y se rinde. Atascada para
       * siempre.
       *
       * Así que no se deja el muerto: se limpia el id y la campaña queda
       * PAUSADA. Ese estado sí es recuperable, y sin tocar nada compartido:
       *
       *   · Activar   → como no hay id, el listado la RECREA (rama `else`).
       *   · Eliminar  → `deleteHandler` hace `if (id)`, se saltea Shopify y
       *                 borra la fila.
       *   · Pausar    → no hace falta, ya está pausada.
       *
       * Se elige PAUSED y no DRAFT porque es la verdad: el merchant la había
       * activado y ahora no está descontando.
       */
      if (cambioDeMetodo) {
        const sinDescuento = { ...config };
        delete sinDescuento.shopifyDiscountId;

        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            status: "PAUSED",
            config: sinDescuento as unknown as Record<string, unknown>,
          },
        });

        return Response.json(
          {
            errors: {
              general:
                "Se cambió el método, pero no se pudo crear el descuento nuevo en " +
                `Shopify: ${String(err)}. La campaña quedó PAUSADA y sin descuento — ` +
                "activala de nuevo para recrearlo.",
            },
          },
          { status: 500 }
        );
      }

      return Response.json(
        {
          errors: {
            general: `Error al actualizar el descuento en Shopify: ${String(err)}`,
          },
        },
        { status: 500 }
      );
    }
  }

  return redirect("/app/campaigns");
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function EditOriginalPriceCampaign() {
  const { campaign, campanas, productosElegidos, coleccionesElegidas } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: OriginalPriceFormErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();

  return (
    <s-page heading={es.nuevoCupon.tituloEditar}>
      <div style={{ marginBottom: "4px" }}>
        <Link
          to="/app/campaigns"
          style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}
        >
          {es.nuevoCupon.volver}
        </Link>
      </div>

      <OriginalPriceCampaignForm
        initial={{
          name: campaign.name,
          code: campaign.config.code ?? "",
          percent: campaign.config.percent ?? 10,
          message: campaign.config.message ?? ORIGINAL_PRICE_DEFAULT_MESSAGE,
          excludedPackCampaignIds: campaign.config.excludedPackCampaignIds ?? [],
          excludedCartValueCampaignIds:
            campaign.config.excludedCartValueCampaignIds ?? [],

          // Ausente = código: es como nació el tipo y como están las campañas
          // guardadas antes de que el método existiera.
          metodo: originalPriceMetodo(campaign.config),

          // Ausente = SUMA: es como se venía calculando esta campaña, y abrir
          // el formulario no puede cambiarle el dinero.
          modo: originalPriceModo(campaign.config),

          // Ausente = "all": es lo que aplicaban las campañas guardadas antes
          // de que existiera el alcance, y cambiárselas en silencio sería
          // cambiarle la campaña al merchant sin avisarle.
          selectionMode: campaign.config.selectionMode ?? "all",
          products: productosElegidos.map((p) => ({
            id: p.id,
            title: p.title,
            variantCount: p.variants?.length ?? 0,
          })),
          collections: coleccionesElegidas.map((c) => ({ id: c.id, title: c.title })),

          // La casilla se deduce de que HAYA límite guardado, no de un tercer
          // campo: dos fuentes para el mismo hecho es una de más.
          limitarUsos: (campaign.config.usageLimit ?? null) !== null,
          usageLimit: campaign.config.usageLimit ?? null,
          oncePerCustomer: campaign.config.oncePerCustomer === true,

          minimumType: campaign.config.minimumType ?? "none",
          minSubtotal: campaign.config.minSubtotal ?? null,
          minQuantity: campaign.config.minQuantity ?? null,

          startsAt: campaign.startsAt,
          endsAt: campaign.endsAt,
        }}
        campanas={campanas}
        errors={actionData?.errors ?? {}}
        limitExceeded={actionData?.limitExceeded}
        isSubmitting={navigation.state === "submitting"}
        showDraftButton={campaign.status === "DRAFT"}
        primaryLabel={
          campaign.status === "DRAFT"
            ? es.nuevoCupon.btnActivar
            : es.nuevoCupon.btnGuardar
        }
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
