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
import { createOriginalPriceDiscount } from "../lib/discounts/original-price";
import { ORIGINAL_PRICE_DEFAULT_MESSAGE } from "../lib/discounts/original-price-client";
import { campanasQuePuedenChocar } from "../lib/discounts/cart-value.server";
import {
  parseOriginalPriceForm,
  validateOriginalPriceForm,
  buildOriginalPriceConfig,
} from "../lib/discounts/original-price-form";
import { type Plan, PLAN_LIMITS } from "../lib/billing/plan-limits";
import {
  getActiveCampaignCount,
  comprobarTipoDeCampana,
} from "../lib/billing/plan-limits.server";
import { es } from "../i18n";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });
  // Los packs alimentan la lista de exclusiones; el resto, el aviso.
  return { campanas: await campanasQuePuedenChocar(shop.id) };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const f = parseOriginalPriceForm(await request.formData());

  const errors = validateOriginalPriceForm(f);
  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const campaignStartsAt = f.startsAt ? new Date(f.startsAt) : null;
  const campaignEndsAt = f.endsAt ? new Date(f.endsAt) : null;
  const isScheduled = campaignStartsAt !== null && campaignStartsAt > new Date();
  const shouldActivate = f.intent === "activate" && !isScheduled;

  // Límites de plan — solo al activar. Un borrador siempre se puede guardar, así
  // el límite es un argumento de venta y no un muro.
  if (shouldActivate) {
    const plan = (shop.plan as Plan) || "FREE";
    const limits = PLAN_LIMITS[plan];
    const activeCount = await getActiveCampaignCount(shop.id);
    if (activeCount >= limits.campaigns) {
      return Response.json(
        {
          errors: { general: es.planes.limiteCampanas(activeCount, limits.campaigns) },
          limitExceeded: true,
        },
        { status: 422 }
      );
    }

    const bloqueo = await comprobarTipoDeCampana(shop.id, plan, "CODE_ORIGINAL_PRICE");
    if (bloqueo)
      return Response.json(
        { errors: { general: bloqueo }, limitExceeded: true },
        { status: 422 }
      );
  }

  const config = buildOriginalPriceConfig(f);

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name: f.name,
      type: "CODE_ORIGINAL_PRICE",
      status: shouldActivate ? "ACTIVE" : "DRAFT",
      config: config as unknown as Record<string, unknown>,
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  if (shouldActivate) {
    try {
      await createOriginalPriceDiscount(
        admin,
        campaign.id,
        f.name,
        config,
        campaignStartsAt,
        campaignEndsAt
      );
    } catch (err) {
      // Si Shopify falla, no dejamos una campaña huérfana marcada como activa.
      await prisma.campaign.delete({ where: { id: campaign.id } });
      return Response.json(
        { errors: { general: `Error al crear el descuento en Shopify: ${String(err)}` } },
        { status: 500 }
      );
    }
  }

  return redirect("/app/campaigns");
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function NewOriginalPriceCampaign() {
  const { campanas } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: OriginalPriceFormErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();

  return (
    <s-page heading={es.nuevoCupon.titulo}>
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
          name: "",
          code: "",
          percent: 10,
          message: ORIGINAL_PRICE_DEFAULT_MESSAGE,
          excludedPackCampaignIds: [],
          startsAt: "",
          endsAt: "",
        }}
        campanas={campanas}
        errors={actionData?.errors ?? {}}
        limitExceeded={actionData?.limitExceeded}
        isSubmitting={navigation.state === "submitting"}
        showDraftButton
        primaryLabel={es.nuevoCupon.btnActivar}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
