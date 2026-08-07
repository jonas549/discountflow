import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, Link, useRevalidator } from "react-router";
import { useState, useEffect, Fragment } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Plus } from "lucide-react";
import { Link } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import {
  revertPercentageDiscount,
  reactivatePercentageDiscount,
} from "../lib/discounts/percentage";
import {
  deactivateBxgyDiscount,
  activateBxgyDiscount,
  deleteBxgyDiscount,
} from "../lib/discounts/bxgy";
import {
  bxgyDiscountLabel,
  type BxgyCampaignConfig,
} from "../lib/discounts/bxgy-client";
import {
  deactivateTieredDiscount,
  activateTieredDiscount,
  deleteTieredDiscount,
  updateTieredDiscount,
} from "../lib/discounts/tiered";
import {
  tieredDiscountLabel,
  tieredProductsLabel,
  type TieredCampaignConfig,
} from "../lib/discounts/tiered-client";
import {
  revertRangeDiscount,
  reactivateRangeDiscount,
  type RangeCampaignConfig,
} from "../lib/discounts/range";
import { enqueueCampaignJob, sweepStalledJobs } from "../lib/jobs/enqueue.server";
import { hasFeature } from "../lib/features.server";
import { JOBS_FEATURE_FLAG } from "../lib/jobs/constants";
import { JobProgress } from "../components/JobProgress";
import { es, estadoLabel, tipoLabel, formatDate } from "../i18n";
import { Btn, LinkBtn } from "../components/Btn";
import { PLAN_LIMITS, type Plan, getTypeCampaignLimit } from "../lib/billing/plan-limits";
import {
  getActiveCampaignCount,
  getVariantCount,
  getCampaignVariantCount,
  getActiveCampaignCountByType,
} from "../lib/billing/plan-limits.server";
import { useSearchParams } from "react-router";

const isProduction = process.env.NODE_ENV === "production";

// ─── Límites de plan al reactivar ─────────────────────────────────────────────

/**
 * Devuelve una respuesta 422 si reactivar esta campaña rompería el plan, o null
 * si puede seguir.
 *
 * Se extrajo del cuerpo del action para que la comprueben LOS DOS caminos —el
 * síncrono de siempre y el que encola un job— exactamente igual. Si cada uno
 * llevara su copia, acabarían divergiendo y el camino nuevo se convertiría en un
 * bypass del enforcement.
 */
