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
pnpm start:dev
```

`GET /health` returns `200` with `{"status":"ok","database":"up",...}` once the app can
reach PostgreSQL, and `503` if it cannot — this is a real liveness check, not a static 200.

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

## Project structure

`src/` is organized by feature module per the architecture's structural seed:
`catalog/`, `cart/`, `checkout/`, `payments-paypal/`, `payments-pago-movil/`, `orders/`,
`contact/`, `admin-auth/`, `admin-catalog/`, `admin-landing/`, `common/`, `prisma/`.
Most are still empty scaffolds (`.gitkeep`) — they're filled in by later stories.

## Local PostgreSQL (docker-compose)

A dedicated `postgres:17-alpine` container (`212collectorsclub-postgres`) is defined in
`docker-compose.yml`, bound to host port **5433** (not 5432, to avoid clashing with any
other Postgres instance already running on the host) and backed by a named volume for
persistence. It is scoped to this project only.
