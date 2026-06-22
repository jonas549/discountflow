import { prisma } from "../db";
import { handleToPlan } from "../billing/plan-limits";

type AdminClient = { graphql: (q: string, o?: { variables: unknown }) => Promise<Response> };

export async function getOrCreateShop({
  domain,
  accessToken,
  scopes,
}: {
  domain: string;
  accessToken: string;
  scopes?: string | null;
}) {
  return prisma.shop.upsert({
    where: { domain },
    create: { domain, accessToken, scopes: scopes ?? "" },
    update: { accessToken, scopes: scopes ?? undefined, updatedAt: new Date() },
  });
}

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 min

/** Query Shopify for the current app subscription + currency and update DB if stale. */
export async function syncShopPlanIfStale(
  admin: AdminClient,
  shop: { id: string; lastSyncAt: Date | null; plan: string }
) {
  const now = new Date();
  console.log(
    `[plan-sync] enter shop=${shop.id} plan=${shop.plan} lastSyncAt=${
      shop.lastSyncAt ? shop.lastSyncAt.toISOString() : "null"
    }`
  );
  if (
    shop.lastSyncAt &&
    now.getTime() - shop.lastSyncAt.getTime() < SYNC_INTERVAL_MS
  ) {
    console.log(
      `[plan-sync] skip (fresh, <15min) shop=${shop.id} plan=${shop.plan}`
    );
    return shop;
  }

  try {
    const res = await admin.graphql(`#graphql
      query {
        currentAppInstallation {
          activeSubscriptions {
            name
            status
            lineItems {
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    planHandle
                  }
                }
              }
            }
          }
        }
        shop {
          currencyCode
        }
      }
    `);
    const json = (await res.json()) as {
      data?: {
        currentAppInstallation?: {
          activeSubscriptions?: Array<{
            name: string;
            status: string;
            lineItems?: Array<{
              plan?: {
                pricingDetails?: {
                  __typename?: string;
                  planHandle?: string | null;
                };
              };
            }>;
          }>;
        };
        shop?: { currencyCode?: string };
      };
      errors?: unknown;
    };

    const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
    const currency = json.data?.shop?.currencyCode ?? "USD";
    const gqlErrors = json.errors;
    console.log(
      `[plan-sync] api shop=${shop.id} subs=${JSON.stringify(subs)} currency=${currency} errors=${JSON.stringify(
        gqlErrors ?? null
      )}`
    );

    // Safeguard: GraphQL returned errors → don't touch plan, retry on next load.
    if (gqlErrors && (!Array.isArray(gqlErrors) || gqlErrors.length > 0)) {
      console.warn(
        `[plan-sync] GraphQL errors present shop=${shop.id} — keeping plan=${shop.plan}, lastSyncAt unchanged`
      );
      return shop;
    }

    // FROZEN = on hold for non-payment — keep current plan, just update sync time.
    if (subs.some((s) => s.status === "FROZEN")) {
      console.log(`[plan-sync] FROZEN shop=${shop.id} keeping plan=${shop.plan}`);
      return prisma.shop.update({
        where: { id: shop.id },
        data: { lastSyncAt: now, currency },
      });
    }

    // Find the active/pending paid subscription and read its stable planHandle
    // (name is localized per store language, so it can't be matched reliably).
    const active = subs.find((s) => s.status === "ACTIVE" || s.status === "PENDING");
    let planHandle: string | null = null;
    if (active?.lineItems) {
      for (const li of active.lineItems) {
        const pd = li.plan?.pricingDetails;
        if (pd?.__typename === "AppRecurringPricing" && pd.planHandle) {
          planHandle = pd.planHandle;
          break;
        }
      }
    }
    const mapped = planHandle ? handleToPlan(planHandle) : null;

    console.log(
      `[plan-sync] resolved shop=${shop.id} activeStatus=${active?.status ?? "none"} name=${
        active?.name ?? "none"
      } planHandle=${planHandle ?? "none"} mapped=${mapped ?? "none"} currentPlan=${shop.plan}`
    );

    // Never degrade to FREE on ambiguity: only change plan when we positively
    // recognize an active/pending paid plan. Otherwise keep the current plan.
    let newPlan = shop.plan;
    if (active && mapped && mapped !== "FREE") {
      newPlan = mapped;
    } else if (active) {
      console.warn(
        `[plan-sync] active sub but unrecognized handle shop=${shop.id} planHandle=${planHandle} name=${active.name} — keeping plan=${shop.plan}`
      );
    } else {
      console.warn(
        `[plan-sync] no active/pending sub shop=${shop.id} (subs=${subs.length}) — keeping plan=${shop.plan}, not degrading`
      );
    }

    return prisma.shop.update({
      where: { id: shop.id },
      data: {
        plan: newPlan,
        currency,
        lastSyncAt: now,
        ...(newPlan !== shop.plan ? { planActivatedAt: now } : {}),
      },
    });
  } catch (err) {
    // Network error or API hiccup — don't crash the app, just skip sync
    console.error(`[plan-sync] THREW shop=${shop.id} (lastSyncAt stays unchanged):`, err);
    return shop;
  }
}
