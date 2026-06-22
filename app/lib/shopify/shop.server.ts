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
        appInstallation {
          activeSubscription {
            name
            status
          }
        }
        shop {
          currencyCode
        }
      }
    `);
    const json = (await res.json()) as {
      data?: {
        appInstallation?: {
          activeSubscription?: {
            name: string;
            status: string;
          } | null;
        };
        shop?: { currencyCode?: string };
      };
    };

    const sub = json.data?.appInstallation?.activeSubscription;
    const currency = json.data?.shop?.currencyCode ?? "USD";
    console.log(
      `[plan-sync] api shop=${shop.id} sub=${JSON.stringify(sub)} currency=${currency} errors=${JSON.stringify(
        (json as { errors?: unknown }).errors ?? null
      )}`
    );

    // FROZEN = shop paused by Shopify — keep current plan, just update sync time
    if (sub?.status === "FROZEN") {
      console.log(`[plan-sync] FROZEN shop=${shop.id} keeping plan=${shop.plan}`);
      return prisma.shop.update({
        where: { id: shop.id },
        data: { lastSyncAt: now, currency },
      });
    }

    let newPlan = "FREE";

    if (sub && (sub.status === "ACTIVE" || sub.status === "PENDING")) {
      newPlan = handleToPlan(sub.name);
    }

    console.log(
      `[plan-sync] resolved shop=${shop.id} sub.name=${sub?.name ?? "none"} status=${
        sub?.status ?? "none"
      } currentPlan=${shop.plan} newPlan=${newPlan}`
    );

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
