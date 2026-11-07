# Production image for Dokploy (replaces the systemd/Nginx flow in deploy/
# when the VPS is managed by Dokploy). Dev dependencies are kept on purpose:
# the Prisma CLI (migrate deploy) and tsx (seed) run inside this container.
# Story 20.11: the base image is pinned by DIGEST (the multi-arch index of `node:24-slim`, resolved 2026-11-06), so a
# retagged or compromised `24-slim` can never reach a build. To bump it on purpose:
#   docker buildx imagetools inspect node:24-slim --format '{{.Manifest.Digest}}'
# (or the Docker Hub API: GET /v2/library/node/manifests/24-slim, header Docker-Content-Digest) and paste the result here
# and in the frontend Dockerfile. Dependabot/Renovate can do it if enabled.
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# Story 20.11: corepack keeps pnpm in a SYSTEM directory readable by every user: the image runs as `node`, and the
# default cache (root's home) would make `pnpm prisma:deploy` try to download pnpm at start (no network, or a surprise).
ENV COREPACK_HOME=/usr/local/share/corepack
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@11.5.3 --activate \
  && chmod -R a+rX /usr/local/share/corepack

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

# Story 20.11: the service runs as `node` (uid 1000), never as root. The ONLY place the app writes is `uploads/`
# (product and landing images in `uploads/public/`, proofs of payment in `uploads/private/`): create it owned by
# `node`. A named volume mounted on /app/uploads inherits this owner the first time it is created; a bind mount
# keeps the host's owner: `chown -R 1000:1000 <host dir>` (docs/deployment.md 23). Everything else under /app stays
# root-owned and read-only for the process (code, node_modules, .prisma): a compromised app cannot rewrite its own code.
RUN mkdir -p uploads/public uploads/private && chown -R node:node uploads

ENV NODE_ENV=production
ENV PORT=3005
# CLIENT IP BEHIND DOKPLOY (docs/deployment.md 17.8): Next and this container are different peers, so
# the default `trust proxy loopback` IGNORES X-Forwarded-For and every client looks like the Next
# container (one shared rate-limit bucket, wrong IP in every audit event). Set, in Dokploy's
# environment, TRUST_PROXY to the NARROW subnet of the network shared with Next, and have Next call this
# container by a name that exists ONLY on that network (never 0.0.0.0/0; avoid 172.16.0.0/12 / 10.0.0.0/8).
# The container must listen on all interfaces (HOST stays unset); do not publish this port: only Next
# reaches it (Traefik too, for the Stripe webhook only, through a network that TRUST_PROXY does not cover).
# At boot the app logs a WARN when TRUST_PROXY is unset in production and HOST is not loopback.
EXPOSE 3005

# Story 20.11: the migration is NOT part of the service's CMD any more. A service that runs `prisma migrate deploy` at
# every start gives the app process the DDL-capable (owner) URL and races with every other replica or restart. Run it
# as its own one-shot step BEFORE the service starts, from this same image:
#     pnpm prisma:deploy            (reads MIGRATE_DATABASE_URL, else DATABASE_URL)
# Dokploy (compose): the `migrate` service of docs/deployment.md 17.8, which `backend` waits for
# (`depends_on: condition: service_completed_successfully`). Dokploy (Application type): a pre-deploy command.
# systemd VPS: deploy/deploy.sh (it has always migrated as its own step). See docs/deployment.md 23.
#
# `exec` / no shell is load-bearing (Story 20.7): node is PID 1 (exec form, no `sh`), so SIGTERM reaches it and the
# app runs its shutdown (usage-log flush, HTTP drain, pool close) instead of waiting for `docker stop`'s SIGKILL
# (exit 137). Also run the container with an init (`init: true` in compose, `docker run --init`) so zombies are
# reaped (docs/deployment.md 17.8 and 22).
USER node
CMD ["node", "dist/main"]
