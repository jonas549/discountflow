// ─────────────────────────────────────────────────────────────────────────────
// Panel INTERNO de mantenimiento — pausa campañas que exceden el límite de
// variantes del plan de su tienda.
//
// NO está enlazado desde ninguna parte de la UI y exige CRON_SECRET.
//
//   GET  → página HTML con la lista de campañas que exceden y un botón por
//          campaña. No toca nada.
//   POST → ejecuta el pausado de UNA campaña concreta (la del botón pulsado).
//
// ORDEN NO NEGOCIABLE por campaña:
//   1º revertir precios en Shopify
//   2º marcar PAUSED **solo si el revert volvió sin errores**
// Al revés, un corte a mitad dejaría la campaña "pausada" con los descuentos
// vivos en la tienda y nadie volvería a revertirlos: el flujo de pausa de la UI
// ya se habría consumido.
//
// Alcance: PERCENTAGE y RANGE. BXGY y TIERED no crean filas en CampaignProduct
// (no editan precios de variantes), así que no participan de este límite.
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { prisma } from "../lib/db";
import { unauthenticated } from "../shopify.server";
import { PLAN_LIMITS, type Plan } from "../lib/billing/plan-limits";
import { revertPercentageDiscount } from "../lib/discounts/percentage";
import { revertRangeDiscount } from "../lib/discounts/range";

type CampaignPlan = {
  campaignId: string;
  name: string;
  type: "PERCENTAGE" | "RANGE";
  variants: number;
  products: number;
};

type ShopPlan = {
  domain: string;
  plan: Plan;
  limit: number;
  variantsActive: number;
  toPause: CampaignPlan[];
};

/** CRON_SECRET por cabecera, query param o campo del formulario. */
function readSecret(request: Request, formSecret?: string | null): boolean {
  // eslint-disable-next-line no-undef
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  if (request.headers.get("authorization") === `Bearer ${secret}`) return true;
  if (new URL(request.url).searchParams.get("secret") === secret) return true;
  return formSecret === secret;
}

/**
 * Calcula, sin tocar nada, qué campañas habría que pausar en cada tienda.
 *
 * Regla: si el total de variantes activas supera el límite del plan, se marcan
 * las campañas MÁS GRANDES primero hasta volver a estar dentro. Determinista y
 * explicable; con una sola campaña que excede se reduce a esa.
 */
async function buildPlan(shopFilter: string | null): Promise<ShopPlan[]> {
  const shops = await prisma.shop.findMany({
    where: shopFilter ? { domain: shopFilter } : undefined,
    select: { id: true, domain: true, plan: true },
  });

  const result: ShopPlan[] = [];

  for (const shop of shops) {
    const plan = ((shop.plan as Plan) in PLAN_LIMITS ? (shop.plan as Plan) : "FREE") as Plan;
    const limit = PLAN_LIMITS[plan].variants;

    const campaigns = await prisma.campaign.findMany({
      where: {
        shopId: shop.id,
        status: "ACTIVE",
        type: { in: ["PERCENTAGE", "RANGE"] },
      },
      select: { id: true, name: true, type: true },
    });

    const withCounts: CampaignPlan[] = [];
    for (const c of campaigns) {
      const [variants, productRows] = await Promise.all([
        prisma.campaignProduct.count({ where: { campaignId: c.id } }),
        prisma.campaignProduct.groupBy({
          by: ["shopifyProductId"],
          where: { campaignId: c.id },
        }),
      ]);
      withCounts.push({
        campaignId: c.id,
        name: c.name,
        type: c.type as "PERCENTAGE" | "RANGE",
        variants,
        products: productRows.length,
      });
    }

    const variantsActive = withCounts.reduce((sum, c) => sum + c.variants, 0);
    if (variantsActive <= limit) continue;

    const ordered = [...withCounts].sort((a, b) => b.variants - a.variants);
    const toPause: CampaignPlan[] = [];
    let remaining = variantsActive;
    for (const c of ordered) {
      if (remaining <= limit) break;
      toPause.push(c);
      remaining -= c.variants;
    }

    result.push({ domain: shop.domain, plan, limit, variantsActive, toPause });
  }

  return result;
}

