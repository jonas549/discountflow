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
  if (
    shop.lastSyncAt &&
    now.getTime() - shop.lastSyncAt.getTime() < SYNC_INTERVAL_MS
  ) {
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

    // FROZEN = shop paused by Shopify — keep current plan, just update sync time
    if (sub?.status === "FROZEN") {
      return prisma.shop.update({
        where: { id: shop.id },
        data: { lastSyncAt: now, currency },
      });
    }

    let newPlan = "FREE";

    if (sub && (sub.status === "ACTIVE" || sub.status === "PENDING")) {
      newPlan = handleToPlan(sub.name);
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
  } catch {
    // Network error or API hiccup — don't crash the app, just skip sync
    return shop;
  }
}
