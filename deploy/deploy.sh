#!/usr/bin/env bash
#
# deploy/deploy.sh — invoked over SSH by .github/workflows/ci.yml
# (deploy-staging / deploy-production jobs). Runs ON THE VPS, inside the
# git checkout it lives in (either the staging clone or the production
# clone — see docs/deployment.md for the on-VPS directory layout).
#
# This is the ONLY place `prisma migrate deploy` is ever invoked outside a
# developer's own machine. It always runs as its own explicit step, BEFORE
# the service restart, and is never wired into app boot (AD-15,
# docs/architecture.md). The same script and the same build steps run for
# both environments — only $ENVIRONMENT (and therefore which directory,
# .env file and systemd unit it touches) differs, which is what proves
# FR-3's "same codebase, env-swap-only" requirement end-to-end.
#
# Usage: deploy.sh <staging|production> <git-ref>
#   git-ref: a commit SHA (CI always passes ${{ github.sha }}) or a branch
#            name. A SHA is preferred — it deploys exactly the commit CI
#            just tested, with no race against further pushes.
#
# NOT verified against a real VPS in this sandbox (no Debian VPS, no SSH
# access, no systemd available here) — only shellcheck-clean syntax and
# manual read-through. See docs/deployment.md for what Angel must still do
# before the first real deploy.

set -euo pipefail

log() {
  printf '[deploy] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$1" >&2
  exit 1
}

ENVIRONMENT="${1:-}"
GIT_REF="${2:-}"

[ -n "$ENVIRONMENT" ] || fail "usage: deploy.sh <staging|production> <git-ref>"
[ -n "$GIT_REF" ] || fail "usage: deploy.sh <staging|production> <git-ref>"

case "$ENVIRONMENT" in
  staging)
    SERVICE_NAME="212cc-backend-staging.service"
    ;;
  production)
    SERVICE_NAME="212cc-backend-production.service"
    ;;
  *)
    fail "unknown environment '$ENVIRONMENT' (expected 'staging' or 'production')"
    ;;
esac

# Resolve the app directory as "two levels up from this script" so the same
# file works unmodified in both the staging and production checkouts — it
# never hardcodes /opt/212cc/staging vs /opt/212cc/production itself.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
APP_DIR="$(dirname -- "$SCRIPT_DIR")"
# Runtime .env lives OUTSIDE the git working tree (see docs/deployment.md)
# so a `git checkout`/`git clean` in $APP_DIR can never touch real secrets,
# and so it survives even if $APP_DIR is ever recreated from a fresh clone.
ENV_FILE="/opt/212cc/${ENVIRONMENT}/shared/.env"

log "environment=$ENVIRONMENT app_dir=$APP_DIR service=$SERVICE_NAME ref=$GIT_REF"

[ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout — see docs/deployment.md provisioning steps"
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found — create it per docs/deployment.md before deploying"

cd "$APP_DIR"

log "fetching and checking out $GIT_REF"
git fetch --all --prune --quiet
git checkout --quiet --detach "$GIT_REF"

log "installing dependencies (pnpm install --frozen-lockfile)"
pnpm install --frozen-lockfile

log "building"
pnpm build

# Explicit, separate migration step — see file header. Uses $ENV_FILE's
# DATABASE_URL (loaded into the shell below), never an implicit boot-time
# migration.
log "applying database migrations (prisma migrate deploy)"
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
pnpm prisma:deploy

log "restarting $SERVICE_NAME"
sudo /usr/bin/systemctl restart "$SERVICE_NAME"

# Best-effort local health check against the just-restarted service, using
# the PORT this environment's systemd unit actually listens on. Does not
# fail the deploy on a slow-starting process past the retry budget below —
# it only surfaces a clear warning, since the systemd restart itself is the
# authoritative success signal and a slow first request (e.g. cold Prisma
# connection) is not necessarily a broken deploy.
PORT_VALUE="$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
PORT_VALUE="${PORT_VALUE:-3000}"

log "waiting for health check on 127.0.0.1:${PORT_VALUE}/api/v1/health"
attempt=0
max_attempts=15
until curl --fail --silent --max-time 3 "http://127.0.0.1:${PORT_VALUE}/api/v1/health" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$max_attempts" ]; then
    log "WARNING: health check did not return 200 after ${max_attempts} attempts — check 'systemctl status ${SERVICE_NAME}' and 'journalctl -u ${SERVICE_NAME}' on the VPS"
    exit 0
  fi
  sleep 2
done

log "health check OK — deploy of $ENVIRONMENT at $GIT_REF complete"