// ─── GET — la página ──────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!readSecret(request))
    return Response.json({ authorized: false, plan: [] as ShopPlan[] }, { status: 401 });

  const shopFilter = new URL(request.url).searchParams.get("shop");
  return { authorized: true, plan: await buildPlan(shopFilter) };
};

// ─── POST — pausar UNA campaña ────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const formSecret = formData.get("secret") as string | null;

  if (!readSecret(request, formSecret))
    return Response.json({ ok: false, motivo: "No autorizado" }, { status: 401 });

  const campaignId = formData.get("campaignId") as string | null;
  if (!campaignId)
    return Response.json({ ok: false, motivo: "Falta campaignId" }, { status: 400 });

  // Solo se puede pausar una campaña que EFECTIVAMENTE excede ahora mismo.
  // Se recalcula en el servidor: el formulario no decide nada por su cuenta.
  const plan = await buildPlan(null);
  const shopPlan = plan.find((s) => s.toPause.some((c) => c.campaignId === campaignId));
  const target = shopPlan?.toPause.find((c) => c.campaignId === campaignId);

  if (!shopPlan || !target)
    return Response.json(
      {
        ok: false,
        campaignId,
        motivo:
          "Esa campaña ya no figura como excedida (¿la pausaron ya, o cambió el plan?). No se ha tocado nada.",
      },
      { status: 409 }
    );

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shopPlan.domain));
  } catch (err) {
    return Response.json({
      ok: false,
      campaignId,
      name: target.name,
      motivo: `No se pudo obtener sesión admin de ${shopPlan.domain} (¿token caducado? ¿app desinstalada?): ${String(err)}`,
    });
  }

  try {
    // 1º REVERTIR
    const { reverted, errors } =
      target.type === "PERCENTAGE"
        ? await revertPercentageDiscount(admin, campaignId)
        : await revertRangeDiscount(admin, campaignId);

    if (errors.length > 0)
      return Response.json({
        ok: false,
        campaignId,
        name: target.name,
        revertidas: reverted,
        motivo: "El revert devolvió errores — NO se marca PAUSED. Se puede reintentar.",
        errors,
      });

    // 2º PAUSAR (solo si el revert fue limpio)
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "PAUSED" },
    });

    return Response.json({
      ok: true,
      campaignId,
      name: target.name,
      domain: shopPlan.domain,
      revertidas: reverted,
      variantes: target.variants,
      limite: shopPlan.limit,
    });
  } catch (err) {
    return Response.json({
      ok: false,
      campaignId,
      name: target.name,
      motivo: `Excepción durante el revert — NO se marca PAUSED. Se puede reintentar: ${String(err)}`,
    });
  }
};

// ─── UI ───────────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  border: "1px solid #e1e3e5",
  borderRadius: "10px",
  background: "#fff",
  padding: "18px",
  marginBottom: "16px",
};

