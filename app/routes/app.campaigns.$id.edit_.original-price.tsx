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
import { rejectIfCampaignBusy } from "../lib/jobs/enqueue.server";
import {
  createOriginalPriceDiscount,
  updateOriginalPriceDiscount,
} from "../lib/discounts/original-price";
import {
  ORIGINAL_PRICE_DEFAULT_MESSAGE,
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
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const campaign = await prisma.campaign.findFirst({
    where: { id: params.id!, shopId: shop.id, type: "CODE_ORIGINAL_PRICE" },
  });
  if (!campaign) throw new Response("Not found", { status: 404 });

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      startsAt: campaign.startsAt ? campaign.startsAt.toISOString().slice(0, 16) : "",
      endsAt: campaign.endsAt ? campaign.endsAt.toISOString().slice(0, 16) : "",
      config: campaign.config as OriginalPriceCampaignConfig,
    },
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
    try {
      if (previous.shopifyDiscountId) {
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
        // Campaña activa sin descuento asociado (no debería pasar): se recrea.
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
  const { campaign, campanas } = useLoaderData<typeof loader>();
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
