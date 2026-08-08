import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  TieredCampaignForm,
  type TieredFormErrors,
} from "../components/TieredCampaignForm";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { getCollections, getProductMetadata } from "../lib/shopify/admin-api";
import { createTieredDiscount } from "../lib/discounts/tiered";
import { DEFAULT_TIERS } from "../lib/discounts/tiered-client";
import {
  parseTieredForm,
  validateTieredForm,
  buildTieredConfig,
} from "../lib/discounts/tiered-form";
import { type Plan, PLAN_LIMITS, getTypeCampaignLimit } from "../lib/billing/plan-limits";
import {
  getActiveCampaignCount,
  getActiveCampaignCountByType,
} from "../lib/billing/plan-limits.server";
import { es } from "../i18n";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [collections, productMeta] = await Promise.all([
    getCollections(admin),
    getProductMetadata(admin),
  ]);
  return {
    collections,
    availableTags: productMeta.tags,
    availableVendors: productMeta.vendors,
    availableProductTypes: productMeta.productTypes,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const f = parseTieredForm(await request.formData());

  const errors = validateTieredForm(f);
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

  // Límite de plan — solo al activar (los borradores siempre se permiten)
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

    // Sublímite por tipo: máximo de escalonados ACTIVOS simultáneos.
    const typeLimit = getTypeCampaignLimit(plan, "TIERED");
    if (typeLimit !== null) {
      const activeTiered = await getActiveCampaignCountByType(shop.id, "TIERED");
      if (activeTiered >= typeLimit) {
        return Response.json(
          {
            errors: {
              general: es.planes.limiteCampanasTipo("escalonadas", activeTiered, typeLimit),
            },
            limitExceeded: true,
          },
          { status: 422 }
        );
      }
    }
  }

  const config = buildTieredConfig(f);

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name: f.name,
      type: "TIERED",
      status: shouldActivate ? "ACTIVE" : "DRAFT",
      config: config as unknown as Record<string, unknown>,
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  if (shouldActivate) {
    try {
      await createTieredDiscount(
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

export default function NewTieredCampaign() {
  const { availableTags, availableVendors, availableProductTypes } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: TieredFormErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();

  return (
    <s-page heading={es.nuevaTiered.titulo}>
      <div style={{ marginBottom: "4px" }}>
        <Link
          to="/app/campaigns"
          style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}
        >
          {es.nuevaTiered.volver}
        </Link>
      </div>

      <TieredCampaignForm
        initial={{
          name: "",
          mode: "UNIFORM",
          valueType: "PERCENT",
          tiers: DEFAULT_TIERS,
          selectionMode: "products",
          products: [],
          collections: [],
          tags: [],
          vendors: [],
          types: [],
          startsAt: "",
          endsAt: "",
        }}
        availableTags={availableTags}
        availableVendors={availableVendors}
        availableProductTypes={availableProductTypes}
        errors={actionData?.errors ?? {}}
        limitExceeded={actionData?.limitExceeded}
        isSubmitting={navigation.state === "submitting"}
        showDraftButton
        primaryLabel={es.nuevaTiered.btnActivar}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
