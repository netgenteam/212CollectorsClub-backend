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
EXPOSE 3000

# Migrations run as a separate command right before the app starts (single
# replica, so no concurrent migrators).
CMD ["sh", "-c", "pnpm prisma:deploy && node dist/main"]
