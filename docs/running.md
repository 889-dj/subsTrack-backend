# Running subsTrack backend

The same backend supports three execution modes. Docker is optional; every mode
uses the same API contract and PostgreSQL migrations.

## What you need

| Requirement | No Docker: Node + Neon | Docker: full local stack | Needed for |
|---|---|---|---|
| Node.js 22+ and npm | Required | Not required inside Docker | Building/running the API locally |
| PostgreSQL | Neon free pooled `DATABASE_URL` | Included as PostgreSQL 16 | All persistent app data |
| Docker Desktop/Engine | Not required | Required | Containerized API and local database |
| Clerk publishable key | Required in the mobile app | Required in the mobile app | Real signup/login |
| `CLERK_SECRET_KEY` | Required for protected API routes | Same | JWT verification and user reconciliation |
| `CLERK_WEBHOOK_SECRET` | Optional for basic local CRUD | Same | Testing Clerk user webhooks |
| RevenueCat public platform keys | Optional for CRUD | Same | Store purchase UI and SDK |
| RevenueCat webhook + REST secrets | Optional for CRUD | Same | Server Pro projection and complete account deletion |
| Public HTTPS tunnel | Optional | Optional | Receiving Clerk/RevenueCat webhooks on a local machine |
| Git provider account | Hosting only | Hosting only | Render/Koyeb deployment |

You can test `/healthz`, `/readyz`, and `/v1/meta` without Clerk. Keep the mobile
app in mock mode until both Clerk keys are configured; protected routes reject
requests without a valid Clerk session.

## Path A: no Docker, hosted Neon database

1. Create a Neon PostgreSQL project and copy its **pooled** connection string.
2. Configure and run the backend:

```bash
cd /Users/jayashankar/Desktop/substrack-app/subsTrack-backend
npm install
cp .env.example .env
```

Set at minimum:

```dotenv
DATABASE_URL=postgresql://...-pooler.../dbname?sslmode=require
PORT=8080
LOG_PRETTY=true
```

Then:

```bash
npm run db:migrate
npm run dev
```

For authenticated mobile testing, also set `CLERK_SECRET_KEY` in the backend
and set the following in the mobile app's `.env.local`:

```dotenv
EXPO_PUBLIC_USE_MOCK_API=false
EXPO_PUBLIC_API_URL=http://localhost:8080/v1
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
```

Restart Metro after changing Expo public variables.

## Path B: Docker for PostgreSQL, Node API on the host

This gives hot reload while keeping only PostgreSQL in Docker:

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run db:migrate
npm run dev
```

Keep the default local `DATABASE_URL` from `.env.example`.

## Path C: complete Docker stack

Create `.env` from `.env.example`, add available service keys, then run:

```bash
docker compose up --build
```

Compose waits for PostgreSQL, runs every checked-in migration exactly once,
then starts the API. Stop it with:

```bash
docker compose down
```

Database data remains in the named `pgdata` volume. To intentionally remove
that local database as well, use `docker compose down -v` only when its loss is
acceptable.

## Verify any local mode

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
curl http://localhost:8080/v1/meta
```

Expected: HTTP 200 from all three. `/readyz` proves the database is reachable.

## Free hosted preview: Render API + Neon PostgreSQL

The checked-in `render.yaml` deploys the API with Render's native Node runtime;
Docker is not required. In Render:

1. Create a Blueprint from this repository's `render.yaml`.
2. Enter every secret requested by the Blueprint.
3. Use Neon's pooled connection string for `DATABASE_URL`.
4. Set `CORS_ORIGINS` to the allowed Expo web origin, or to your planned web
   domain. Native iOS/Android requests do not use browser CORS.
5. After deployment, verify `https://<service>.onrender.com/readyz`.

The start command applies checked-in migrations before serving requests. Render
Free and Neon Free are suitable for development and a small preview, not an SLA
or a high-traffic production launch.

## Moving providers later

The API is stateless and its data is standard PostgreSQL. Keep a custom domain
such as `api.substrack.app` in front of the API. Moving the Node service then
only changes that domain's destination. A future database move can use standard
PostgreSQL dump/restore or logical replication for low downtime; no mobile
screen or API-contract rewrite is required.