export default function PauseOverLimitPanel() {
  const { authorized, plan } = useLoaderData<typeof loader>() as {
    authorized: boolean;
    plan: ShopPlan[];
  };
  const result = useActionData<typeof action>() as
    | { ok: boolean; name?: string; motivo?: string; revertidas?: number; errors?: string[] }
    | undefined;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const secret = searchParams.get("secret") ?? "";
  const enviando = navigation.state === "submitting";

  if (!authorized)
    return (
      <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: "40px", maxWidth: "720px", margin: "0 auto" }}>
        <div style={{ ...card, background: "#fde8e8", borderColor: "#f97066", color: "#c0392b" }}>
          <strong>No autorizado.</strong> Falta el <code>?secret=</code> correcto en la URL.
        </div>
      </main>
    );

  const totalCampanas = plan.reduce((n, s) => n + s.toPause.length, 0);

  return (
    <main
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        padding: "40px 24px",
        maxWidth: "860px",
        margin: "0 auto",
        color: "#202223",
      }}
    >
      <h1 style={{ fontSize: "22px", marginBottom: "4px" }}>
        Mantenimiento — campañas que exceden el límite de variantes
      </h1>
      <p style={{ color: "#6d7175", fontSize: "14px", marginTop: 0, marginBottom: "24px" }}>
        Herramienta interna. Pausar una campaña <strong>revierte los precios en Shopify</strong> y
        la deja en estado PAUSED.
      </p>

      {result && (
        <div
          style={{
            ...card,
            background: result.ok ? "#e3f5e9" : "#fde8e8",
            borderColor: result.ok ? "#008060" : "#f97066",
            color: result.ok ? "#0b5b3f" : "#c0392b",
          }}
        >
          {result.ok ? (
            <>
              <strong>Pausada ✅</strong> — «{result.name}». Se revirtieron{" "}
              {result.revertidas} variantes a su precio original.
            </>
          ) : (
            <>
              <strong>No se pudo pausar ❌</strong>
              {result.name ? ` — «${result.name}»` : ""}
              <div style={{ marginTop: "8px", fontSize: "13px" }}>{result.motivo}</div>
              {result.errors?.length ? (
                <ul style={{ marginTop: "8px", fontSize: "12px" }}>
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      )}

      {totalCampanas === 0 ? (
        <div style={{ ...card, background: "#f6f6f7" }}>
          <strong>Nada que pausar.</strong> Ninguna tienda excede su límite de variantes.
        </div>
      ) : (
        plan.map((shop) => (
          <div key={shop.domain} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "8px" }}>
              <strong style={{ fontSize: "15px" }}>{shop.domain}</strong>
              <span style={{ fontSize: "13px", color: "#6d7175" }}>
                plan <strong>{shop.plan}</strong> · límite {shop.limit.toLocaleString("en-US")} variantes
              </span>
            </div>
            <div
              style={{
                marginTop: "6px",
                fontSize: "13px",
                color: "#a05c00",
                background: "#fff8e1",
                border: "1px solid #f9a825",
                borderRadius: "6px",
                padding: "6px 10px",
                display: "inline-block",
              }}
            >
              {shop.variantsActive.toLocaleString("en-US")} variantes activas — excede en{" "}
              {(shop.variantsActive - shop.limit).toLocaleString("en-US")}
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "14px", fontSize: "14px" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6d7175", fontSize: "12px" }}>
                  <th style={{ padding: "6px 8px 6px 0" }}>Campaña</th>
                  <th style={{ padding: "6px 8px" }}>Tipo</th>
                  <th style={{ padding: "6px 8px" }}>Variantes</th>
                  <th style={{ padding: "6px 8px" }}>Productos</th>
                  <th style={{ padding: "6px 0 6px 8px" }}></th>
                </tr>
              </thead>
              <tbody>
                {shop.toPause.map((c) => (
                  <tr key={c.campaignId} style={{ borderTop: "1px solid #f1f2f3" }}>
                    <td style={{ padding: "10px 8px 10px 0", fontWeight: 600 }}>{c.name}</td>
                    <td style={{ padding: "10px 8px", color: "#6d7175" }}>{c.type}</td>
                    <td style={{ padding: "10px 8px" }}>{c.variants.toLocaleString("en-US")}</td>
                    <td style={{ padding: "10px 8px", color: "#6d7175" }}>{c.products}</td>
                    <td style={{ padding: "10px 0 10px 8px", textAlign: "right" }}>
                      <Form
                        method="post"
                        onSubmit={(e) => {
                          const ok = window.confirm(
                            `¿Seguro?\n\nEsto revierte los precios de ${c.variants} variantes ` +
                              `(${c.products} productos) en ${shop.domain} y pausa la campaña «${c.name}».\n\n` +
                              `La acción es reversible desde la app, pero los precios volverán a su valor original de inmediato.`
                          );
                          if (!ok) e.preventDefault();
                        }}
                      >
                        <input type="hidden" name="campaignId" value={c.campaignId} />
                        <input type="hidden" name="secret" value={secret} />
                        <button
                          type="submit"
                          disabled={enviando}
                          style={{
                            background: enviando ? "#b98c8c" : "#d82c0d",
                            color: "#fff",
                            border: "none",
                            borderRadius: "6px",
                            padding: "8px 14px",
                            fontSize: "13px",
                            fontWeight: 600,
                            cursor: enviando ? "wait" : "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {enviando ? "Pausando…" : "Pausar campaña"}
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      <p style={{ color: "#8c9196", fontSize: "12px", marginTop: "24px" }}>
        Al pausar: primero se revierten los precios en Shopify y solo si eso termina sin errores se
        marca la campaña como PAUSED. Si algo falla, la campaña se queda ACTIVE y puedes reintentar.
      </p>
    </main>
  );
}
