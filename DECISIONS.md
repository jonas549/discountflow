# DiscountFlow — Technical Decisions

## 1. Discount Implementation Approach

**Decision: Hybrid model — Admin API price modification for PERCENTAGE & RANGE + Shopify Functions for BXGY**

### PERCENTAGE and RANGE campaigns
We modify `price` and `compareAtPrice` on product variants directly via the Admin GraphQL API. Before each modification we store original values in `CampaignProduct.originalPrice` and `CampaignProduct.originalCompareAtPrice`, then restore them when the campaign ends or is paused.

**Why this, not Shopify Functions for these types:**
Shopify Functions (Discount API) apply discounts exclusively at the checkout level. They do **not** propagate strikethrough prices to Product Detail Pages or collection listings — which is a core UX requirement. Price modification via Admin API is the only approach that achieves visible `compareAtPrice` strikethroughs across the entire storefront, in every theme, without custom theme code.

**Non-destructive guarantee:** We never discard original data. The restore path runs on campaign end, pause, or app uninstall. If the app crashes mid-campaign, a recovery job (Phase 2, via Vercel Cron) re-reads the stored originals and restores them.

**What major apps do:** Discounty, Bold Discounts, and Discount Ninja all use this approach for percentage and fixed-price campaigns. It is battle-tested at scale.

**Alternatives considered:**
- Pure Shopify Functions → rejected: no storefront strikethrough support.
- Theme App Extension with metafield-driven price display → rejected: requires theme co-operation, breaks without the extension installed.

### BXGY campaigns
We use Shopify Functions (`purchase.product-discount.run`) compiled to WASM and deployed as an extension. The function evaluates cart line items and applies the "get" discount at checkout. This is Shopify's recommended and supported approach for cart-level conditional discounts.

**Why Functions for BXGY:** BXGY logic is inherently cart-level (you need to see all items before applying the discount). Admin API price modification cannot express this. Functions run in Shopify's infrastructure, are non-destructive, and are compatible with checkout extensibility.

---

## 2. Framework — React Router v7 + TypeScript

**Decision: Use the official Shopify `@shopify/app-template-react-router` (TypeScript flavor)**

This template is maintained by Shopify and provides:
- React Router v7 (framework mode, SSR-first)
- `@shopify/shopify-app-react-router` server/client integration
- App Bridge + Polaris web components (App Home design system)
- Prisma + session storage out of the box
- GDPR webhooks scaffolded

**Alternatives considered:**
- Remix (pre-React Router v7 era) → superseded by React Router v7.
- Next.js → no official Shopify adapter; more custom work for OAuth, session, webhooks.
- Plain Express + custom frontend → too much boilerplate with no Shopify-specific benefits.

---

## 3. Database — Neon PostgreSQL via Prisma

**Decision: Prisma with PostgreSQL provider, dual-URL setup for pooled (runtime) and direct (migrations)**

```
DATABASE_URL  → Neon pooled endpoint (PgBouncer) — used by the app in all serverless invocations
DIRECT_URL    → Neon direct endpoint — used only by `prisma migrate` which needs a persistent connection
```

**Why Neon:** Neon offers serverless PostgreSQL with connection pooling built in. PgBouncer on the pooled endpoint manages connection limits for Vercel's ephemeral function instances automatically.

**Why not the Neon serverless driver adapter (`@prisma/adapter-neon`):**
The Neon driver adapter uses HTTP/fetch-based connections instead of WebSocket TCP. This is primarily beneficial in the Vercel Edge Runtime. We are running Node.js runtime (required by the Shopify session storage and crypto operations), so the standard PostgreSQL provider with the pooled URL is sufficient and simpler.

**Alternatives considered:**
- Planetscale (MySQL) → Shopify's session storage Prisma adapter works best with PostgreSQL types.
- Supabase → Neon's free tier and serverless-first design is a better fit for Vercel.
- Turso (SQLite edge) → no Prisma adapter for async operations; SQLite semantics differ.

---

## 4. Prisma Schema — Single Campaign table with JSON config

**Decision: One `Campaign` table with a `config: Json` field for type-specific parameters**

Rather than three tables (`PercentageCampaign`, `RangeCampaign`, `BxgyCampaign`) or a polymorphic pattern, we store type-specific configuration in a typed JSON column.

**Why JSON config:**
- All three types share 90% of their fields (name, status, dates, products, attribution).
- Type-specific config is shallow and stable: `{ discountPercent }` / `{ fixedPrice }` / `{ buyQty, getQty, getDiscountPercent }`.
- Single table means single query for list views, no joins needed.
- TypeScript discriminated unions at the application layer enforce type correctness without DB-level columns.
- Easier to extend (add a field to one campaign type without a migration).

**Alternatives considered:**
- Separate table per type → three times the join complexity in list/dashboard queries.
- Polymorphic with `campaignConfigId` FK → still requires application-level dispatch, adds nullable FKs.
- PostgreSQL JSON validation constraints → deferred to application layer for simplicity.

---

## 5. Hosting — Vercel

**Decision: `"framework": "remix"` in `vercel.json`**

React Router v7 uses the same build output format as Remix (`build/client` for static assets, `build/server` for the SSR handler). Vercel's Remix framework preset handles this format natively, routing static asset requests to CDN and dynamic requests to a Node.js serverless function.

**Cron jobs:** Campaign activation/deactivation (starting/ending campaigns at `startsAt`/`endsAt`) is scheduled via `vercel.json` crons. The cron endpoint is `/api/cron/sync-campaigns` running every 10 minutes (Phase 2 implementation).

**Timeout budget:** Most Shopify Admin API calls resolve in < 3 s. Bulk product price updates for large catalogs may approach the 60 s Pro limit. We will batch updates and use pagination to stay within the limit.

**Alternatives considered:**
- Railway / Fly.io (persistent server) → simpler for background jobs, but more expensive and ops-heavy.
- Cloudflare Workers → `@react-router/dev/vite/cloudflare` preset exists, but Prisma PostgreSQL adapter does not support the Workers runtime.

---

## 6. App Distribution

**Decision: `AppDistribution.AppStore` from day 1, deployed as UNLISTED during development**

The code is structured as a multi-tenant public app (no hardcoded shop domains, per-shop session storage, correct OAuth flow). We will use the Shopify Partner Dashboard "unlisted" status during QA, then switch to listed when ready.

This avoids a future rewrite: unlisted → listed is a configuration change, not a code change.
