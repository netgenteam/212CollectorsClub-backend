# 212CollectorsClub — Backend

NestJS + Prisma + PostgreSQL API for 212CollectorsClub. See `../docs/architecture.md`
and `../docs/stories/` in the parent repo for the full architecture and story backlog.

## Stack

- NestJS ^12.x, TypeScript ^6.x
- Prisma ^7.x / `@prisma/client` ^7.x (driver-adapter based, via `@prisma/adapter-pg`)
- PostgreSQL 17.x
- ESLint + Prettier, Vitest

## Prerequisites

- Node.js (see `package.json` engines / `.nvmrc` if present) and **pnpm** (never npm/yarn)
- Docker + Docker Compose, for local PostgreSQL

## Setup

```bash
pnpm install
cp .env.example .env   # then edit values if needed
docker compose up -d   # starts a dedicated Postgres on host port 5433
pnpm prisma:migrate    # applies migrations to your local DB
pnpm prisma:seed       # populates mock catalog data (Categories/Products/Images)
pnpm start:dev
```

Every route is served under a single versioned prefix, `/api/v1` (global prefix `api` +
URI versioning, default version `1` — no unversioned route is ever exposed). For example,
`GET /api/v1/health` returns `200` with `{"status":"ok","database":"up",...}` once the app
can reach PostgreSQL, and `503` if it cannot — this is a real liveness check, not a static 200.

Live, browsable API docs (OpenAPI/Swagger, generated from `@nestjs/swagger` decorators on
controllers/DTOs — never hand-maintained) are served at `GET /api/docs`, with the raw
OpenAPI JSON at `GET /api/docs-json`. Any new endpoint or DTO field added with proper
decorators appears there automatically on next boot.

## Environment variables

All runtime configuration is read exclusively via `@nestjs/config` from environment
variables — see `.env.example` for the full documented list. `.env` is git-ignored and
must never contain committed secrets.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm start:dev` | Run the app in watch mode |
| `pnpm build` | Compile to `dist/` |
| `pnpm lint` | ESLint, zero warnings/errors allowed |
| `pnpm lint:fix` | ESLint with autofix |
| `pnpm test` / `pnpm test:e2e` | Vitest unit / e2e tests |
| `pnpm prisma:generate` | Regenerate the Prisma client (also runs on `postinstall`) |
| `pnpm prisma:migrate` | `prisma migrate dev` (local dev only) |
| `pnpm prisma:deploy` | `prisma migrate deploy` (CI/CD — never run automatically at app boot) |
| `pnpm prisma:seed` | Runs `prisma/seed.ts` (mock catalog data), via `tsx` |

## Project structure

`src/` is organized by feature module per the architecture's structural seed:
`catalog/`, `cart/`, `checkout/`, `payments-paypal/`, `payments-pago-movil/`, `orders/`,
`contact/`, `admin-auth/`, `admin-catalog/`, `admin-landing/`, `common/`, `prisma/`.
Most are still empty scaffolds (`.gitkeep`) — they're filled in by later stories.

## Catalog schema & seed data (Story 1.4)

The Catalog domain (`prisma/schema.prisma`) defines:

- **`Category`** — admin-managed grouping table (`Categories`), independent of the enums
  below (AD-2). `id`, `name`, `slug` (unique), timestamps.
- **`Product`** (`Products`) — `franchise`/`productType`/`rarity` are native Postgres enums
  (`Franchise`, `ProductType`, `Rarity`) defined once in the schema, never per-module string
  constants (AD-2). `priceUsd` is `Decimal(10,2)` (USD-canonical, per AD-3). `stock Int` and
  `heldQty Int @default(0)` (placeholder for Epic 4's stock-hold feature, added now so that
  epic doesn't need to alter `Product` again). Many-to-one to `Category` (deleting a
  `Category` still referenced by a `Product` is rejected at the DB level — `ON DELETE
  RESTRICT` — matching the architecture's `409 CATEGORY_IN_USE` policy, enforced at the
  service layer once Epic 8's admin CRUD lands).
- **`ProductImage`** (`Product_Images`) — one-to-many from `Product` (`ON DELETE CASCADE`),
  `url`, optional `altText`, `sortOrder`.

Migrations are applied exclusively via `prisma migrate dev|deploy` (AD-1) — this story's
migration is `prisma/migrations/20260923034725_add_catalog_schema/`.

**Seed data** (`prisma/seed.ts`, run with `pnpm prisma:seed`) populates 10 mock Products
across 4 Franchises (Pokémon, One Piece, Magic: The Gathering, Yu-Gi-Oh!), 5 Product Types,
and 6 Rarities, their 4 Categories, and 13 Product Images (every Product has at least one).

**Idempotency strategy:** every seeded row carries a fixed, hardcoded `id` and is written
with `upsert` keyed on that `id` — never a bare `create`. Re-running `pnpm prisma:seed`
against an already-seeded database updates those same rows in place instead of inserting
duplicates. This was chosen over a "delete catalog tables, then reinsert" reset because it's
safer to re-run unattended (e.g. from a CI/deploy step) and needs no FK-ordering cleanup on
the way down. Verified during implementation: running the seed twice in a row left row
counts unchanged (Categories=4, Products=10, ProductImages=13 both times).

## Local PostgreSQL (docker-compose)

A dedicated `postgres:17-alpine` container (`212collectorsclub-postgres`) is defined in
`docker-compose.yml`, bound to host port **5433** (not 5432, to avoid clashing with any
other Postgres instance already running on the host) and backed by a named volume for
persistence. It is scoped to this project only.