async function comprobarLimitesAlReactivar(
  shop: { id: string; plan: string },
  campaign: { id: string; type: string }
): Promise<Response | null> {
  const plan = (shop.plan as Plan) || "FREE";

  const activeCount = await getActiveCampaignCount(shop.id);
  if (activeCount >= PLAN_LIMITS[plan].campaigns)
    return Response.json(
      {
        error: es.planes.limiteCampanas(activeCount, PLAN_LIMITS[plan].campaigns),
        limitExceeded: true,
      },
      { status: 422 }
    );

  // Límite de variantes. Solo PERCENTAGE y RANGE: son los únicos tipos que crean
  // filas en CampaignProduct (BXGY y TIERED no editan precios de variantes, así
  // que aportan 0 y quedan fuera de este check).
  //
  // La campaña está PAUSED aquí, de modo que getVariantCount —que solo cuenta
  // campañas ACTIVE— NO la incluye: hay que sumarla para saber el total con el
  // que quedaría la tienda tras reactivar.
  if (campaign.type === "PERCENTAGE" || campaign.type === "RANGE") {
    const variantsAfter =
      (await getVariantCount(shop.id)) + (await getCampaignVariantCount(campaign.id));
    if (variantsAfter > PLAN_LIMITS[plan].variants)
      return Response.json(
        {
          error: es.planes.limiteVariantes(variantsAfter, PLAN_LIMITS[plan].variants),
          limitExceeded: true,
        },
        { status: 422 }
      );
  }

  // BXGY y TIERED se topan por CANTIDAD de campañas activas de su tipo, no por
  // variantes. La campaña está PAUSED aquí, así que no se cuenta a sí misma.
  if (campaign.type === "BXGY" || campaign.type === "TIERED") {
    const typeLimit = getTypeCampaignLimit(plan, campaign.type);
    if (typeLimit !== null) {
      const activeOfType = await getActiveCampaignCountByType(
        shop.id,
        campaign.type as "BXGY" | "TIERED"
      );
      if (activeOfType >= typeLimit)
        return Response.json(
          {
            error: es.planes.limiteCampanasTipo(
              campaign.type === "BXGY" ? "BxGy" : "escalonadas",
              activeOfType,
              typeLimit
            ),
            limitExceeded: true,
          },
          { status: 422 }
        );
    }
  }

  return null;
}

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const campaignId = formData.get("campaignId") as string;
  const actionType = formData.get("actionType") as "pause" | "activate" | "delete";

  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  // ── Interruptor de la barra de progreso ───────────────────────────────────
  // Vive AQUÍ, en la pantalla donde se trabaja, y no detrás de una URL que haya
  // que adivinar. Un interruptor que no se ve es un interruptor que nadie
  // enciende: la feature entera puede quedar apagada sin que nadie lo note.
  // Nunca disponible en producción — allí el flag se mueve con un UPDATE.
  if (actionType === null && formData.get("intent") === "toggle-jobs-flag") {
    if (isProduction)
      return Response.json({ error: "No disponible en producción" }, { status: 403 });
    const current = (shop.features ?? {}) as Record<string, unknown>;
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        features: {
          ...current,
          [JOBS_FEATURE_FLAG]: !hasFeature(shop, JOBS_FEATURE_FLAG),
        } as never,
      },
    });
    return Response.json({ ok: true });
  }

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id },
  });
  if (!campaign) return Response.json({ error: "Campaña no encontrada" }, { status: 404 });

  const bxgyId = (campaign.config as BxgyCampaignConfig).shopifyDiscountId;
  // TIERED guarda su descuento automático en el mismo campo del config.
  const tieredId = (campaign.config as TieredCampaignConfig).shopifyDiscountId;

  try {
    // ── Camino con barra de progreso ──────────────────────────────────────────
    // Si el flag está encendido, la operación se encola y la respuesta vuelve en
    // milisegundos con un jobId: la UI monta la barra y el trabajo sigue en
    // segundo plano aunque el merchant cierre la pestaña.
    //
    // Si está apagado, `enqueueCampaignJob` devuelve `enqueued: false` y la
    // ejecución CAE AL CÓDIGO SÍNCRONO DE SIEMPRE, que no se ha tocado. Ese es el
    // interruptor de emergencia: un UPDATE a Shop.features y todo vuelve atrás
    // sin desplegar.
    const operacion =
      actionType === "pause" && campaign.status === "ACTIVE"
        ? "REVERT"
        : actionType === "activate" && campaign.status === "PAUSED"
        ? "REACTIVATE"
        : actionType === "delete"
        ? "DELETE"
        : null;

    if (operacion) {
      // Los límites de plan se comprueban ANTES de encolar, para que el merchant
      // reciba el aviso al instante en vez de verlo fallar dentro de una barra.
      if (operacion === "REACTIVATE") {
        const limite = await comprobarLimitesAlReactivar(shop, campaign);
        if (limite) return limite;
      }
      const enq = await enqueueCampaignJob({
        request,
        shop,
        campaignId,
        operation: operacion,
      });
      if (enq.enqueued)
        return Response.json({
          jobId: enq.jobId,
          campaignId,
          alreadyRunning: enq.alreadyRunning,
        });
    }

    if (actionType === "pause" && campaign.status === "ACTIVE") {
      if (campaign.type === "PERCENTAGE") {
        await revertPercentageDiscount(admin, campaignId);
      } else if (campaign.type === "RANGE") {
        await revertRangeDiscount(admin, campaignId);
      } else if (campaign.type === "BXGY" && bxgyId) {
        await deactivateBxgyDiscount(admin, bxgyId);
      } else if (campaign.type === "TIERED" && tieredId) {
        await deactivateTieredDiscount(admin, tieredId);
      }
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
    } else if (actionType === "activate" && campaign.status === "PAUSED") {
      const limite = await comprobarLimitesAlReactivar(shop, campaign);
      if (limite) return limite;

      if (campaign.type === "PERCENTAGE") {
        await reactivatePercentageDiscount(admin, campaignId);
      } else if (campaign.type === "RANGE") {
        await reactivateRangeDiscount(admin, campaignId);
      } else if (campaign.type === "BXGY" && bxgyId) {
        await activateBxgyDiscount(admin, bxgyId);
      } else if (campaign.type === "TIERED" && tieredId) {
        // Se REESCRIBE la configuración antes de activar, en vez de solo
        // activar el descuento existente. Dos motivos:
        //
        //  1. Migra los metafields escritos antes de que existiera el campo
        //     `scope`. Sin esto, una campaña pausada de "toda la tienda" se
        //     reactivaría con el formato viejo y la puerta de seguridad de la
        //     Function la dejaría sin descontar nada, en silencio.
        //  2. Una campaña por colección/tag pudo pasar semanas pausada: sus
        //     productos se re-resuelven para que refleje la colección de HOY,
        //     que es justo lo que el merchant espera de ese tipo de campaña.
        //
        // Si la selección ya no resuelve ningún producto, esto lanza y la
        // reactivación falla con un mensaje claro — mejor que activar una
        // campaña que no descuenta (o que descontaría de más).
        await updateTieredDiscount(
          admin,
          tieredId,
          campaignId,
          campaign.name,
          campaign.config as TieredCampaignConfig,
          campaign.startsAt,
          campaign.endsAt
        );
        await activateTieredDiscount(admin, tieredId);
      }
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });
    } else if (actionType === "delete") {
      if (campaign.status === "ACTIVE" || campaign.status === "PAUSED") {
        if (campaign.type === "PERCENTAGE") {
          await revertPercentageDiscount(admin, campaignId);
        } else if (campaign.type === "RANGE") {
          await revertRangeDiscount(admin, campaignId);
        } else if (campaign.type === "BXGY" && bxgyId) {
          try { await deleteBxgyDiscount(admin, bxgyId); } catch { /* discount may already be gone */ }
        } else if (campaign.type === "TIERED" && tieredId) {
          try { await deleteTieredDiscount(admin, tieredId); } catch { /* discount may already be gone */ }
        }
      }
      await prisma.campaign.delete({ where: { id: campaignId } });
    }
  } catch (err) {
    return Response.json({ error: `Error: ${String(err)}` }, { status: 500 });
  }

  return Response.json({ success: true });
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });
  // Segunda capa de recuperación: al entrar aquí se despiertan los jobs de esta
  // tienda que se hayan quedado colgados. La primera es el sondeo de la propia
  // barra (segundos, pero solo si hay alguien mirando) y la tercera el cron
  // diario, que es lo máximo que permite el plan Hobby de Vercel.
  await sweepStalledJobs(request, shop.id);

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { products: true } } },
  });
  const skipped = Number(new URL(request.url).searchParams.get("skipped") ?? 0);
  return {
    skipped,
    jobsFlagOn: hasFeature(shop, JOBS_FEATURE_FLAG),
    canToggleJobsFlag: !isProduction,
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      config: c.config as Record<string, unknown>,
      productsCount: c._count.products,
      startsAt: c.startsAt?.toISOString() ?? null,
      endsAt: c.endsAt?.toISOString() ?? null,
      /** jobId de la operación en curso, si la hay. Ancla de la barra. */
      activeJobId: c.activeJobId,
    })),
  };
};

