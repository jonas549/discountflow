import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, Link, useRevalidator } from "react-router";
import { useState, useEffect, Fragment } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Plus } from "lucide-react";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/db";
import { getOrCreateShop } from "../lib/shopify/shop.server";
import { sincronizarMetafieldDeWidget } from "../lib/discounts/pack-widget-metafield.server";
import {
  createCartValueDiscount,
  updateCartValueDiscount,
  activateCartValueDiscount,
  deactivateCartValueDiscount,
  deleteCartValueDiscount,
} from "../lib/discounts/cart-value";
import {
  cartValueLabel,
  type CartValueCampaignConfig,
} from "../lib/discounts/cart-value-client";
import {
  createOriginalPriceDiscount,
  updateOriginalPriceDiscount,
  activateOriginalPriceDiscount,
  deactivateOriginalPriceDiscount,
  deleteOriginalPriceDiscount,
} from "../lib/discounts/original-price";
import {
  originalPriceLabel,
  type OriginalPriceCampaignConfig,
} from "../lib/discounts/original-price-client";
import {
  revertPercentageDiscount,
  reactivatePercentageDiscount,
} from "../lib/discounts/percentage";
import {
  createBxgyDiscount,
  deactivateBxgyDiscount,
  activateBxgyDiscount,
  deleteBxgyDiscount,
} from "../lib/discounts/bxgy";
import {
  bxgyDiscountLabel,
  type BxgyCampaignConfig,
} from "../lib/discounts/bxgy-client";
import {
  createTieredDiscount,
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
  createPackDiscount,
  updatePackDiscount,
  activatePackDiscount,
  deactivatePackDiscount,
  deletePackDiscount,
} from "../lib/discounts/pack";
import {
  packDiscountLabel,
  packProductsLabel,
  type PackCampaignConfig,
} from "../lib/discounts/pack-client";
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
import { PLAN_LIMITS, type Plan } from "../lib/billing/plan-limits";
import {
  getActiveCampaignCount,
  getVariantCount,
  getCampaignVariantCount,
  comprobarTipoDeCampana,
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
/**
 * Devuelve el id del descuento en Shopify, o lanza si no existe.
 *
 * 🔴 Por qué esto no es una comprobación decorativa: antes, la rama de BXGY y la
 * de TIERED llevaban el id dentro de la propia condición
 * (`campaign.type === "BXGY" && bxgyId`). Si el id faltaba, la cadena de
 * `else if` no entraba en NINGUNA rama, no se tocaba Shopify… y el
 * `prisma.campaign.update` de más abajo escribía el estado igual. Resultado: la
 * app decía «Activa» y en el checkout no había ningún descuento — el mismo
 * síntoma que reportó la revisión de Shopify.
 *
 * Que falte el id es un fallo, no un caso normal: el `catch` de la acción lo
 * convierte en un 500 con mensaje, y el estado NO se mueve.
 */
function exigirDescuento(id: string | undefined): string {
  if (!id)
    throw new Error(
      "La campaña no tiene un descuento de Shopify asociado. No se cambió su estado."
    );
  return id;
}

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

  // Puerta por TIPO: si el plan incluye el tipo, y con cuántas activas.
  //
  // 🔴 Este es el punto que más importa de los nueve: desde el 2026-09-01 el
  // listado ACTIVA borradores de BxGy, Escalonado y Pack creando el descuento
  // en Shopify. Sin esta comprobación acá, un plan que no incluye el tipo lo
  // activaría igual desde la lista.
  //
  // La campaña está DRAFT o PAUSED en este punto, así que no se cuenta a sí
  // misma; `excluirCampanaId` lo hace explícito en vez de depender de eso.
  const bloqueoDeTipo = await comprobarTipoDeCampana(shop.id, plan, campaign.type, {
    excluirCampanaId: campaign.id,
  });
  if (bloqueoDeTipo)
    return Response.json(
      { error: bloqueoDeTipo, limitExceeded: true },
      { status: 422 }
    );

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
  // PACK, ídem: también es un descuento automático de app.
  const packId = (campaign.config as PackCampaignConfig).shopifyDiscountId;
  // CART_VALUE es el primero de clase ORDER, pero se gestiona igual.
  const cartValueId = (campaign.config as CartValueCampaignConfig).shopifyDiscountId;
  // 🔴 CODE_ORIGINAL_PRICE es de CODIGO, no automatico: sus mutaciones son
  // `discountCode*` y no `discountAutomatic*`. Ver `original-price.ts`.
  const cuponId = (campaign.config as OriginalPriceCampaignConfig).shopifyDiscountId;

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
      } else if (campaign.type === "BXGY") {
        await deactivateBxgyDiscount(admin, exigirDescuento(bxgyId));
      } else if (campaign.type === "TIERED") {
        await deactivateTieredDiscount(admin, exigirDescuento(tieredId));
      } else if (campaign.type === "PACK") {
        await deactivatePackDiscount(admin, exigirDescuento(packId));
      } else if (campaign.type === "CART_VALUE") {
        await deactivateCartValueDiscount(admin, exigirDescuento(cartValueId));
      } else if (campaign.type === "CODE_ORIGINAL_PRICE") {
        await deactivateOriginalPriceDiscount(admin, exigirDescuento(cuponId));
      }
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
    } else if (actionType === "activate" && campaign.status === "DRAFT") {
      // ── Activar un BORRADOR ───────────────────────────────────────────────
      // Un borrador todavía NO tiene descuento en Shopify: activarlo es CREARLO,
      // no reactivar nada. Sin esta rama la campaña quedaba atrapada — el listado
      // no ofrecía botón y la pantalla de edición rotulaba «Guardar cambios», así
      // que el merchant no encontraba cómo publicarla y el descuento no llegaba
      // nunca al checkout.
      //
      // Solo BXGY y TIERED entran por aquí: su activación es UNA mutación y
      // termina en milisegundos, por eso va síncrona y no por el motor de jobs.
      // Porcentaje y Rango se activan desde su pantalla de edición, que es donde
      // vive el camino de aplicar precios variante a variante.
      const limite = await comprobarLimitesAlReactivar(shop, campaign);
      if (limite) return limite;

      // Se comprueba el id ANTES de crear: un borrador normalmente no tiene
      // descuento, pero puede tenerlo si un guardado anterior lo creó en Shopify
      // y falló después (la pantalla de edición revierte el estado a borrador en
      // ese caso). Crear otra vez dejaría DOS descuentos automáticos vivos en la
      // tienda del merchant, con el primero huérfano y sin forma de pausarlo
      // desde la app. Reutilizar el que ya existe hace la operación idempotente.
      if (campaign.type === "BXGY") {
        if (bxgyId) {
          await activateBxgyDiscount(admin, bxgyId);
        } else {
          await createBxgyDiscount(
            admin,
            campaignId,
            campaign.name,
            campaign.config as BxgyCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
        }
      } else if (campaign.type === "TIERED") {
        if (tieredId) {
          // Mismo motivo que al reactivar: se reescribe la configuración antes de
          // activar, para migrar metafields legados y re-resolver la selección.
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
        } else {
          await createTieredDiscount(
            admin,
            campaignId,
            campaign.name,
            campaign.config as TieredCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
        }
      } else if (campaign.type === "PACK") {
        if (packId) {
          // Mismo motivo que en TIERED: se reescribe la configuración antes de
          // activar, para que el metafield refleje lo último que guardó el
          // merchant y no lo que había cuando se creó el descuento.
          await updatePackDiscount(
            admin,
            campaignId,
            campaign.name,
            packId,
            campaign.config as PackCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
          await activatePackDiscount(admin, packId);
        } else {
          await createPackDiscount(
            admin,
            campaignId,
            campaign.name,
            campaign.config as PackCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
        }
      } else if (campaign.type === "CART_VALUE") {
        if (cartValueId) {
          await updateCartValueDiscount(
            admin,
            campaignId,
            campaign.name,
            cartValueId,
            campaign.config as CartValueCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
          await activateCartValueDiscount(admin, cartValueId);
        } else {
          await createCartValueDiscount(
            admin,
            campaignId,
            campaign.name,
            campaign.config as CartValueCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
        }
      } else if (campaign.type === "CODE_ORIGINAL_PRICE") {
        if (cuponId) {
          await updateOriginalPriceDiscount(
            admin,
            campaignId,
            campaign.name,
            cuponId,
            campaign.config as OriginalPriceCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
          await activateOriginalPriceDiscount(admin, cuponId);
        } else {
          await createOriginalPriceDiscount(
            admin,
            campaignId,
            campaign.name,
            campaign.config as OriginalPriceCampaignConfig,
            campaign.startsAt,
            campaign.endsAt
          );
        }
      } else {
        return Response.json(
          {
            error:
              "Este tipo de campaña se activa desde su pantalla de edición, donde se aplican los precios.",
          },
          { status: 400 }
        );
      }
      // Solo se llega aquí si Shopify confirmó la creación: `createBxgyDiscount`
      // y `createTieredDiscount` lanzan ante userErrors o si no devuelven id.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });
    } else if (actionType === "activate" && campaign.status === "PAUSED") {
      const limite = await comprobarLimitesAlReactivar(shop, campaign);
      if (limite) return limite;

      if (campaign.type === "PERCENTAGE") {
        await reactivatePercentageDiscount(admin, campaignId);
      } else if (campaign.type === "RANGE") {
        await reactivateRangeDiscount(admin, campaignId);
      } else if (campaign.type === "BXGY") {
        await activateBxgyDiscount(admin, exigirDescuento(bxgyId));
      } else if (campaign.type === "TIERED") {
        const idTiered = exigirDescuento(tieredId);
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
          idTiered,
          campaignId,
          campaign.name,
          campaign.config as TieredCampaignConfig,
          campaign.startsAt,
          campaign.endsAt
        );
        await activateTieredDiscount(admin, idTiered);
      } else if (campaign.type === "PACK") {
        const idPack = exigirDescuento(packId);
        // Se reescribe la configuración antes de activar, por el mismo motivo
        // que en TIERED: una campaña pudo pasar semanas pausada y el metafield
        // tiene que reflejar lo último que guardó el merchant.
        await updatePackDiscount(
          admin,
          campaignId,
          campaign.name,
          idPack,
          campaign.config as PackCampaignConfig,
          campaign.startsAt,
          campaign.endsAt
        );
        await activatePackDiscount(admin, idPack);
      } else if (campaign.type === "CART_VALUE") {
        const idCv = exigirDescuento(cartValueId);
        // Se reescribe la configuración antes de activar, igual que en los
        // otros dos: una campaña pudo pasar semanas pausada y el metafield
        // tiene que reflejar lo último que guardó el merchant.
        await updateCartValueDiscount(
          admin,
          campaignId,
          campaign.name,
          idCv,
          campaign.config as CartValueCampaignConfig,
          campaign.startsAt,
          campaign.endsAt
        );
        await activateCartValueDiscount(admin, idCv);
      } else if (campaign.type === "CODE_ORIGINAL_PRICE") {
        const idCupon = exigirDescuento(cuponId);
        await updateOriginalPriceDiscount(
          admin,
          campaignId,
          campaign.name,
          idCupon,
          campaign.config as OriginalPriceCampaignConfig,
          campaign.startsAt,
          campaign.endsAt
        );
        await activateOriginalPriceDiscount(admin, idCupon);
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
        } else if (campaign.type === "PACK" && packId) {
          try { await deletePackDiscount(admin, packId); } catch { /* discount may already be gone */ }
        } else if (campaign.type === "CART_VALUE" && cartValueId) {
          try { await deleteCartValueDiscount(admin, cartValueId); } catch { /* discount may already be gone */ }
        } else if (campaign.type === "CODE_ORIGINAL_PRICE" && cuponId) {
          try { await deleteOriginalPriceDiscount(admin, cuponId); } catch { /* discount may already be gone */ }
        }
      }
      await prisma.campaign.delete({ where: { id: campaignId } });
    }

    // Un unico punto para las tres acciones (pausar, activar, borrar): el
    // metafield describe TODOS los packs activos de la tienda, asi que se
    // recalcula entero desde Postgres y no hace falta saber cual cambio.
    // No lanza nunca: si falla, el widget cae al app proxy.
    if (campaign.type === "PACK")
      await sincronizarMetafieldDeWidget(admin, shop.id);
  } catch (err) {
    // Se registra en el servidor ADEMÁS de devolverlo: en Vercel Hobby los logs
    // duran 1 hora, así que un fallo que solo viaje al navegador y el merchant no
    // reporte se pierde entero. Con el contexto (tienda, campaña, tipo, acción)
    // el error es diagnosticable sin tener que reproducirlo.
    console.error(
      `[campaign-action] ${actionType} falló · shop=${session.shop} · campaña=${campaignId} ` +
        `· tipo=${campaign.type} · estado=${campaign.status}`,
      err
    );
    const mensaje = err instanceof Error ? err.message : String(err);
    return Response.json({ error: mensaje }, { status: 500 });
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

/**
 * Mockup del armador de packs: tres tarjetas de producto, dos ya elegidas, y el
 * total con el ahorro. Es la lectura de un vistazo de lo que hace el tipo.
 */
function MockupPack() {
  const items = [
    { elegido: true },
    { elegido: true },
    { elegido: false },
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
      <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
        {items.map((it, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: "30px",
              borderRadius: "4px",
              background: it.elegido ? "#e8f5e9" : "#ffffff",
              border: `1px solid ${it.elegido ? "#2e7d32" : "#e1e3e5"}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "9px",
              fontWeight: 700,
              color: it.elegido ? "#2e7d32" : "#c9cccf",
            }}
          >
            {it.elegido ? "✓" : "+"}
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: "1px solid #edeef0",
          paddingTop: "6px",
        }}
      >
        <span style={{ fontSize: "10px", color: "#6d7175" }}>2 productos</span>
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
          10%
        </span>
      </div>
    </div>
  );
}

/**
 * Mockup del descuento por monto de compra.
 *
 * 🔴 Tiene que leerse distinto del de packs y del de escalonados, porque el tipo
 * ES distinto: acá el descuento no depende de CUÁNTOS productos lleve el
 * comprador sino de CUÁNTO DINERO hay en el carrito. Por eso la fila no muestra
 * cuadritos de producto sino un importe y una barra que se llena: el eje es el
 * monto. Mismo lenguaje visual que las otras cinco (fondo #f8fafb, píldora
 * verde), distinta lectura de un vistazo.
 */
function MockupValorCarrito() {
  const niveles = [
    { monto: "$50", llenado: 40, pct: "5%" },
    { monto: "$100", llenado: 70, pct: "10%" },
    { monto: "$200", llenado: 100, pct: "15%" },
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
          key={n.monto}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "3px 0",
            borderBottom: i < niveles.length - 1 ? "1px solid #edeef0" : "none",
          }}
        >
          <span
            style={{
              fontSize: "10px",
              fontWeight: 700,
              color: "#6d7175",
              width: "30px",
              flex: "0 0 auto",
            }}
          >
            {n.monto}
          </span>
          <div
            style={{
              flex: 1,
              height: "8px",
              borderRadius: "4px",
              background: "#e1e3e5",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${n.llenado}%`,
                height: "8px",
                borderRadius: "4px",
                background: "#2e7d32",
              }}
            />
          </div>
          <span
            style={{
              background: "#e8f5e9",
              color: "#2e7d32",
              fontSize: "9px",
              fontWeight: "700",
              padding: "1px 6px",
              borderRadius: "8px",
              flex: "0 0 auto",
            }}
          >
            {n.pct}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Mockup del cupon sobre precio original.
 *
 * 🔴 Tiene que leerse distinto de los otros cinco, porque el tipo ES distinto:
 * aca no hay niveles ni cantidades. Hay UN codigo y una comparacion — de que
 * precio se calcula el descuento. Por eso la ilustracion es un codigo arriba y
 * dos lineas debajo: el precio tachado, que es la base que usamos, y el precio
 * de hoy, que es la base que usaria Shopify. Mismo lenguaje visual que las
 * otras (fondo #f8fafb, pildora verde), distinta lectura de un vistazo.
 */
function MockupCupon() {
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
      {/* El codigo: es lo primero que reconoce el merchant. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          paddingBottom: "8px",
          borderBottom: "1px solid #edeef0",
        }}
      >
        <span
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "11px",
            fontWeight: 700,
            color: "#202223",
            background: "#ffffff",
            border: "1px dashed #c9cccf",
            borderRadius: "4px",
            padding: "2px 8px",
            letterSpacing: "0.08em",
          }}
        >
          MARIA10
        </span>
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
          10%
        </span>
      </div>

      {/* Las dos bases: la que usamos (tachada, la de lista) y la de hoy. */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", paddingTop: "8px" }}>
        <span
          style={{
            fontSize: "12px",
            color: "#2e7d32",
            fontWeight: 700,
            textDecoration: "line-through",
          }}
        >
          $100
        </span>
        <span style={{ fontSize: "9px", color: "#6d7175" }}>base del cupon</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", paddingTop: "3px" }}>
        <span style={{ fontSize: "12px", color: "#8c9196" }}>$85</span>
        <span style={{ fontSize: "9px", color: "#c9cccf" }}>precio de hoy</span>
      </div>
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

      {/* Banner de error de las acciones del listado.
          🔴 La condición era `fetcherData?.limitExceeded && fetcherData.error`, así
          que SOLO se pintaba el aviso de límite de plan: cualquier otro fallo
          —Shopify rechaza la mutación, la selección no resuelve productos, el
          descuento no existe— volvía en el JSON y se descartaba sin pintar nada.
          El merchant veía «Activando…», luego nada, y la campaña sin cambiar de
          estado. Ahora se muestra SIEMPRE que haya error: amarillo con enlace a
          planes si es de cuota, rojo si es un fallo real. */}
      {fetcherData?.error && (
        <div
          style={{
            background: fetcherData.limitExceeded ? "#fff8e1" : "#fde8e8",
            border: `1px solid ${fetcherData.limitExceeded ? "#f9a825" : "#f97066"}`,
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "14px",
            color: fetcherData.limitExceeded ? "#a05c00" : "#c0392b",
            marginBottom: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <span>{fetcherData.error}</span>
          {fetcherData.limitExceeded && (
            <Link
              to="/app/plans"
              style={{ fontSize: "13px", fontWeight: "600", color: "#008060", textDecoration: "none", whiteSpace: "nowrap" }}
            >
              {es.planes.verPlanes} →
            </Link>
          )}
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
          <CampaignCard
            mockup={<MockupPack />}
            title={es.campanas.pack.titulo}
            description={es.campanas.pack.descripcion}
            ejemplo={es.campanas.pack.ejemplo}
            href="/app/campaigns/new/pack"
          />
          <CampaignCard
            mockup={<MockupValorCarrito />}
            title={es.campanas.valorCarrito.titulo}
            description={es.campanas.valorCarrito.descripcion}
            ejemplo={es.campanas.valorCarrito.ejemplo}
            href="/app/campaigns/new/cart-value"
          />
          <CampaignCard
            mockup={<MockupCupon />}
            title={es.campanas.cupon.titulo}
            description={es.campanas.cupon.descripcion}
            ejemplo={es.campanas.cupon.ejemplo}
            href="/app/campaigns/new/original-price"
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
                      : c.type === "PACK"
                      ? packDiscountLabel(c.config as PackCampaignConfig)
                      : c.type === "CART_VALUE"
                      ? cartValueLabel(c.config as CartValueCampaignConfig)
                      : c.type === "CODE_ORIGINAL_PRICE"
                      ? originalPriceLabel(c.config as OriginalPriceCampaignConfig)
                      : "—";
                  // El codigo del cupon, para que el merchant reconozca a su
                  // influencer en la fila sin tener que abrir la campana.
                  const codigoCupon =
                    c.type === "CODE_ORIGINAL_PRICE"
                      ? (c.config as OriginalPriceCampaignConfig).code
                      : null;
                  const editHref =
                    c.type === "BXGY"
                      ? `/app/campaigns/${c.id}/edit/bxgy`
                      : c.type === "RANGE"
                      ? `/app/campaigns/${c.id}/edit/range`
                      : c.type === "TIERED"
                      ? `/app/campaigns/${c.id}/edit/tiered`
                      : c.type === "PACK"
                      ? `/app/campaigns/${c.id}/edit/pack`
                      : c.type === "CART_VALUE"
                      ? `/app/campaigns/${c.id}/edit/cart-value`
                      : c.type === "CODE_ORIGINAL_PRICE"
                      ? `/app/campaigns/${c.id}/edit/original-price`
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
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {codigoCupon && (
                          <span
                            style={{
                              display: "inline-block",
                              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                              fontSize: "12px",
                              fontWeight: 600,
                              color: "#202223",
                              background: "#f1f2f3",
                              border: "1px solid #e1e3e5",
                              borderRadius: "4px",
                              padding: "1px 6px",
                              marginRight: "8px",
                              letterSpacing: "0.04em",
                            }}
                          >
                            {codigoCupon}
                          </span>
                        )}
                        {discount}
                      </td>
                      <td style={{ padding: "12px", color: "#6d7175" }}>
                        {/* TIERED y PACK no crean filas en CampaignProduct:
                            su conteo sale del config. El resto no se toca. */}
                        {c.type === "TIERED"
                          ? tieredProductsLabel(c.config as TieredCampaignConfig)
                          : c.type === "PACK"
                          ? packProductsLabel(c.config as PackCampaignConfig)
                          : c.type === "CART_VALUE"
                          ? "Todo el carrito"
                          : c.type === "CODE_ORIGINAL_PRICE"
                          ? "Toda la tienda"
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

                          {/* Activar — cuando PAUSED (reactivar), y cuando DRAFT
                              en BxGy/Escalonado (crear el descuento en Shopify).
                              Sin esta segunda mitad, un borrador de esos dos tipos
                              quedaba atrapado: aquí no había botón y la pantalla de
                              edición rotulaba «Guardar cambios». Porcentaje y Rango
                              se activan desde su edición, donde se aplican precios. */}
                          {(c.status === "PAUSED" ||
                            (c.status === "DRAFT" &&
                              (c.type === "BXGY" ||
                                c.type === "TIERED" ||
                                c.type === "PACK" ||
                                c.type === "CART_VALUE" ||
                                c.type === "CODE_ORIGINAL_PRICE"))) && (
                            <Btn
                              variant="primary"
                              size="sm"
                              disabled={isBusy || !!jobId}
                              onClick={() => submitAction(c.id, "activate")}
                            >
                              {pendingAction?.id === c.id && pendingAction.type === "activate"
                                ? "Activando…"
                                : c.status === "DRAFT"
                                ? es.campanas.acciones.activar
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
