# Production image for Dokploy (replaces the systemd/Nginx flow in deploy/
# when the VPS is managed by Dokploy). Dev dependencies are kept on purpose:
# the Prisma CLI (migrate deploy) and tsx (seed) run inside this container.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@11.5.3 --activate

WORKDIR /app

# tsconfig.json must be present before `prisma generate`: Prisma infers the
# generated client's import extension (.js vs .ts) from it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
# prisma.config.ts requires DATABASE_URL even for `prisma generate`
# (postinstall); the real value is injected by Dokploy at runtime.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3000
# CLIENT IP BEHIND DOKPLOY (docs/deployment.md 17.8): Next and this container are different peers, so
# the default `trust proxy loopback` IGNORES X-Forwarded-For and every client looks like the Next
# container (one shared rate-limit bucket, wrong IP in every audit event). Set, in Dokploy's
# environment, TRUST_PROXY to the NARROW subnet of the network shared with Next, and have Next call this
# container by a name that exists ONLY on that network (never 0.0.0.0/0; avoid 172.16.0.0/12 / 10.0.0.0/8).
# The container must listen on all interfaces (HOST stays unset); do not publish this port: only Next
# reaches it (Traefik too, for the Stripe webhook only, through a network that TRUST_PROXY does not cover).
# At boot the app logs a WARN when TRUST_PROXY is unset in production and HOST is not loopback.
EXPOSE 3000

# Migrations run as a separate command right before the app starts (single
# replica, so no concurrent migrators).
CMD ["sh", "-c", "pnpm prisma:deploy && node dist/main"]
