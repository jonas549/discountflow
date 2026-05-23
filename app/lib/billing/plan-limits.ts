// Client-safe constants — no server imports.
// DB query helpers are in plan-limits.server.ts

export const PLANS = ["FREE", "LITE", "ESSENTIAL", "PROFESSIONAL"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LIMITS = {
  FREE: {
    campaigns: 2,
    variants: 50,
    price: 0,
    trialDays: 0,
    handle: "free",
    label: "Gratis",
  },
  LITE: {
    campaigns: 5,
    variants: 750,
    price: 9.99,
    trialDays: 0,
    handle: "lite",
    label: "Lite",
  },
  ESSENTIAL: {
    campaigns: 20,
    variants: 3000,
    price: 24.99,
    trialDays: 0,
    handle: "essential",
    label: "Essential",
  },
  PROFESSIONAL: {
    campaigns: 100,
    variants: 10000,
    price: 44.99,
    trialDays: 0,
    handle: "professional",
    label: "Professional",
  },
} as const;

export function handleToPlan(handle: string | null | undefined): Plan {
  if (!handle) return "FREE";
  const up = handle.toUpperCase();
  return (PLANS as readonly string[]).includes(up) ? (up as Plan) : "FREE";
}

export function getPlanLimits(plan: Plan) {
  return PLAN_LIMITS[plan];
}
