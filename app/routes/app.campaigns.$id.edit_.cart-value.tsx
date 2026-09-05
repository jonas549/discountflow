import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  CartValueCampaignForm,
  type CartValueFormErrors,
} from "../components/CartValueCampaignForm";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { rejectIfCampaignBusy } from "../lib/jobs/enqueue.server";
import {
  createCartValueDiscount,
  updateCartValueDiscount,
} from "../lib/discounts/cart-value";
import {
  CART_VALUE_DEFAULT_MESSAGE,
  type CartValueCampaignConfig,
} from "../lib/discounts/cart-value-client";
import { campanasQuePuedenChocar } from "../lib/discounts/cart-value.server";
import {
  parseCartValueForm,
  validateCartValueForm,
  buildCartValueConfig,
} from "../lib/discounts/cart-value-form";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const campaign = await prisma.campaign.findFirst({
    where: { id: params.id!, shopId: shop.id, type: "CART_VALUE" },
  });
  if (!campaign) throw new Response("Not found", { status: 404 });

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      startsAt: campaign.startsAt ? campaign.startsAt.toISOString().slice(0, 16) : "",
      endsAt: campaign.endsAt ? campaign.endsAt.toISOString().slice(0, 16) : "",
      config: campaign.config as CartValueCampaignConfig,
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
  const f = parseCartValueForm(await request.formData());

  const errors = validateCartValueForm(f);
  if (Object.keys(errors).length > 0)
    return Response.json({ errors }, { status: 422 });

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const existing = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id, type: "CART_VALUE" },
  });
  if (!existing) throw new Response("Not found", { status: 404 });

  const previous = existing.config as CartValueCampaignConfig;
  const campaignStartsAt = f.startsAt ? new Date(f.startsAt) : null;
  const campaignEndsAt = f.endsAt ? new Date(f.endsAt) : null;

  // Los handles de Shopify se conservan: son del descuento, no del formulario.
  const config: CartValueCampaignConfig = {
    ...buildCartValueConfig(f),
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
        await updateCartValueDiscount(
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
        await createCartValueDiscount(
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

export default function EditCartValueCampaign() {
  const { campaign, campanas } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { errors?: CartValueFormErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();

  return (
    <s-page heading="Editar campaña por monto de compra">
      <div style={{ marginBottom: "4px" }}>
        <Link
          to="/app/campaigns"
          style={{ fontSize: "13px", color: "#006fbb", textDecoration: "none" }}
        >
          ← Volver a campañas
        </Link>
      </div>

      <CartValueCampaignForm
        initial={{
          name: campaign.name,
          valueType: campaign.config.valueType ?? "PERCENT",
          message: campaign.config.message ?? CART_VALUE_DEFAULT_MESSAGE,
          tiers: campaign.config.tiers ?? [],
          excludedPackCampaignIds: campaign.config.excludedPackCampaignIds ?? [],
          startsAt: campaign.startsAt,
          endsAt: campaign.endsAt,
        }}
        campanas={campanas}
        errors={actionData?.errors ?? {}}
        limitExceeded={actionData?.limitExceeded}
        isSubmitting={navigation.state === "submitting"}
        showDraftButton={campaign.status === "DRAFT"}
        primaryLabel={campaign.status === "DRAFT" ? "Activar campaña" : "Guardar cambios"}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
