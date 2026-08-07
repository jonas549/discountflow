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
import { rejectIfCampaignBusy } from "../lib/jobs/enqueue.server";
import {
  getProductMetadata,
  getProductsByIds,
  getCollectionsByIds,
} from "../lib/shopify/admin-api";
import { createTieredDiscount, updateTieredDiscount } from "../lib/discounts/tiered";
import {
  DEFAULT_TIERS,
  type TieredCampaignConfig,
} from "../lib/discounts/tiered-client";
import {
  parseTieredForm,
  validateTieredForm,
  buildTieredConfig,
} from "../lib/discounts/tiered-form";
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
    where: { id: params.id!, shopId: shop.id, type: "TIERED" },
  });
  if (!campaign) throw new Response("Not found", { status: 404 });

  const config = campaign.config as TieredCampaignConfig;

  const [productMeta, prefilledProducts, prefilledCollections] = await Promise.all([
    getProductMetadata(admin),
    config.selectionMode === "products" && (config.productIds ?? []).length > 0
      ? getProductsByIds(admin, config.productIds)
      : Promise.resolve([]),
    config.selectionMode === "collections" && (config.collectionIds ?? []).length > 0
      ? getCollectionsByIds(admin, config.collectionIds)
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
    prefilledProducts,
    prefilledCollections,
    availableTags: productMeta.tags,
    availableVendors: productMeta.vendors,
    availableProductTypes: productMeta.productTypes,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const ocupada = await rejectIfCampaignBusy(session.shop, params.id!);
  if (ocupada) return ocupada;

  const campaignId = params.id!;
  const f = parseTieredForm(await request.formData());

  const errors = validateTieredForm(f);
  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const existing = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id, type: "TIERED" },
  });
  if (!existing) throw new Response("Not found", { status: 404 });

  const previous = existing.config as TieredCampaignConfig;
  const campaignStartsAt = f.startsAt ? new Date(f.startsAt) : null;
  const campaignEndsAt = f.endsAt ? new Date(f.endsAt) : null;

  const config: TieredCampaignConfig = {
    ...buildTieredConfig(f),
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
        await updateTieredDiscount(
          admin,
          previous.shopifyDiscountId,
          campaignId,
          f.name,
          config,
          campaignStartsAt,
          campaignEndsAt
        );
      } else {
        // Campaña activa sin descuento asociado (no debería pasar): se recrea.
        await createTieredDiscount(
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

  return redirect("/app/campaigns");
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function EditTieredCampaign() {
  const {
    campaign,
    prefilledProducts,
    prefilledCollections,
    availableTags,
    availableVendors,
    availableProductTypes,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: TieredFormErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();

  const config = campaign.config;
  const rawItems = config.rawItems ?? [];

  return (
    <s-page heading={`Editar: ${campaign.name}`}>
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
          name: campaign.name,
          mode: config.mode ?? "UNIFORM",
          tiers: config.tiers?.length ? config.tiers : DEFAULT_TIERS,
          selectionMode: config.selectionMode ?? "products",
          products: prefilledProducts,
          collections: prefilledCollections,
          tags: config.selectionMode === "tags" ? rawItems : [],
          vendors: config.selectionMode === "vendors" ? rawItems : [],
          types: config.selectionMode === "productTypes" ? rawItems : [],
          startsAt: campaign.startsAt,
          endsAt: campaign.endsAt,
        }}
        availableTags={availableTags}
        availableVendors={availableVendors}
        availableProductTypes={availableProductTypes}
        errors={actionData?.errors ?? {}}
        limitExceeded={actionData?.limitExceeded}
        isSubmitting={navigation.state === "submitting"}
        showDraftButton={false}
        primaryLabel="Guardar cambios"
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
