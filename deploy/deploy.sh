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

# Epic 12: the service does not boot without CUSTOMER_AUTH_SECRET; fail the
# deploy early instead of crash-looping after the restart.
for var in CUSTOMER_AUTH_SECRET; do
  grep -Eq "^${var}=.+" "$ENV_FILE" || fail "$var is missing in $ENV_FILE — see docs/deployment.md §1.5"
done
for var in ADMIN_AUTH_SECRET FRONTEND_URL; do
  grep -Eq "^${var}=.+" "$ENV_FILE" || log "WARNING: $var is not set in $ENV_FILE — see docs/deployment.md §1.5"
done

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
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is missing in $ENV_FILE"

# Story 20.1 (A90): migrations run as the database OWNER (MIGRATE_DATABASE_URL),
# the service as the least-privilege app role (DATABASE_URL). Without
# MIGRATE_DATABASE_URL both are the same role (the pre-20.1 setup). The migration
# CLI below always sees the owner's URL; the service keeps its own, unmodified.
MIGRATE_BASE_URL="${MIGRATE_DATABASE_URL:-$DATABASE_URL}"

# Bound the time the migration may WAIT for a table lock (default 10 s) so a
# DDL never queues behind a long transaction and, in turn, blocks every query
# on that table (docs/deployment.md §12.2). `SET LOCAL lock_timeout` inside a
# migration file and `PGOPTIONS` are NOT honoured by `prisma migrate deploy`
# (verified on a database clone, Story 19.4a); the `options` connection
# parameter is. It is added to the CLI's DATABASE_URL only: the service keeps
# its own, unmodified one.
MIGRATE_LOCK_TIMEOUT_MS="${MIGRATE_LOCK_TIMEOUT_MS:-10000}"
case "$MIGRATE_LOCK_TIMEOUT_MS" in
  ''|*[!0-9]*) fail "MIGRATE_LOCK_TIMEOUT_MS must be a number of milliseconds (got '$MIGRATE_LOCK_TIMEOUT_MS')" ;;
esac
case "$MIGRATE_BASE_URL" in
  *options=*) fail "the migration URL (MIGRATE_DATABASE_URL, or DATABASE_URL when it is unset) already carries an 'options' parameter; set lock_timeout there or remove it (docs/deployment.md §12.2)" ;;
  *\?*) MIGRATE_URL_SEP='&' ;;
  *) MIGRATE_URL_SEP='?' ;;
esac
# The output is captured (not streamed) so that (1) the failure can be told
# apart and explained truthfully and (2) what is shown is filtered first:
# every URL-looking string and Prisma's "Datasource ..." line (which names
# the database user, host and port) are redacted. This is best effort, not a
# guarantee: any other line Prisma or Postgres prints is shown as is.
redact() {
  sed -E \
    -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]"'"'"']+#<redacted-url>#g' \
    -e 's#^(Datasource ).*#\1<redacted>#'
}
MIGRATE_OUT="$(mktemp)"
trap 'rm -f "$MIGRATE_OUT"' EXIT
if MIGRATE_DATABASE_URL="${MIGRATE_BASE_URL}${MIGRATE_URL_SEP}options=-c%20lock_timeout%3D${MIGRATE_LOCK_TIMEOUT_MS}" pnpm prisma:deploy >"$MIGRATE_OUT" 2>&1; then
  redact <"$MIGRATE_OUT"
else
  redact <"$MIGRATE_OUT" >&2
  # Classify by what Prisma/Postgres actually reported, never assume a cause.
  if grep -Eq '55P03|lock timeout|lock_not_available' "$MIGRATE_OUT"; then
    why="the migration waited for a table lock longer than ${MIGRATE_LOCK_TIMEOUT_MS} ms (SQLSTATE 55P03)"
    todo="a failed migration is now recorded: follow docs/deployment.md section 12.3 (clean up the objects the migration left half-created, THEN 'pnpm prisma migrate resolve --rolled-back <migration_name>', then deploy again outside peak hours)"
  elif grep -q 'P3009' "$MIGRATE_OUT"; then
    why="a previous migration is recorded as failed (P3009), so Prisma refuses to apply anything else; this run did not wait for any lock"
    todo="run 'pnpm prisma migrate status' and follow docs/deployment.md section 12.3: clean up what the failed migration left half-created, then 'pnpm prisma migrate resolve --rolled-back <migration_name>'"
  elif grep -Eq '23505|unique constraint' "$MIGRATE_OUT"; then
    why="a statement of the migration violated a unique constraint (23505, e.g. data that already holds duplicates); this is NOT a lock wait and NOT a leftover object"
    todo="see the (redacted) Prisma output above, fix the data, then follow docs/deployment.md section 12.3 if a migration is recorded as failed"
  elif grep -Eq '42710|42P07|(type|relation|index|constraint|column|trigger|function|schema|sequence|table|extension) "[^"]+"( (of|for) relation "[^"]+")? already exists' "$MIGRATE_OUT"; then
    why="an object the migration creates already exists (42710/42P07), typically left half-created by an earlier failed attempt; this is NOT a lock wait"
    todo="follow docs/deployment.md section 12.3: drop the leftover objects of that migration, check with 'pnpm prisma migrate status', then retry"
  elif grep -q 'current transaction is aborted' "$MIGRATE_OUT"; then
    why="a statement inside the migration's own BEGIN/COMMIT failed; Prisma does not report the original error in that mode (a lock wait is the usual cause: look for it in the Postgres log). The transaction was rolled back, so nothing is left half-applied"
    todo="'pnpm prisma migrate resolve --rolled-back <migration_name>' (no object cleanup needed, docs/deployment.md section 12.3), then deploy again outside peak hours"
  else
    why="prisma migrate deploy failed for a reason other than a lock wait; see the (redacted) Prisma output above"
    todo="fix the cause shown above; if a migration is recorded as failed, see docs/deployment.md section 12.3"
  fi
  fail "prisma migrate deploy failed: ${why}. The service was NOT restarted (the previous build keeps running). Next: ${todo}."
fi

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
