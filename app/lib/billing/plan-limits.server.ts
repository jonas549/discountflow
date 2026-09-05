import { prisma } from "../db";
import {
  type Plan,
  type TypeLimitedCampaign,
  esTipoLimitadoPorPlan,
  reglaDeTipo,
  PLAN_LIMITS,
} from "./plan-limits";
import { es } from "../../i18n";

/** Count only ACTIVE campaigns (used for plan enforcement and display). */
export async function getActiveCampaignCount(shopId: string): Promise<number> {
  return prisma.campaign.count({
    where: { shopId, status: "ACTIVE" },
  });
}

/** @deprecated Alias kept for backwards-compat — use getActiveCampaignCount. */
export const getCampaignCount = getActiveCampaignCount;

/** Count variant records in ACTIVE campaigns for quota display. */
export async function getVariantCount(shopId: string): Promise<number> {
  return prisma.campaignProduct.count({
    where: { campaign: { shopId, status: "ACTIVE" } },
  });
}

/**
 * Count the variant rows of ONE campaign, whatever its status.
 *
 * Necesario para el enforcement al activar/reactivar: en ese momento la campaña
 * NO está ACTIVE, así que `getVariantCount` (que solo cuenta activas) no la
 * incluye. El total real tras activar es `getVariantCount + esta`.
 *
 * Solo PERCENTAGE y RANGE crean filas en CampaignProduct; BXGY y TIERED
 * devuelven 0 por diseño (no editan precios de variantes).
 */
export async function getCampaignVariantCount(campaignId: string): Promise<number> {
  return prisma.campaignProduct.count({ where: { campaignId } });
}

/**
 * Campañas ACTIVAS de un tipo concreto. Sublímite de BXGY y TIERED.
 *
 * Solo cuentan las ACTIVE: pausadas y borradores no ocupan cuota, así que el
 * merchant puede tener varias guardadas y pausar una para activar otra.
 */
export async function getActiveCampaignCountByType(
  shopId: string,
  type: TypeLimitedCampaign
): Promise<number> {
  return prisma.campaign.count({ where: { shopId, status: "ACTIVE", type } });
}

/**
 * 🔴 EL ÚNICO sitio que decide si una campaña puede quedar ACTIVA por su tipo.
 *
 * Devuelve el mensaje del bloqueo, o `null` si puede pasar. NO construye la
 * Response: cada ruta tiene su propia forma de JSON (unas usan `errors.general`,
 * el listado usa `error`) y eso es presentación. Lo que no puede estar duplicado
 * es la DECISIÓN, que es lo que vive acá.
 *
 * Dos motivos de bloqueo, y son distintos a propósito:
 *   · el plan no incluye el tipo   → hay que subir de plan, pausar no ayuda
 *   · el plan lo incluye con tope  → pausar otra campaña del tipo sí ayuda
 *
 * La puerta va en la ACTIVACIÓN, nunca en el guardado: un borrador siempre se
 * puede guardar. Así el límite es un argumento de venta y no un muro.
 */
export async function comprobarTipoDeCampana(
  shopId: string,
  plan: Plan,
  type: string,
  opciones?: { excluirCampanaId?: string }
): Promise<string | null> {
  if (!esTipoLimitadoPorPlan(type)) return null;

  const regla = reglaDeTipo(plan, type);

  if (!regla.incluido)
    return es.planes.tipoNoIncluido(
      es.planes.nombreDeTipo(type),
      PLAN_LIMITS[plan].label
    );

  if (regla.max === null) return null;

  const activas = await prisma.campaign.count({
    where: {
      shopId,
      status: "ACTIVE",
      type,
      ...(opciones?.excluirCampanaId ? { id: { not: opciones.excluirCampanaId } } : {}),
    },
  });

  if (activas >= regla.max)
    return es.planes.limiteCampanasTipo(
      es.planes.nombreDeTipo(type),
      activas,
      regla.max
    );

  return null;
}
