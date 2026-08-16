# subsTrack Backend

Production-grade Node.js backend for the subsTrack mobile app — **Fastify + TypeScript + Drizzle (PostgreSQL) + Clerk auth**.

The full API contract lives in [`docs/backend-prd.md`](../subsTrack/docs/backend-prd.md) (in the subsTrack repo).

## Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 + Fastify 5 | Fast, typed, first-class TS |
| Language | TypeScript (strict, NodeNext ESM) | Fail at compile time, not runtime |
| DB | PostgreSQL 16 + Drizzle ORM | SQL is the source of truth; type-safe queries |
| Auth | Clerk (`@clerk/backend`, JWT verification) | Frontend already uses Clerk — no password storage |
| Validation | zod | One schema = runtime validation + types |
| Webhooks | svix | Signed Clerk/RevenueCat payload verification |
| Deploy | Docker + Coolify (or any container host) | See below |

## Project layout

```
src/
  index.ts            bootstrap: verify DB, listen, graceful shutdown
  app.ts              Fastify assembly: CORS, raw-body JSON, error handler, routes
  config.ts           env parsing (fail-fast on boot) + .env loading
  constants.ts        currencies / billing cycles / categories / statuses
  db/
    schema.ts         users + subscriptions tables
    client.ts         postgres-js connection pool + drizzle instance
  middleware/auth.ts  Clerk Bearer-token verification (request.userId)
  routes/
    health.ts         GET /healthz, /readyz, /v1/meta
    me.ts             GET /v1/me
    subscriptions.ts  full CRUD (ownership enforced in SQL)
    webhooks.ts       POST /api/webhooks/clerk (svix-signed)
```

## Local setup

Prereqs: Node ≥ 22, Docker Desktop (running), a [Clerk](https://dashboard.clerk.com) app.

```bash
# 1. Install deps (already done if you cloned with node_modules)
npm install

# 2. Configure env — copy and fill in Clerk keys
cp .env.example .env
#    CLERK_SECRET_KEY=sk_test_...   (dashboard -> API Keys)
#    CLERK_WEBHOOK_SECRET=whsec_... (dashboard -> Webhooks -> create endpoint)
#    DATABASE_URL can stay default (matches docker-compose)

# 3. Start Postgres (Docker Desktop must be running first!)
docker compose up -d db

# 4. Create tables
npm run db:migrate

# 5. Run the API (hot reload)
npm run dev
```

The server listens on **http://localhost:8080**.

## Test runbook

| Command | Expect |
|---|---|
| `curl http://localhost:8080/healthz` | `{"status":"ok"}` |
| `curl http://localhost:8080/readyz` | `{"status":"ok"}` (DB reachable; `503` otherwise) |
| `curl http://localhost:8080/v1/meta` | `{ version, currencies, categories }` |
| `curl http://localhost:8080/v1/subscriptions` | `401 {"message":"Missing bearer token."}` |
| `curl -X POST http://localhost:8080/v1/subscriptions -H 'content-type: application/json' -d '{"name":"Netflix","cost":649}'` | `400` with a validation message (missing currency/cycle/date) |
| `curl http://localhost:8080/v1/me` with a real Clerk token | `200` with `{ id, email, isPro }` |

To exercise authenticated routes you need a valid **Clerk session token** from your app (the mobile app sends it automatically once wired up). Then:

```bash
curl -H "Authorization: Bearer <session-token>" http://localhost:8080/v1/subscriptions
curl -H "Authorization: Bearer <session-token>" \
     -X POST http://localhost:8080/v1/subscriptions \
     -H 'content-type: application/json' \
     -d '{"name":"Netflix","cost":649,"currency":"INR","billingCycle":"monthly","nextRenewalDate":"2026-09-01T10:00:00.000Z"}'
```

**Watch out for:**
- **401 vs 500 on protected routes.** `401` = bad/missing token; `500 {"message":"Authentication is not configured..."}` means `CLERK_SECRET_KEY` isn't set in `.env` — the skeleton intentionally boots without it so you can dev the parts that don't need auth, but protected routes refuse to run.
- **Timezone round-trip.** `nextRenewalDate` is a full ISO instant, stored as `timestamptz` and returned via `toISOString()`. The mobile app groups renewals by its *local* calendar day, so the exact instant must round-trip — don't truncate to a date anywhere.
- **Port conflicts.** If 8080 is taken, set `PORT` in `.env`.
- **Migrations changed?** After editing `src/db/schema.ts`, run `npm run db:generate` then `npm run db:migrate`. Or browse with `npm run db:studio`.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | – | Liveness |
| GET | `/readyz` | – | Readiness (DB check) |
| GET | `/v1/meta` | – | App constants (currencies, categories) |
| GET | `/v1/me` | ✔ | Current user + `isPro` |
| GET | `/v1/subscriptions` | ✔ | List (user-scoped) |
| POST | `/v1/subscriptions` | ✔ | Create |
| GET | `/v1/subscriptions/:id` | ✔ | Read one |
| PATCH | `/v1/subscriptions/:id` | ✔ | Partial update |
| POST | `/v1/subscriptions/:id/pause` | ✔ | Pause (sets `status='paused'`) |
| POST | `/v1/subscriptions/:id/resume` | ✔ | Resume (sets `status='active'`) |
| GET | `/v1/subscriptions/:id/payments` | ✔ | Charge history (backfilled on create/update) |
| GET | `/v1/analytics/spend-trend` | ✔ | Last 12 months of spend `{ months, totals }` |
| DELETE | `/v1/subscriptions/:id` | ✔ | Delete (204) |
| DELETE | `/v1/account` | ✔ | Delete account + all data (fires Clerk `user.delete`) |
| POST | `/api/webhooks/clerk` | svix-signed | User create/update/delete sync |
| POST | `/api/webhooks/revenuecat` | Bearer-signed | Pro entitlement sync (`users.pro_until`) |

## Deploy

The app is a plain container — deploy anywhere:

```bash
# build & run the production image (Postgres included via compose)
docker compose up -d --build
```

Recommended for $0: **Oracle Cloud Always Free ARM VM (2 OCPU / 12 GB) + Coolify** (open-source PaaS) — Coolify builds from this Dockerfile, provisions TLS via Caddy, and watches `/readyz`. Same image runs on Fly.io, Railway, Render, or a $5 VPS if you'd rather not self-manage. See `docs/backend-prd.md` for the full rationale.

Deploy checklist:
1. Set real `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `DATABASE_URL`, `CORS_ORIGINS`.
2. Point Clerk's webhook at `https://<your-domain>/api/webhooks/clerk`.
3. Run migrations against prod (`npm run db:migrate` with prod `DATABASE_URL`).
4. Wire the mobile app: `EXPO_PUBLIC_API_URL=https://<your-domain>` + switch to the Clerk flow (`EXPO_PUBLIC_USE_MOCK_API=false`).

## Scripts

```bash
npm run dev            # tsx watch (hot reload)
npm run build          # tsc -> dist/
npm start              # node dist/index.js
npm run typecheck      # tsc --noEmit
npm run db:generate    # new migration from schema changes
npm run db:migrate     # apply migrations
npm run db:studio      # Drizzle Studio (DB browser)
```
