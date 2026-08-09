// Banco de pruebas manual de la barra de progreso (solo NOOP).
//
// Vive aparte a propósito: D1 no toca NI UNA de las pantallas existentes. El
// listado de campañas, las pantallas de edición y el shell quedan exactamente como
// estaban, así que esta entrega no puede romper nada que hoy funcione. El cableado
// de la barra en el listado llega en D2, cuando existan operaciones reales.
//
// Las campañas que crea van en estado DRAFT y llevan el prefijo [NOOP demo], y hay
// un botón para borrarlas: los borradores no cuentan para los límites del plan
// (getActiveCampaignCount solo mira ACTIVE), así que no ensucian ninguna cuota.

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { hasFeature } from "../lib/features.server";
import { JOBS_FEATURE_FLAG, DEADLINE_MS, CONCURRENCY } from "../lib/jobs/constants";
import { createJob, findStalledJobs } from "../lib/jobs/jobs.server";
import { dispatchNextBatch } from "../lib/jobs/chain.server";
import { JobProgress } from "../components/JobProgress";

const DEMO_PREFIX = "[NOOP demo]";
const isProduction = process.env.NODE_ENV === "production";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Banco de pruebas: inalcanzable en producción. 404 = como si la ruta no existiera,
  // ni GET (esta página) ni POST (el action de abajo).
  if (isProduction) throw new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const demoCampaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id, name: { startsWith: DEMO_PREFIX } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, name: true, activeJobId: true, _count: { select: { products: true } } },
  });

  const jobs = await prisma.campaignJob.findMany({
    where: { shopId: shop.id, operation: "NOOP" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const stalled = await findStalledJobs({ shopId: shop.id, limit: 5 });

  return {
    flagOn: hasFeature(shop, JOBS_FEATURE_FLAG),
    canToggleFlag: !isProduction,
    deadlineMs: DEADLINE_MS,
    concurrency: CONCURRENCY,
    demoCampaigns,
    stalledCount: stalled.length,
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status as string,
      processedProducts: j.processedProducts,
      totalProducts: j.totalProducts,
      attempts: j.attempts,
      createdAt: j.createdAt,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (isProduction) throw new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop({
    domain: session.shop,
    accessToken: session.accessToken,
    scopes: session.scope,
  });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── Interruptor del flag (nunca en producción) ────────────────────────────
  if (intent === "flag-on" || intent === "flag-off") {
    if (isProduction)
      return Response.json({ error: "No disponible en producción" }, { status: 403 });
    const current = (shop.features ?? {}) as Record<string, unknown>;
    const next = { ...current, [JOBS_FEATURE_FLAG]: intent === "flag-on" };
    await prisma.shop.update({
      where: { id: shop.id },
      data: { features: next as never },
    });
    return Response.json({ ok: true });
  }

  if (intent === "cleanup") {
    // Borrado ACOTADO: solo campañas de esta tienda y con el prefijo de demo.
    // El borrado en cascada se lleva sus CampaignProduct y sus CampaignJob.
    const res = await prisma.campaign.deleteMany({
      where: { shopId: shop.id, name: { startsWith: DEMO_PREFIX } },
    });
    return Response.json({ ok: true, deleted: res.count });
  }

  if (intent === "start") {
    // 🔒 La puerta del flag. Fail-closed: si está apagado, no se crea nada.
    if (!hasFeature(shop, JOBS_FEATURE_FLAG))
      return Response.json(
        { error: `El flag ${JOBS_FEATURE_FLAG} está apagado para esta tienda.` },
        { status: 403 }
      );

    const totalUnits = Math.min(50_000, Math.max(1, Number(form.get("totalUnits") ?? 200)));
    const msPerUnit = Math.min(2_000, Math.max(0, Number(form.get("msPerUnit") ?? 20)));
    const variantsPerUnit = Math.min(50, Math.max(1, Number(form.get("variantsPerUnit") ?? 1)));

    const campaign = await prisma.campaign.create({
      data: {
        shopId: shop.id,
        name: `${DEMO_PREFIX} ${totalUnits} unidades · ${new Date().toISOString().slice(11, 19)}`,
        type: "PERCENTAGE",
        status: "DRAFT",
        config: { demo: true, discountPercent: 0 },
      },
    });

    const { job } = await createJob({
      campaignId: campaign.id,
      shopId: shop.id,
      operation: "NOOP",
      payload: { totalUnits, msPerUnit, variantsPerUnit, resolveChunk: 1_000 },
    });

    await dispatchNextBatch(request, job.id);
    return Response.json({ ok: true, jobId: job.id });
  }

  return Response.json({ error: "intent no reconocido" }, { status: 400 });
};

export default function JobsDemo() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ jobId?: string; error?: string; deleted?: number }>();
  const revalidator = useRevalidator();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.data?.jobId) setActiveJobId(fetcher.data.jobId);
  }, [fetcher.data]);

  const running = data.jobs.find(
    (j) => !["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELLED"].includes(j.status)
  );
  const shownJobId = activeJobId ?? running?.id ?? null;

  return (
    <s-page heading="Banco de pruebas · barra de progreso">
      <s-section heading="Estado del sistema">
        <div style={{ display: "grid", gap: 8, fontSize: 14 }}>
          <Row label="Flag jobs:batched">
            <strong style={{ color: data.flagOn ? "#007a5a" : "#c0392b" }}>
              {data.flagOn ? "ENCENDIDO" : "APAGADO (fail-closed)"}
            </strong>
            {data.canToggleFlag && (
              <fetcher.Form method="post" style={{ display: "inline", marginLeft: 12 }}>
                <input type="hidden" name="intent" value={data.flagOn ? "flag-off" : "flag-on"} />
                <button type="submit" style={btnSmall}>
                  {data.flagOn ? "Apagar" : "Encender"}
                </button>
              </fetcher.Form>
            )}
          </Row>
          <Row label="Plazo por invocación">{(data.deadlineMs / 1000).toFixed(0)} s</Row>
          <Row label="Concurrencia">{data.concurrency}</Row>
          <Row label="Jobs colgados ahora">{data.stalledCount}</Row>
        </div>
      </s-section>

      <s-section heading="Lanzar un job NOOP">
        <p style={{ fontSize: 13, color: "#6d7175", marginTop: 0 }}>
          NOOP no toca Shopify: solo crea filas de trabajo y las va sellando. Recorre
          el mismo camino que recorrerán las operaciones reales, así que sirve para
          ver la barra de verdad sin poder tocar ningún precio.
        </p>
        <fetcher.Form method="post" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="start" />
          <Field name="totalUnits" label="Unidades" defaultValue="200" />
          <Field name="msPerUnit" label="ms por unidad" defaultValue="20" />
          <Field name="variantsPerUnit" label="Variantes por unidad" defaultValue="1" />
          <button type="submit" style={btnPrimary} disabled={!data.flagOn}>
            Lanzar
          </button>
        </fetcher.Form>
        {fetcher.data?.error && (
          <p style={{ color: "#c0392b", fontSize: 13 }}>{fetcher.data.error}</p>
        )}
      </s-section>

      {shownJobId && (
        <s-section heading="Progreso">
          <JobProgress
            jobId={shownJobId}
            onFinished={() => revalidator.revalidate()}
          />
        </s-section>
      )}

      <s-section heading="Limpieza">
        <p style={{ fontSize: 13, color: "#6d7175", marginTop: 0 }}>
          {data.demoCampaigns.length} campaña(s) de demo. Se borran en cascada con
          sus filas de trabajo y sus jobs.
        </p>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="cleanup" />
          <button type="submit" style={btnSmall}>Borrar campañas de demo</button>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <span style={{ color: "#6d7175", minWidth: 190 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Field({ name, label, defaultValue }: { name: string; label: string; defaultValue: string }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6d7175" }}>
      {label}
      <input
        name={name}
        defaultValue={defaultValue}
        inputMode="numeric"
        style={{
          border: "1px solid #c9cccf",
          borderRadius: 6,
          padding: "7px 10px",
          fontSize: 14,
          width: 130,
        }}
      />
    </label>
  );
}

const btnPrimary: React.CSSProperties = {
  background: "#008060",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "9px 20px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const btnSmall: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #c9cccf",
  borderRadius: 6,
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
