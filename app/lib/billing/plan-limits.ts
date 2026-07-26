// Client-safe constants — no server imports.
// DB query helpers are in plan-limits.server.ts

export const PLANS = ["FREE", "LITE", "ESSENTIAL", "PROFESSIONAL"] as const;
export type Plan = (typeof PLANS)[number];

// maxBxgy / maxTiered = máximo de campañas ACTIVAS SIMULTÁNEAS de ese tipo.
// `null` = sin sublímite propio (FREE se apoya en el límite general de 2
// campañas; PROFESSIONAL queda acotado de facto por sus 100 generales).
// Pausadas y borradores NO cuentan: pausar una para activar otra es válido.
export const PLAN_LIMITS = {
  FREE: {
    campaigns: 2,
    variants: 50,
    maxBxgy: null,
    maxTiered: null,
    price: 0,
    trialDays: 0,
    handle: "free",
    label: "Gratis",
  },
  LITE: {
    campaigns: 5,
    variants: 750,
    maxBxgy: 4,
    maxTiered: 2,
    price: 9.99,
    trialDays: 0,
    handle: "lite",
    label: "Lite",
  },
  ESSENTIAL: {
    campaigns: 50,
    variants: 6000,
    maxBxgy: 10,
    maxTiered: 10,
    price: 27.99,
    trialDays: 0,
    handle: "essential",
    label: "Essential",
  },
  PROFESSIONAL: {
    campaigns: 100,
    variants: 10000,
    maxBxgy: null,
    maxTiered: null,
    price: 44.99,
    trialDays: 0,
    handle: "professional",
    label: "Professional",
  },
} as const;

/** Tipos de campaña que se topan por CANTIDAD de activas, no por variantes. */
export type TypeLimitedCampaign = "BXGY" | "TIERED";

/** Máximo de campañas activas de ese tipo, o `null` si el plan no lo limita. */
export function getTypeCampaignLimit(
  plan: Plan,
  type: TypeLimitedCampaign
): number | null {
  const limits = PLAN_LIMITS[plan];
  return type === "BXGY" ? limits.maxBxgy : limits.maxTiered;
}

export function handleToPlan(handle: string | null | undefined): Plan {
  if (!handle) return "FREE";
  const up = handle.toUpperCase();
  return (PLANS as readonly string[]).includes(up) ? (up as Plan) : "FREE";
}

export function getPlanLimits(plan: Plan) {
  return PLAN_LIMITS[plan];
}
