# DiscountFlow

A Shopify app for managing discount campaigns: percentage discounts, fixed-price range
campaigns, and Buy X Get Y promotions. Built with React Router v7, Prisma, and Neon
PostgreSQL. Deployed on Vercel.

---

## Stack

| Layer       | Technology                                          |
|-------------|-----------------------------------------------------|
| Framework   | React Router v7 (framework mode, SSR)               |
| UI          | Shopify Polaris web components (App Home design)    |
| Auth        | `@shopify/shopify-app-react-router`                 |
| Database    | Neon PostgreSQL via Prisma                          |
| Hosting     | Vercel (serverless, Node.js runtime)                |
| Extensions  | Shopify Functions (BXGY) — Phase 2                 |

---

## Local Development

### Prerequisites

- Node.js ≥ 20.19 or ≥ 22.12
- npm ≥ 10
- Shopify Partner account
- Neon PostgreSQL project (free tier works)
- Shopify development store

### 1. Clone and install

```bash
git clone <repo-url> discountflow
cd discountflow
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable            | Where to find it                                             |
|---------------------|--------------------------------------------------------------|
| `SHOPIFY_API_KEY`   | Partner Dashboard → App → API credentials                    |
| `SHOPIFY_API_SECRET`| Partner Dashboard → App → API credentials                    |
| `SCOPES`            | Copy from `.env.example` (must match `shopify.app.toml`)     |
| `SHOPIFY_APP_URL`   | Set to your ngrok/tunnel URL during local dev                |
| `DATABASE_URL`      | Neon dashboard → your project → Pooled connection string     |
| `DIRECT_URL`        | Neon dashboard → your project → Direct connection string     |

### 3. Link the app to your Partner Dashboard

```bash
npx shopify app config link
```

This updates `shopify.app.toml` with the correct `client_id` and `application_url`.

### 4. Run the database migration

```bash
npm run setup
```

This runs `prisma generate` + `prisma migrate deploy`. For a fresh Neon database,
Prisma will create all tables.

### 5. Start the development server

```bash
npm run dev
```

The Shopify CLI will:
- Prompt you to select a development store
- Create an ngrok tunnel
- Set `SHOPIFY_APP_URL` automatically
- Open the app in your dev store admin

---

## Database — Neon PostgreSQL

DiscountFlow uses two connection strings:

- **`DATABASE_URL`** — the *pooled* Neon endpoint (via PgBouncer). Used by the app
  at runtime. Safe for serverless environments with high concurrency.
- **`DIRECT_URL`** — the *direct* Neon endpoint. Used only by `prisma migrate` and
  `prisma db push`, which require a persistent connection that bypasses PgBouncer.

### Creating a migration

```bash
npx prisma migrate dev --name <migration-name>
```

This uses `DIRECT_URL` and creates a SQL file under `prisma/migrations/`.

### Applying migrations (CI / production)

```bash
npx prisma migrate deploy
```

This is also called by `npm run setup`.

---

## Deploying to Vercel

### 1. Push to GitHub

```bash
git remote add origin <your-github-repo>
git push -u origin main
```

### 2. Import to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import your GitHub repo.
2. Vercel will detect the `framework: remix` setting in `vercel.json` automatically.

### 3. Add environment variables in Vercel

In the Vercel project settings → Environment Variables, add all variables from
`.env.example`:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SCOPES`
- `SHOPIFY_APP_URL` — set to your Vercel deployment URL (e.g. `https://discountflow.vercel.app`)
- `DATABASE_URL` — Neon pooled connection string
- `DIRECT_URL` — Neon direct connection string
- `NODE_ENV=production`

### 4. Update shopify.app.toml and redeploy

After your first deploy, update `shopify.app.toml`:

```toml
application_url = "https://your-app.vercel.app"

[auth]
redirect_urls = [
  "https://your-app.vercel.app/auth/callback",
  "https://your-app.vercel.app/auth/shopify/callback",
  "https://your-app.vercel.app/api/auth/callback"
]
```

Then deploy the config:

```bash
npx shopify app deploy
```

### 5. Run migrations on Neon

Vercel's `buildCommand` in `vercel.json` runs `npm run setup` (which includes
`prisma migrate deploy`) before every build. Ensure `DIRECT_URL` is set in Vercel
environment variables so Prisma can connect directly for migrations.

---

## Vercel Cron Jobs

`vercel.json` defines a cron that runs every 10 minutes to activate/deactivate
campaigns based on `startsAt`/`endsAt`. The cron endpoint is implemented in
Phase 2 at `app/routes/api.cron.sync-campaigns.ts`.

---

## Project Structure

```
discountflow/
├── app/
│   ├── routes/
│   │   ├── app.tsx                       # Shell: auth + navigation
│   │   ├── app._index.tsx                # Dashboard
│   │   ├── app.campaigns._index.tsx      # Campaign list & creation
│   │   ├── app.analytics.tsx             # Analytics
│   │   ├── app.support.tsx               # Support
│   │   ├── auth.$.tsx                    # OAuth callback
│   │   ├── webhooks.app.uninstalled.tsx  # GDPR webhook
│   │   ├── webhooks.app.scopes_update.tsx
│   │   └── webhooks.orders.create.tsx    # Phase 2: order attribution
│   ├── lib/
│   │   ├── discounts/
│   │   │   ├── percentage.ts             # Phase 2
│   │   │   ├── range.ts                  # Phase 2
│   │   │   └── bxgy.ts                  # Phase 2
│   │   ├── shopify/
│   │   │   └── admin-api.ts             # Phase 2
│   │   └── db/
│   │       └── index.ts                 # Re-exports Prisma client
│   ├── db.server.ts                     # Prisma singleton
│   └── shopify.server.ts                # Shopify app config
├── extensions/                          # Shopify Function (BXGY) — Phase 2
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── DECISIONS.md                         # Architecture decisions
├── shopify.app.toml                     # App config & scopes
├── vercel.json                          # Vercel deployment config
└── .env.example
```

---

## Technical Decisions

See [DECISIONS.md](./DECISIONS.md) for full rationale on:
- Hybrid discount approach (Admin API + Shopify Functions)
- Single Campaign table with JSON config
- Neon PostgreSQL dual-URL setup
- Vercel deployment with `framework: remix`

---

## Troubleshooting

**`DATABASE_URL` connection refused on local:**
Make sure you copied the *pooled* Neon connection string (contains `-pooler` in the hostname).

**`DIRECT_URL` needed for migrations:**
Neon's pooler doesn't support the extended query protocol that Prisma migrate requires.
Always use the direct (non-pooler) URL for `DIRECT_URL`.

**Embedded app redirect loops:**
Ensure `SHOPIFY_APP_URL` matches the tunnel URL shown by `shopify app dev`. The CLI
updates this automatically when `automatically_update_urls_on_dev = true` in `shopify.app.toml`.

**`nbf` JWT claim error:**
Your system clock is out of sync. Enable "Set time and date automatically" in your
OS date/time settings.
