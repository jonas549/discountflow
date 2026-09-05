import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  PackCampaignForm,
  type PackFormErrors,
} from "../components/PackCampaignForm";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { sincronizarMetafieldDeWidget } from "../lib/discounts/pack-widget-metafield.server";
import { rejectIfCampaignBusy } from "../lib/jobs/enqueue.server";
import {
  createPackDiscount,
  updatePackDiscount,
  getPackProductSnapshots,
  findPackOverlaps,
} from "../lib/discounts/pack";
import {
  DEFAULT_PACK_TIERS,
  type PackCampaignConfig,
} from "../lib/discounts/pack-client";
import {
  parsePackForm,
  validatePackForm,
  buildPackConfig,
  type PackFormProduct,
} from "../lib/discounts/pack-form";
import { es } from "../i18n";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const campaign = await prisma.campaign.findFirst({
    where: { id: params.id!, shopId: shop.id, type: "PACK" },
  });
  if (!campaign) throw new Response("Not found", { status: 404 });

  const config = campaign.config as PackCampaignConfig;

  // Los productos se rehidratan de la FOTO guardada, no de la Admin API: la
  // foto ya trae título y porcentaje, así que abrir para editar no cuesta una
  // llamada más. Se refresca al guardar.
  const products: PackFormProduct[] = (config.items ?? []).map((it) => ({
    id: it.productId,
    title: it.title,
    percent:
      config.products?.find((p) => p.productId === it.productId)?.percent ??
      it.percent ??
      0,
  }));

  const overlaps = await findPackOverlaps(
    shop.id,
    (config.products ?? []).map((p) => p.productId),
    campaign.id
  );

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      startsAt: campaign.startsAt ? campaign.startsAt.toISOString().slice(0, 16) : "",
      endsAt: campaign.endsAt ? campaign.endsAt.toISOString().slice(0, 16) : "",
      config,
    },
    products,
    overlapWarning:
      overlaps.length > 0
        ? es.nuevoPack.avisoSolapamiento(
            overlaps.map((o) => `${o.campaignName}: ${o.productCount}`).join(" · ")
          )
        : null,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const ocupada = await rejectIfCampaignBusy(session.shop, params.id!);
  if (ocupada) return ocupada;

  const campaignId = params.id!;
  const f = parsePackForm(await request.formData());

  const errors = validatePackForm(f);
  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const existing = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id, type: "PACK" },
  });
  if (!existing) throw new Response("Not found", { status: 404 });

  const previous = existing.config as PackCampaignConfig;
  const campaignStartsAt = f.startsAt ? new Date(f.startsAt) : null;
  const campaignEndsAt = f.endsAt ? new Date(f.endsAt) : null;

  let items;
  try {
    items = await getPackProductSnapshots(
      admin,
      f.catalog.map((p) => p.productId)
    );
  } catch (err) {
    return Response.json(
      { errors: { general: `No se pudieron leer los productos: ${String(err)}` } },
      { status: 500 }
    );
  }

  const config: PackCampaignConfig = {
    ...buildPackConfig(f, items),
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
    try {
      if (previous.shopifyDiscountId) {
        await updatePackDiscount(
          admin,
          campaignId,
          f.name,
          previous.shopifyDiscountId,
          config,
          campaignStartsAt,
          campaignEndsAt
        );
      } else {
        // Campaña activa sin descuento asociado (no debería pasar): se recrea.
        await createPackDiscount(
          admin,
          campaignId,
          f.name,
          config,
          campaignStartsAt,
          campaignEndsAt
        );
      }
    } catch (err) {
      return Response.json(
        { errors: { general: `Error al actualizar el descuento en Shopify: ${String(err)}` } },
        { status: 500 }
      );
    }
  }

  // El metafield que el bloque de tema lee para pintarse sin pedir nada. Se
  // reescribe SIEMPRE, tambien cuando la campana es un borrador: si el merchant
  // acaba de pausarla o de sacarle productos, el widget tiene que dejar de
  // ofrecerlos. No lanza nunca.
  await sincronizarMetafieldDeWidget(admin, shop.id);

  return redirect("/app/campaigns");
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function EditPackCampaign() {
  const { campaign, products, overlapWarning } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: PackFormErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();

  const config = campaign.config;

  return (
    <s-page heading={`Editar: ${campaign.name}`}>
      <div style={{ marginBottom: "4px" }}>
        <Link
          to="/app/campaigns"
          style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}
        >
          {es.nuevoPack.volver}
        </Link>
      </div>

      <PackCampaignForm
        initial={{
          name: campaign.name,
          heading: config.heading ?? es.nuevoPack.headingPorDefecto,
          mode: config.mode ?? "PER_PRODUCT",
          products,
          tiers: config.tiers?.length ? config.tiers : DEFAULT_PACK_TIERS,
          startsAt: campaign.startsAt,
          endsAt: campaign.endsAt,
        }}
        errors={actionData?.errors ?? {}}
        limitExceeded={actionData?.limitExceeded}
        overlapWarning={overlapWarning ?? undefined}
        isSubmitting={navigation.state === "submitting"}
        showDraftButton={false}
        // Igual que en escalonados: esta pantalla solo guarda. Activar un
        // borrador se hace desde el listado, que es donde vive la rama que CREA
        // el descuento (ver el arreglo del 2026-09-01 del borrador atrapado).
        primaryLabel={es.nuevoPack.btnGuardar}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