// ─── Visual mockups ───────────────────────────────────────────────────────────

function MockupPorcentaje() {
  return (
    <div
      style={{
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 14px",
        marginBottom: "16px",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "10px",
          right: "10px",
          background: "#008060",
          color: "#fff",
          fontSize: "11px",
          fontWeight: "700",
          padding: "2px 7px",
          borderRadius: "12px",
        }}
      >
        -20%
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div
          style={{
            width: "36px",
            height: "36px",
            background: "#e1e3e5",
            borderRadius: "6px",
            flexShrink: 0,
          }}
        />
        <div>
          <div
            style={{
              fontSize: "12px",
              color: "#8c9196",
              textDecoration: "line-through",
              lineHeight: 1.3,
            }}
          >
            $50.00
          </div>
          <div
            style={{ fontSize: "14px", fontWeight: "700", color: "#202223", lineHeight: 1.3 }}
          >
            $40.00
          </div>
        </div>
      </div>
    </div>
  );
}

function MockupRango() {
  return (
    <div
      style={{
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 14px",
        marginBottom: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
        <span style={{ color: "#6d7175" }}>$35.00</span>
        <span style={{ color: "#8c9196", fontSize: "16px" }}>→</span>
        <span style={{ fontWeight: "700", color: "#202223" }}>$15.00</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "10px",
            background: "#fff3cd",
            color: "#8b5e00",
            padding: "2px 6px",
            borderRadius: "10px",
            fontWeight: "600",
          }}
        >
          FIJO
        </span>
      </div>
    </div>
  );
}

