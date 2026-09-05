import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  PackCampaignForm,
  type PackFormErrors,
} from "../components/PackCampaignForm";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import {
  createPackDiscount,
  getPackProductSnapshots,
  findPackOverlaps,
} from "../lib/discounts/pack";
import { DEFAULT_PACK_TIERS } from "../lib/discounts/pack-client";
import {
  parsePackForm,
  validatePackForm,
  buildPackConfig,
} from "../lib/discounts/pack-form";
import { type Plan, PLAN_LIMITS } from "../lib/billing/plan-limits";
import { getActiveCampaignCount } from "../lib/billing/plan-limits.server";
import { es } from "../i18n";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const f = parsePackForm(await request.formData());

  const errors = validatePackForm(f);
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

  // Límite de plan — solo al activar (los borradores siempre se permiten).
  //
  // ⚠️ Solo se aplica el límite GENERAL de campañas activas. La restricción por
  // TIPO (packs solo desde ESSENTIAL) es la fase 4 y todavía no existe: hoy
  // `PLAN_LIMITS` solo sabe de cantidades, no de permisos. Ver el handoff.
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
  }

  const productIds = f.catalog.map((p) => p.productId);

  // La foto del catálogo (títulos, precios, imágenes, variante) es lo que el
  // widget de la tienda va a pintar. Si esto falla, falla el guardado: una
  // campaña de pack sin catálogo que mostrar no sirve para nada.
  let items;
  try {
    items = await getPackProductSnapshots(admin, productIds);
  } catch (err) {
    return Response.json(
      { errors: { general: `No se pudieron leer los productos: ${String(err)}` } },
      { status: 500 }
    );
  }

  const config = buildPackConfig(f, items);

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      name: f.name,
      type: "PACK",
      status: shouldActivate ? "ACTIVE" : "DRAFT",
      config: config as unknown as Record<string, unknown>,
      startsAt: campaignStartsAt,
      endsAt: campaignEndsAt,
    },
  });

  if (shouldActivate) {
    try {
      await createPackDiscount(
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

  // Si algún producto del pack ya está cubierto por otra campaña activa, se
  // manda al merchant a la pantalla de edición, que es donde el aviso se ve.
  // Callárselo sería dejar que descubra en el checkout que su pack no aplica.
  const overlaps = await findPackOverlaps(shop.id, productIds, campaign.id);
  if (overlaps.length > 0) return redirect(`/app/campaigns/${campaign.id}/edit/pack`);

  return redirect("/app/campaigns");
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function NewPackCampaign() {
  const actionData = useActionData<typeof action>() as
    | { errors?: PackFormErrors; limitExceeded?: boolean }
    | undefined;
  const navigation = useNavigation();

  return (
    <s-page heading={es.nuevoPack.titulo}>
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
          name: "",
          heading: es.nuevoPack.headingPorDefecto,
          mode: "PER_PRODUCT",
          products: [],
          tiers: DEFAULT_PACK_TIERS,
          startsAt: "",
          endsAt: "",
        }}
        errors={actionData?.errors ?? {}}
        limitExceeded={actionData?.limitExceeded}
        isSubmitting={navigation.state === "submitting"}
        showDraftButton
        primaryLabel={es.nuevoPack.btnActivar}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