function MockupBxGy() {
  return (
    <div
      style={{
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 14px",
        marginBottom: "16px",
      }}
    >
      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        <div
          style={{ background: "#e1e3e5", borderRadius: "5px", width: "28px", height: "28px" }}
        />
        <div
          style={{ background: "#e1e3e5", borderRadius: "5px", width: "28px", height: "28px" }}
        />
        <span style={{ color: "#8c9196", fontSize: "12px", margin: "0 4px" }}>+</span>
        <div style={{ position: "relative" }}>
          <div
            style={{
              background: "#e8f5e9",
              border: "1px solid #a5d6a7",
              borderRadius: "5px",
              width: "28px",
              height: "28px",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "-8px",
              right: "-8px",
              background: "#4caf50",
              color: "#fff",
              fontSize: "7px",
              fontWeight: "700",
              padding: "1px 4px",
              borderRadius: "8px",
            }}
          >
            FREE
          </div>
        </div>
      </div>
    </div>
  );
}

function MockupEscalonado() {
  const niveles = [
    { uds: "1", pct: "10%" },
    { uds: "2", pct: "15%" },
    { uds: "3", pct: "20%" },
  ];
  return (
    <div
      style={{
        background: "#f8fafb",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        padding: "12px 14px",
        marginBottom: "16px",
      }}
    >
      {niveles.map((n, i) => (
        <div
          key={n.uds}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "3px 0",
            borderBottom: i < niveles.length - 1 ? "1px solid #edeef0" : "none",
          }}
        >
          <div style={{ display: "flex", gap: "3px", alignItems: "center" }}>
            {Array.from({ length: i + 1 }).map((_, k) => (
              <div
                key={k}
                style={{
                  background: "#e1e3e5",
                  borderRadius: "3px",
                  width: "14px",
                  height: "14px",
                }}
              />
            ))}
          </div>
          <span
            style={{
              background: "#e8f5e9",
              color: "#2e7d32",
              fontSize: "9px",
              fontWeight: "700",
              padding: "1px 6px",
              borderRadius: "8px",
            }}
          >
            {n.pct}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Campaign type card ───────────────────────────────────────────────────────

type CampaignCardProps = {
  mockup: React.ReactNode;
  title: string;
  description: string;
  ejemplo: string;
  href?: string;
  disabled?: boolean;
};

function CampaignCard({
  mockup,
  title,
  description,
  ejemplo,
  href,
  disabled = false,
}: CampaignCardProps) {
  return (
    <div
      style={{
        background: disabled ? "#fafafa" : "#ffffff",
        border: "1.5px solid",
        borderColor: disabled ? "#e1e3e5" : "#c9cccf",
        borderRadius: "12px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        opacity: disabled ? 0.75 : 1,
        cursor: disabled ? "not-allowed" : "default",
        flex: "1 1 260px",
        minWidth: "260px",
        maxWidth: "340px",
        position: "relative",
      }}
    >
      {disabled && (
        <div
          style={{
            position: "absolute",
            top: "14px",
            right: "14px",
            background: "#e4e5e7",
            color: "#6d7175",
            fontSize: "10px",
            fontWeight: "700",
            padding: "2px 8px",
            borderRadius: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {es.campanas.proximamente}
        </div>
      )}
      {mockup}
      <div
        style={{ fontSize: "15px", fontWeight: "600", color: "#202223", marginBottom: "6px" }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: "13px",
          color: "#6d7175",
          lineHeight: "1.5",
          marginBottom: "10px",
          flexGrow: 1,
        }}
      >
        {description}
      </div>
      <div
        style={{
          fontSize: "12px",
          color: "#8c9196",
          marginBottom: "16px",
          background: "#f8fafb",
          padding: "6px 10px",
          borderRadius: "6px",
        }}
      >
        💡 {ejemplo}
      </div>
      <div>
        {disabled ? (
          <Btn variant="muted" size="sm" disabled>
            {es.campanas.crear}
          </Btn>
        ) : (
          <LinkBtn to={href ?? "/app/campaigns"} variant="primary" size="sm">
            <Plus size={14} />
            {es.campanas.crear}
          </LinkBtn>
        )}
      </div>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const ESTADO_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE: { bg: "#d3f5e2", text: "#007a5a" },
  DRAFT: { bg: "#e4e5e7", text: "#505050" },
  PAUSED: { bg: "#fff3cd", text: "#8b5e00" },
  COMPLETED: { bg: "#e8e0fc", text: "#4d2db8" },
  CANCELLED: { bg: "#fde8e8", text: "#c0392b" },
};

// ─── Delete confirmation modal ────────────────────────────────────────────────

function DeleteModal({
  campaignName,
  onConfirm,
  onCancel,
}: {
  campaignName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.48)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          padding: "24px 28px",
          maxWidth: "480px",
          width: "100%",
          boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{
            fontSize: "16px",
            fontWeight: "600",
            color: "#202223",
            margin: "0 0 10px",
          }}
        >
          {es.campanas.acciones.modalTitulo}
        </h3>
        <p
          style={{
            fontSize: "14px",
            color: "#6d7175",
            lineHeight: "1.55",
            margin: "0 0 24px",
          }}
        >
          {es.campanas.acciones.modalTexto}
          {campaignName && (
            <strong style={{ color: "#202223" }}> "{campaignName}"</strong>
          )}
          {". "}
          {es.campanas.acciones.modalAdvertencia}
        </p>
        <div
          style={{
            display: "flex",
            gap: "10px",
            justifyContent: "flex-end",
          }}
        >
          <Btn variant="secondary" size="md" onClick={onCancel}>
            {es.campanas.acciones.cancelar}
          </Btn>
          <Btn variant="destructive" size="md" onClick={onConfirm}>
            {es.campanas.acciones.siEliminar}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Campaigns() {
  const { campaigns, skipped, jobsFlagOn, canToggleJobsFlag } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher();

  // skipped from URL param (set after activating a range campaign)
  const skippedCount = skipped || Number(searchParams.get("skipped") ?? 0);

  // Track which campaign is pending deletion (null = modal closed)
  const [deleteCandidate, setDeleteCandidate] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Track which specific action is in-flight to show per-button loading state
  const [pendingAction, setPendingAction] = useState<{
    id: string;
    type: "pause" | "activate" | "delete";
  } | null>(null);

  const revalidator = useRevalidator();

  // Jobs recién lanzados en ESTA pantalla. El loader ya trae `activeJobId` de
  // cada campaña, pero al volver del action todavía no se ha revalidado: sin
  // esto la barra tardaría un ciclo en aparecer y el merchant vería un hueco.
  const [startedJobs, setStartedJobs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (fetcher.state === "idle") setPendingAction(null);
  }, [fetcher.state]);

  useEffect(() => {
    const data = fetcher.data as { jobId?: string; campaignId?: string } | undefined;
    if (data?.jobId && data.campaignId)
      setStartedJobs((prev) => ({ ...prev, [data.campaignId!]: data.jobId! }));
  }, [fetcher.data]);

  const jobIdFor = (c: { id: string; activeJobId: string | null }) =>
    startedJobs[c.id] ?? c.activeJobId ?? null;

  const onJobFinished = (campaignId: string) => {
    setStartedJobs((prev) => {
      const next = { ...prev };
      delete next[campaignId];
      return next;
    });
    revalidator.revalidate();
  };

  const submitAction = (campaignId: string, actionType: "pause" | "activate" | "delete") => {
    setPendingAction({ id: campaignId, type: actionType });
    const fd = new FormData();
    fd.append("campaignId", campaignId);
    fd.append("actionType", actionType);
    fetcher.submit(fd, { method: "post" });
  };

  const handleDeleteConfirm = () => {
    if (!deleteCandidate) return;
    submitAction(deleteCandidate.id, "delete");
    setDeleteCandidate(null);
  };

  const isBusy = fetcher.state !== "idle";

  const fetcherData = fetcher.data as { error?: string; limitExceeded?: boolean } | undefined;

  return (
    <s-page heading={es.campanas.titulo}>
      {/* Interruptor de la barra de progreso — solo fuera de producción.
          Visible aquí a propósito: escondido detrás de una URL, nadie lo enciende
          y la feature entera queda muerta sin que se note. */}
      {canToggleJobsFlag && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            background: jobsFlagOn ? "#f1f8f5" : "#fff8e1",
            border: `1px solid ${jobsFlagOn ? "#008060" : "#f9a825"}`,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <span style={{ color: "#42474c" }}>
            <strong>Barra de progreso por lotes:</strong>{" "}
            <strong style={{ color: jobsFlagOn ? "#007a5a" : "#a05c00" }}>
              {jobsFlagOn ? "ENCENDIDA" : "APAGADA"}
            </strong>
            {jobsFlagOn
              ? " — crear, activar, pausar y eliminar devuelven al instante y muestran progreso."
              : " — las operaciones corren en bloque y la pantalla se queda esperando (comportamiento anterior)."}
          </span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <fetcher.Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value="toggle-jobs-flag" />
              {/* type="submit" explícito: Btn usa type="button" por defecto y
                  dentro de un form no enviaría nada. */}
              <Btn
                type="submit"
                variant={jobsFlagOn ? "muted" : "primary"}
                size="sm"
                disabled={isBusy}
              >
                {jobsFlagOn ? "Apagar" : "Encender"}
              </Btn>
            </fetcher.Form>
            <Link to="/app/jobs-demo" style={{ fontSize: 12, color: "#008060" }}>
              Banco de pruebas
            </Link>
          </span>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteCandidate && (
        <DeleteModal
          campaignName={deleteCandidate.name}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteCandidate(null)}
        />
      )}

      {/* Banner de límite de plan */}
      {fetcherData?.limitExceeded && fetcherData.error && (
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #f9a825",
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "14px",
            color: "#a05c00",
            marginBottom: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <span>{fetcherData.error}</span>
          <Link
            to="/app/plans"
            style={{ fontSize: "13px", fontWeight: "600", color: "#008060", textDecoration: "none", whiteSpace: "nowrap" }}
          >
            {es.planes.verPlanes} →
          </Link>
        </div>
      )}

      {/* Banner de productos saltados (rango de precio) */}
      {skippedCount > 0 && (
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #ffe082",
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "14px",
            color: "#8b5e00",
            marginBottom: "16px",
          }}
        >
          {es.nuevaRango.skippedBanner(skippedCount)}
        </div>
      )}

      {/* Campaign type picker */}
      <s-section heading={es.campanas.crearSeccion}>
        <p style={{ fontSize: "14px", color: "#6d7175", marginBottom: "20px" }}>
          {es.campanas.subtitulo}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
          <CampaignCard
            mockup={<MockupPorcentaje />}
            title={es.campanas.porcentaje.titulo}
            description={es.campanas.porcentaje.descripcion}
            ejemplo={es.campanas.porcentaje.ejemplo}
            href="/app/campaigns/new/percentage"
          />
          <CampaignCard
            mockup={<MockupRango />}
            title={es.campanas.rango.titulo}
            description={es.campanas.rango.descripcion}
            ejemplo={es.campanas.rango.ejemplo}
            href="/app/campaigns/new/range"
          />
          <CampaignCard
            mockup={<MockupBxGy />}
            title={es.campanas.bxgy.titulo}
            description={es.campanas.bxgy.descripcion}
            ejemplo={es.campanas.bxgy.ejemplo}
            href="/app/campaigns/new/bxgy"
          />
          <CampaignCard
            mockup={<MockupEscalonado />}
            title={es.campanas.escalonado.titulo}
            description={es.campanas.escalonado.descripcion}
            ejemplo={es.campanas.escalonado.ejemplo}
            href="/app/campaigns/new/tiered"
          />
        </div>
      </s-section>

      {/* Campaigns list */}
      <s-section heading={es.campanas.tusCampanas}>
        {campaigns.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "40px 0",
              color: "#6d7175",
              fontSize: "14px",
            }}
          >
            {es.campanas.sinCampanas}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}
            >
              <thead>
                <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                  {[
                    es.campanas.tabla.nombre,
                    es.campanas.tabla.tipo,
                    es.campanas.tabla.estado,
                    es.campanas.tabla.descuento,
                    es.campanas.tabla.productos,
                    es.campanas.tabla.inicio,
                    es.campanas.tabla.fin,
                    es.campanas.tabla.acciones,
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "10px 12px",
                        textAlign: "left",
                        color: "#6d7175",
                        fontWeight: "500",
                        fontSize: "12px",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const st = ESTADO_COLORS[c.status] ?? ESTADO_COLORS.DRAFT;
                  const rangeConfig = c.config as RangeCampaignConfig;
                  const discount =
                    c.type === "PERCENTAGE"
                      ? `${(c.config as { discountPercent?: number }).discountPercent ?? "—"}%`
                      : c.type === "BXGY"
                      ? bxgyDiscountLabel(c.config as BxgyCampaignConfig)
                      : c.type === "RANGE"
                      ? rangeConfig.mode === "fixedPrice"
                        ? `Precio fijo $${rangeConfig.value}`
                        : `$${rangeConfig.value} de descuento`
                      : c.type === "TIERED"
                      ? tieredDiscountLabel(c.config as TieredCampaignConfig)
                      : "—";
                  const editHref =
                    c.type === "BXGY"
                      ? `/app/campaigns/${c.id}/edit/bxgy`
                      : c.type === "RANGE"
                      ? `/app/campaigns/${c.id}/edit/range`
                      : c.type === "TIERED"
                      ? `/app/campaigns/${c.id}/edit/tiered`
                      : `/app/campaigns/${c.id}/edit`;
                  const jobId = jobIdFor(c);
                  return (
                    <Fragment key={c.id}>
                    <tr style={{ borderBottom: jobId ? "none" : "1px solid #f1f2f3" }}>
                      <td style={{ padding: "12px", fontWeight: "500", color: "#202223" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          {c.name}
                          {c.type === "BXGY" && (
                            <span
                              title={es.nuevaBxgy.tooltipGestionado}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "16px",
                                height: "16px",
                                borderRadius: "50%",
                                background: "#e1e3e5",
                                color: "#6d7175",
                                fontSize: "10px",
                                fontWeight: "700",
                                cursor: "help",
                                flexShrink: 0,
                              }}
                            >
                              i
                            </span>
                          )}
                        </span>
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {tipoLabel(c.type)}
                      </td>
                      <td style={{ padding: "12px" }}>
                        <span
                          style={{
                            background: st.bg,
                            color: st.text,
                            padding: "2px 9px",
                            borderRadius: "20px",
                            fontSize: "12px",
                            fontWeight: "500",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {estadoLabel(c.status)}
                        </span>
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>{discount}</td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {/* TIERED no crea filas en CampaignProduct: su conteo
                            sale del config. El resto de tipos no se toca. */}
                        {c.type === "TIERED"
                          ? tieredProductsLabel(c.config as TieredCampaignConfig)
                          : c.productsCount}
                      </td>
                      <td
                        style={{
                          padding: "12px",
                          color: "#6d7175",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatDate(c.startsAt)}
                      </td>
                      <td
                        style={{
                          padding: "12px",
                          color: "#6d7175",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatDate(c.endsAt)}
                      </td>

                      {/* ── Acciones inline — sin dropdown ── */}
                      <td style={{ padding: "12px" }}>
                        <div
                          style={{ display: "flex", gap: "8px", alignItems: "center" }}
                        >
                          {/* Editar — ruta difiere por tipo.
                              Con un job en curso se bloquea: la fase de
                              resolución ya fijó la lista de productos, y cambiar
                              la selección por debajo corrompería el trabajo. */}
                          {jobId ? (
                            <Btn variant="muted" size="sm" disabled>
                              {es.campanas.acciones.editar}
                            </Btn>
                          ) : (
                            <LinkBtn to={editHref} variant="primary" size="sm">
                              {es.campanas.acciones.editar}
                            </LinkBtn>
                          )}

                          {/* Pausar — solo cuando ACTIVE */}
                          {c.status === "ACTIVE" && (
                            <Btn
                              variant="muted"
                              size="sm"
                              disabled={isBusy || !!jobId}
                              onClick={() => submitAction(c.id, "pause")}
                            >
                              {pendingAction?.id === c.id && pendingAction.type === "pause"
                                ? "Pausando…"
                                : es.campanas.acciones.pausar}
                            </Btn>
                          )}

                          {/* Reactivar — solo cuando PAUSED */}
                          {c.status === "PAUSED" && (
                            <Btn
                              variant="primary"
                              size="sm"
                              disabled={isBusy || !!jobId}
                              onClick={() => submitAction(c.id, "activate")}
                            >
                              {pendingAction?.id === c.id && pendingAction.type === "activate"
                                ? "Activando…"
                                : es.campanas.acciones.reactivar}
                            </Btn>
                          )}

                          {/* Eliminar — siempre visible, abre modal */}
                          <Btn
                            variant="destructive"
                            size="sm"
                            disabled={isBusy || !!jobId}
                            onClick={() =>
                              setDeleteCandidate({ id: c.id, name: c.name })
                            }
                          >
                            {pendingAction?.id === c.id && pendingAction.type === "delete"
                              ? "Eliminando…"
                              : es.campanas.acciones.eliminar}
                          </Btn>
                        </div>
                      </td>
                    </tr>

                    {/* Barra de progreso de la operación en curso */}
                    {jobId && (
                      <tr style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td colSpan={8} style={{ padding: "0 12px 14px" }}>
                          <JobProgress
                            jobId={jobId}
                            onFinished={() => onJobFinished(c.id)}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
