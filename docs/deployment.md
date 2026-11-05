# Deployment — CI/CD, Staging & Production (Story 1.3)

> **Status: code/config only, not exercised against a real VPS.** Everything
> in this document and in `.github/workflows/ci.yml` / `deploy/` was written
> and verified from a sandbox with no Debian VPS, no SSH access, and no
> GitHub Actions secrets configured. What was actually checked — and what
> was not — is listed at the bottom of this file, under "Verification
> status". Angel must complete the provisioning steps below and confirm one
> real manual deploy before trusting this pipeline for a real release.

## Architecture recap (AD-15, `docs/architecture.md`)

- Two systemd services on **one** Debian VPS: `212cc-backend-staging` and
  `212cc-backend-production`, each its own OS user, own directory, own
  `.env`, own PostgreSQL database.
- Nginx routes by subdomain: `staging-api.<domain>` → staging service,
  `api.<domain>` → production service.
- `prisma migrate deploy` runs as an explicit, separate CI/CD step, before
  the service restart — never implicitly at app boot.
- `develop` branch → staging. `main` branch → production. Same build, same
  `deploy/deploy.sh` script, only the environment/branch differs — this is
  what proves FR-3's "same codebase, env-swap-only" requirement.

## On-VPS directory layout (fixed convention, referenced by the workflow, the systemd units and `deploy/deploy.sh`)

```
/opt/212cc/staging/
  app/            <- git clone of this repo (what deploy.sh calls $APP_DIR)
  shared/.env     <- persistent secrets/config, outside the git working tree

/opt/212cc/production/
  app/
  shared/.env
```

Keeping `shared/.env` outside `app/` means `git fetch`/`git checkout` inside
`deploy/deploy.sh` can never touch it, and it survives even if `app/` is
ever re-cloned from scratch.

## 1. Provisioning the Debian VPS (Angel / Net Gen, one-time)

All commands below run as root or via `sudo` on the VPS unless noted.

### 1.1 Base packages

```bash
apt update && apt install -y git nginx postgresql ufw curl
# Node.js: install SYSTEM-WIDE (not per-user via nvm) — systemd services
# don't source shell rc files, so a per-user nvm install won't be found by
# ExecStart. Use NodeSource's Node 24.x repo (or your org's standard
# system-wide Node install method) so `/usr/bin/node` (or wherever it
# lands — confirm with `which node`) exists for every user, including the
# dedicated service users created below.
corepack enable   # makes `pnpm` available system-wide once Node is installed
```

Confirm the real Node binary path (`which node`) and update `ExecStart=` in
both `deploy/systemd/212cc-backend-*.service` files if it isn't
`/usr/bin/node`.

### 1.2 PostgreSQL — two databases, two users

```bash
sudo -u postgres psql <<'SQL'
CREATE USER collectorsclub_staging WITH PASSWORD 'REPLACE_ME_STAGING';
CREATE DATABASE collectorsclub_staging OWNER collectorsclub_staging;

CREATE USER collectorsclub_production WITH PASSWORD 'REPLACE_ME_PRODUCTION';
CREATE DATABASE collectorsclub_production OWNER collectorsclub_production;
SQL
```

Use strong, distinct, randomly-generated passwords — never reuse the local
dev placeholder from `docker-compose.yml`/`.env.example`.

### 1.3 Dedicated OS users (one per environment, isolation per AD-15)

```bash
useradd --system --create-home --home-dir /opt/212cc/staging \
  --shell /usr/sbin/nologin cc212-staging
useradd --system --create-home --home-dir /opt/212cc/production \
  --shell /usr/sbin/nologin cc212-production

mkdir -p /opt/212cc/staging/shared /opt/212cc/production/shared
chown -R cc212-staging:cc212-staging /opt/212cc/staging
chown -R cc212-production:cc212-production /opt/212cc/production
```

### 1.4 Clone the repo into each environment

```bash
sudo -u cc212-staging git clone git@github.com:netgenteam/212CollectorsClub-backend.git /opt/212cc/staging/app
sudo -u cc212-production git clone git@github.com:netgenteam/212CollectorsClub-backend.git /opt/212cc/production/app
```

(Needs a deploy key or the VPS's own GitHub access configured first — a
one-time manual step, independent of the GitHub Actions SSH keys in §3.)

### 1.5 `.env` files — one per environment, outside the git tree

`/opt/212cc/staging/shared/.env`:

```env
NODE_ENV=staging
PORT=3001
DATABASE_URL="postgresql://collectorsclub_staging:REPLACE_ME_STAGING@localhost:5432/collectorsclub_staging?schema=public"
```

`/opt/212cc/production/shared/.env`:

```env
NODE_ENV=production
PORT=3000
DATABASE_URL="postgresql://collectorsclub_production:REPLACE_ME_PRODUCTION@localhost:5432/collectorsclub_production?schema=public"
```

Both files must also define the auth secrets and the storefront URL (the
service refuses to boot without `CUSTOMER_AUTH_SECRET`):

```env
# Signs admin sessions (Story 12.2). Falls back to the legacy
# ADMIN_JWT_SECRET if unset. Use `openssl rand -hex 32`.
ADMIN_AUTH_SECRET=REPLACE_ME
# Signs the customer cookie `cc_session` (Story 12.3). REQUIRED, no fallback,
# and it MUST differ from ADMIN_AUTH_SECRET and COOKIE_SECRET (admin and
# customer sessions are strictly separated, FR-41).
CUSTOMER_AUTH_SECRET=REPLACE_ME
# Public storefront URL used in verification / password-reset email links
# (Story 12.4), e.g. https://212collectorsclub.com (staging: its own URL).
FRONTEND_URL=https://REPLACE_ME
# TEMPORARY - remove with real SMTP (Story 13.1, FR-53). `true` enables
# POST /api/v1/admin/customers/verify-email (admin marks a customer's email
# verified by hand); anything else = route 404s. Set to false/unset once SMTP works.
MANUAL_EMAIL_VERIFY_ENABLED=false
# Stripe (Epic 14, see section 7). Keep BOTH empty to run on the in-memory
# fake client; with a real key STRIPE_WEBHOOK_SECRET is mandatory.
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

Set ownership/permissions so only the matching service user (and root) can
read them: `chown cc212-staging:cc212-staging /opt/212cc/staging/shared/.env && chmod 600 ...` (same pattern for production).

As later stories add further keys (SMTP credentials, Stripe keys, etc.), they get appended
to these same two files — never committed, never templated into the repo.

> **PayPal removal (Story 14.6, AD-49):** PayPal is no longer supported; its webhook `POST /api/v1/payments/paypal/webhook` is gone (404).
> The migration `20261019110000_remove_paypal` aborts with `PAYPAL_REMOVAL_ABORTED` if any PayPal Order or history row still exists.
> If it aborts: delete or archive those PayPal rows (see section 7.6), then re-run `pnpm prisma:deploy`.

### 1.6 systemd units

```bash
cp deploy/systemd/212cc-backend-staging.service /etc/systemd/system/
cp deploy/systemd/212cc-backend-production.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable 212cc-backend-staging.service 212cc-backend-production.service
# Don't start yet — there's no build in app/dist until the first deploy
# (§4) runs `pnpm build`. Starting now would just crash-loop.
```

### 1.7 Nginx

```bash
cp deploy/nginx/staging-api.conf.template /etc/nginx/sites-available/staging-api.<DOMAIN>.conf
cp deploy/nginx/api.conf.template /etc/nginx/sites-available/api.<DOMAIN>.conf
# Edit both files: replace every <DOMAIN> with the real domain.
ln -s /etc/nginx/sites-available/staging-api.<DOMAIN>.conf /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/api.<DOMAIN>.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Point `staging-api.<domain>` and `api.<domain>` DNS A/AAAA records at the
VPS, then issue TLS certs:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d staging-api.<DOMAIN> -d api.<DOMAIN>
```

### 1.8 Firewall

The app itself binds to all interfaces by default (`app.listen(port)` in
`src/main.ts` passes no host — this was not changed by this story, since
touching application code was out of scope). That means **the VPS firewall,
not the app, is what keeps port 3000/3001 from being reachable directly**,
bypassing Nginx/TLS entirely:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'   # 80 + 443
ufw default deny incoming
ufw enable
# Explicitly do NOT allow 3000/3001 from the public interface.
```

### 1.9 Scoped sudo for the restart step

`deploy/deploy.sh` runs `sudo systemctl restart <service>` as the deploy
user. Grant exactly that, nothing more, via `visudo -f
/etc/sudoers.d/212cc-deploy`:

```
cc212-staging ALL=(root) NOPASSWD: /usr/bin/systemctl restart 212cc-backend-staging.service
cc212-production ALL=(root) NOPASSWD: /usr/bin/systemctl restart 212cc-backend-production.service
```

(This assumes the SSH deploy user *is* `cc212-staging`/`cc212-production` —
see §2. If Angel prefers a separate deploy identity from the service's
runtime identity, adjust the `User=` above and this sudoers rule together
and update `STAGING_SSH_USER`/`PRODUCTION_SSH_USER` accordingly.)

### 1.10 SSH key for GitHub Actions

```bash
ssh-keygen -t ed25519 -f /tmp/212cc-staging-deploy -N "" -C "gh-actions-212cc-staging"
# append /tmp/212cc-staging-deploy.pub to
# /opt/212cc/staging/.ssh/authorized_keys (owned by cc212-staging, mode 600)
# the PRIVATE key /tmp/212cc-staging-deploy becomes the STAGING_SSH_KEY
# GitHub secret (§2) — then delete it from /tmp.
```

Repeat for production with its own, separate key pair — never reuse the
staging key for production.

## 2. GitHub Actions secrets Angel must configure

Repo → Settings → Secrets and variables → Actions (or, preferably, under
each GitHub **Environment** — `staging` / `production` — created per §3, so
a compromised staging secret can't touch production).

| Secret | Used by | Purpose |
| --- | --- | --- |
| `STAGING_HOST` | deploy-staging | VPS hostname/IP for staging deploys |
| `STAGING_SSH_USER` | deploy-staging | SSH user (`cc212-staging` per §1.3, or your chosen deploy identity) |
| `STAGING_SSH_KEY` | deploy-staging | Private half of the staging deploy key (§1.10) — full PEM contents |
| `STAGING_SSH_PORT` | deploy-staging | SSH port for the VPS (usually `22`) |
| `STAGING_APP_DIR` | deploy-staging | Absolute path to the staging checkout, `/opt/212cc/staging/app` |
| `PRODUCTION_HOST` | deploy-production | VPS hostname/IP for production deploys |
| `PRODUCTION_SSH_USER` | deploy-production | SSH user (`cc212-production` per §1.3) |
| `PRODUCTION_SSH_KEY` | deploy-production | Private half of the production deploy key (§1.10) — full PEM contents |
| `PRODUCTION_SSH_PORT` | deploy-production | SSH port for the VPS (usually `22`) |
| `PRODUCTION_APP_DIR` | deploy-production | Absolute path to the production checkout, `/opt/212cc/production/app` |

No other secret is referenced anywhere in `.github/workflows/ci.yml` — the
`lint-and-test` job's Postgres service password is a throwaway, job-scoped
test database, not a real secret, and is not one of the values above.

## 3. GitHub repository configuration Angel must do

None of this can be expressed in `ci.yml` itself — it's repo configuration:

1. **Branch protection** (Settings → Branches) on `main` and `develop`:
   require the `Lint, build & test` status check to pass before merging.
   This is what actually turns a failing lint/test into a blocked merge —
   the workflow only produces the status check; enabling the requirement is
   a repo setting.
2. **Environments** (Settings → Environments): create `staging` and
   `production`. Optionally add a required reviewer on `production` for a
   manual approval gate before every production deploy — `ci.yml` already
   references `environment: staging` / `environment: production` in the two
   deploy jobs, so this works as soon as the environments exist.
3. Store the secrets from §2 scoped to their matching environment (not as
   plain repo secrets) if using environments with protection rules.

## 4. First real deploy — manual walkthrough (do this before trusting the pipeline)

1. Complete §1 and §2 in full.
2. From a workstation with access, manually verify SSH works with the new
   deploy key: `ssh -i <private key> <user>@<host> "echo ok"`.
3. Manually run `deploy/deploy.sh staging <a commit sha on develop>` **once
   by hand** on the VPS (as `cc212-staging`, with `sudo` available for the
   restart step) to catch anything environment-specific this document
   missed, before letting CI trigger it automatically.
4. Confirm `curl http://127.0.0.1:3001/api/v1/health` (localhost, on the
   VPS) returns `200` with `{"status":"ok","database":"up",...}`.
5. Confirm `https://staging-api.<domain>/api/v1/health` returns the same
   from outside, through Nginx/TLS.
6. Only then push to `develop` and watch the `deploy-staging` GitHub Actions
   job run end-to-end. Repeat the same sequence for `main`/production before
   relying on `deploy-production`.

## 5. Rollback

There is no automated rollback job in `ci.yml` (out of this story's scope).
To roll back manually: SSH to the VPS and re-run the deploy script against
the previous known-good commit:

```bash
sudo -u cc212-production /opt/212cc/production/app/deploy/deploy.sh production <previous-good-sha>
```

This re-applies that commit's build and restarts the service. Note this
does **not** roll back a Prisma migration that already ran — if the bad
deploy included a destructive migration, that needs its own manual
Postgres-level fix; `prisma migrate deploy` is forward-only by design.

## 6. Known gaps carried over from the architecture doc (not this story's job to close, but relevant to deploy safety)

Per `docs/architecture.md`, "Open Items Carried Forward": no backup/DR
policy for `uploads/` yet, no formal uptime SLA, SMTP/email provider still
unconfirmed. None of these block this story, but they matter before a real
production go-live.

## 7. Stripe payments (Epic 14, AD-45..AD-50)

### 7.1 Environment variables

| Variable | Meaning |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` (staging) / `sk_live_...` (production). Empty => in-memory fake client (local/CI, no network). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret `whsec_...` of the dashboard webhook endpoint. **Mandatory whenever `STRIPE_SECRET_KEY` is set: the service refuses to boot otherwise.** |
| `FRONTEND_URL` | Storefront base URL; Stripe's `success_url` / `cancel_url` are built from it. Must be the real public URL per environment. |

Add them to `/opt/212cc/<env>/shared/.env` (never committed; `.env.example` and
the CI workflow only carry empty placeholders so CI uses the fake client), then
`sudo systemctl restart 212cc-backend-<env>`. Use test keys on staging and live
keys only on production.

### 7.2 Register the webhook endpoint in the Stripe dashboard

Developers > Webhooks > Add endpoint:

- URL: `https://api.<DOMAIN>/api/v1/payments/stripe/webhook` (staging: its own host).
- Events (exactly the four the code handles, `src/payments-stripe/stripe-payments.service.ts`):
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`.
- Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` and restart.
- Every verified event is acknowledged with HTTP 200 (even no-ops), so Stripe does not retry needlessly. Invalid or missing signatures return 400.

**Secret rotation:** Stripe dashboard > endpoint > "Roll secret" (optionally with
an expiry window for the old one) > update `STRIPE_WEBHOOK_SECRET` > restart.
Events signed with the old secret are rejected (400, Stripe retries) after the
restart, so roll with Stripe's overlap window and restart immediately. Rotating
`STRIPE_SECRET_KEY` follows the same restart procedure.

### 7.3 Local testing with the Stripe CLI

```bash
stripe listen --forward-to localhost:3000/api/v1/payments/stripe/webhook
# prints "whsec_..." -> export STRIPE_WEBHOOK_SECRET=whsec_... together with a test STRIPE_SECRET_KEY
stripe trigger checkout.session.completed   # smoke only: real orders come from POST /api/v1/checkout
```

Without keys the app uses the fake client and a built-in fake webhook secret
(the signature is still really verified), which is what the e2e suite does.

### 7.4 Nginx and rate limiting

- `location /` in `deploy/nginx/api.conf.template` and `staging-api.conf.template`
  is a plain `proxy_pass`: the webhook body is forwarded byte for byte (Stripe
  signs the raw body; do **not** add `sub_filter`, body rewriting, a WAF that
  alters JSON, or a gzip/transform step on this path). `client_max_body_size 10m`
  is far above the event size. `proxy_request_buffering` stays at its default
  (on), which does not modify content.
- The webhook route has no application-level throttling (`ThrottlerGuard` is
  applied only to the contact and customer-auth controllers). If you add
  Nginx `limit_req` or a firewall/CDN rate limit, exempt
  `/api/v1/payments/stripe/webhook` so Stripe retries are never rejected.

### 7.5 Manual refund procedure (no automatic refunds, A28 / AD-50)

A payment can be captured while the Order cannot be fulfilled
(`PAID_BUT_NO_STOCK` / `PAID_AFTER_TERMINAL` logged at ERROR, outcome
`refund_pending_after_terminal` or `refund_pending_no_stock` in `Stripe_Webhook_Events`).

1. Admin panel (or API): `GET /api/v1/admin/orders?refundPending=true` lists the Orders flagged `refundPending`.
2. For each, take `stripeCheckoutSessionId` / `stripePaymentIntentId` from the Order.
3. Stripe dashboard > Payments > search by the PaymentIntent (`pi_...`) or Checkout Session (`cs_...`) > Refund.
4. Notify the customer and note the refund on the Order (internal note / support channel).

### 7.6 Epic 14 migrations (`pnpm prisma:deploy` = `prisma migrate deploy`)

Applied in order: `20261019100000_add_payment_rail_stripe`,
`20261019100100_add_order_actor_stripe_webhook`,
`20261019100200_add_order_stripe_columns`,
`20261019100300_add_stripe_webhook_events`, `20261019110000_remove_paypal`.
The last one removes PayPal and has a guard: it aborts with `PAYPAL_REMOVAL_ABORTED` when any Order or history row still references PayPal.
If that happens, delete or archive those PayPal rows in Postgres (back up the DB first) and re-run `pnpm prisma:deploy`.
Smoke afterwards: `POST /api/v1/payments/paypal/webhook` must answer 404 after the PayPal removal, and Swagger must list only
`pago_movil` / `stripe` as `paymentRail`.

### 7.7 Confirm before launch (with Nabil; PRD section 15.6)

- [ ] Stripe account owner, business country and whether it can accept USD charges.
- [ ] Settlement currency (USD) and payout bank account.
- [ ] Fees (card % + fixed, international/currency-conversion surcharges) and who absorbs them.
- [ ] Live keys (`sk_live_...`) issued and stored only in the production `.env`; live webhook endpoint created with its own `whsec_...`.
- [ ] Payment methods enabled in Checkout (async methods need the `async_payment_*` events subscribed).
- [ ] Refund/dispute policy and who operates the manual refund procedure (7.5).
- [ ] End-to-end test purchase in staging with test keys, then a small real purchase in production.

## 8. tcgapi.dev, TCG ingestion and taxonomy (Epic 15, AD-51..AD-59)

### 8.1 Environment variables

Add to the same `/opt/212cc/<env>/shared/.env` files as the Stripe keys (the systemd units already load them with
`EnvironmentFile=`, so nothing else in `deploy/` changes). Never commit a value; the key is sent only in the `X-API-Key` header and is never logged.

| Variable | Default | Meaning |
|---|---|---|
| `TCGAPI_KEY` | empty | Empty = in-memory `FakeTcgApiClient` (no network). Set = real tcgapi.dev client. |
| `TCG_INGEST_GAMES` | `pokemon` | Comma-separated game slugs for `pnpm tcg:ingest`. |
| `TCG_INGEST_SETS` | empty | Comma-separated set ids or slugs. Empty = the `TCG_INGEST_DEFAULT_SET_LIMIT` most recent sets per game. |
| `TCG_INGEST_DEFAULT_SET_LIMIT` | `5` | Sets per game when `TCG_INGEST_SETS` is empty. |
| `TCG_MAX_REQUESTS_PER_RUN` | `60` | Request budget of one ingest run. |
| `TCG_REQUEST_RESERVE` | `20` | Runs stop when the API reports `remaining <=` this value (shared by ingest and nightly sync). |
| `TCG_IMAGE_ALLOWED_HOSTS` | `product-images.tcgplayer.com,tcgplayer-cdn.tcgplayer.com` | Hosts the backend may download card images from (https/443 only). If tcgapi.dev serves images from another CDN, creating a product from a master card answers 502 until the host is added. |
| `TCG_REMOTE_INGEST_MAX_CARDS` | `10` | **Temporary dev/testing limit** (Story 15.9 AC12): max cards stored per run started through `POST /admin/tcg-master-cards/ingest` (a body `maxCards` above it is clamped). Does not apply to `pnpm tcg:ingest` or the nightly worker. Raise it (e.g. `1000000`) when moving to production. |
| `TCG_NIGHTLY_SYNC_ENABLED` | `false` | Must be exactly `true` (case-insensitive) to run the 03:00 UTC cron. |
| `TCG_NIGHTLY_MAX_REQUESTS` | `50` | Request budget of one nightly run. |
| `TCG_PRICE_ALERT_PCT` | `25` | Price changes above this percent are logged and stored in `Tcg_Sync_Runs.bigVariations`. |

(`TCG_API_CLIENT` and `TCG_ALLOW_FAKE_REMOTE_INGEST` are internal test switches; never set them in production.)

### 8.2 Plan quotas and impact

| Plan | Requests/day |
|---|---|
| Free | 100 |
| Hobby | 1 000 |
| Starter | 2 500 |
| Pro | 10 000 |

The counter resets at 00:00 UTC. On the **Free plan (100/day)** a whole game cannot be ingested: each set costs about `ceil(cards/100)` requests plus
the set listing, which is why the default is the 5 most recent sets. The nightly worker re-lists whole set pages (there is no bulk endpoint) and its budget
(50) plus the reserve (20) must fit in what the ingest left for the day. If you ingest and keep the nightly worker on the same key,
ingest first with a budget that leaves headroom, or raise the plan. Runs stop cleanly (status `PARTIAL`, `quotaExhausted=true`) on the budget, the reserve or HTTP 429;
the next run resumes from the per-set cursors.

### 8.3 Running the ingestion in production

```bash
# As the service user (sudo -u cc212-production -i). The CLI only reads a .env in its
# working directory; in production the env file lives outside the git tree and only
# systemd loads it, so export it explicitly first:
cd /opt/212cc/production/app
pnpm build                      # the CLI runs from dist/
set -a; . /opt/212cc/production/shared/.env; set +a
pnpm tcg:ingest                                           # defaults from the env vars
pnpm tcg:ingest --games pokemon --sets <setId-or-slug> --max-requests 40
pnpm tcg:ingest --set-limit 10 --dry-run                  # no writes
pnpm tcg:ingest --refresh-sets                            # re-read the set list
```

Resumable: each set keeps a cursor in `Tcg_Ingest_Cursors`; a run cut by quota ends `PARTIAL` (exit 0) and the next run continues without duplicates.
Only one ingest/nightly run can be active (partial unique index on `Tcg_Sync_Runs`); a `RUNNING` row older than 2 h is marked `FAILED`. A network/DB error exits with code 1.
Ingestion only writes `Master_Cards`; it never creates or changes Products.

#### Remote ingestion (no SSH, Story 15.9)

The production env must contain `TCGAPI_KEY`; without it the endpoint answers `503 TCG_API_NOT_CONFIGURED` and creates nothing. From your machine:

```bash
# scripts/.env.import (or inline env): API_BASE_URL, ADMIN_USER, ADMIN_PASSWORD  (no TCGAPI_KEY needed)
node scripts/ingest-master-cards.mjs --games pokemon --sets <setId-or-slug> --max-requests 40
node scripts/ingest-master-cards.mjs --status      # only prints Master_Cards stats
```

Endpoints (admin token): `POST /api/v1/admin/tcg-master-cards/ingest` (202 `{runId, status:'RUNNING'}`, 409 `TCG_SYNC_ALREADY_RUNNING`, 503 `TCG_API_NOT_CONFIGURED`), `GET .../runs/:id`, `GET .../stats`.
The run continues in the background on the server; the script polls it (exit 0 on `SUCCEEDED`/`PARTIAL`, 1 on `FAILED`/error).
**Temporary cap:** each remote run stores at most `TCG_REMOTE_INGEST_MAX_CARDS` cards (default 10) and ends `PARTIAL` with `summary.cardCapReached`; run again to continue (cursors are kept, no duplicates or gaps). Raise it for production.

### 8.4 Nightly price sync

- Cron `tcg-nightly-sync`, `0 3 * * *` UTC, registered always but a no-op unless `TCG_NIGHTLY_SYNC_ENABLED=true`.
- It refreshes `Master_Cards` of sets that have linked products first, then other `DONE` sets, and updates `Products.priceUsd` only where `autoSyncPrice = true` and `isManual = false`
  and the API price is not null. Order line snapshots are never touched.
- A set that fails with a non-quota error (for example a persistent 404) or has no cursor row is recorded in `errorSummary`/`errorCount`, skipped, and moved to the back
  of the queue (`lastPriceSyncAt` advanced); the remaining sets still run.
- **Do not forget to enable it in production**: with the flag off, prices of linked products stay frozen at the value they had when the product was created.

Read the audit with SQL (`psql`):

```sql
SELECT "startedAt", kind, status, "requestsUsed", "cardsSynced", "productsUpdated",
       "errorCount", "quotaExhausted", "errorSummary", "bigVariations"
FROM "Tcg_Sync_Runs" ORDER BY "startedAt" DESC LIMIT 10;
```

### 8.5 Rotating the key

Edit `TCGAPI_KEY` in the environment `.env`, `sudo systemctl restart 212cc-backend-<env>`, then run a real, small `pnpm tcg:ingest --max-requests 3` (after loading the env as in 8.3; `--dry-run` writes no `Tcg_Sync_Runs` row, so it cannot confirm anything in the audit table) or wait for the next nightly row, and
confirm the newest `Tcg_Sync_Runs` row has no `errorSummary`. The old key must be revoked in the tcgapi.dev dashboard. `scripts/.env.import` (git-ignored) is only for the local import script.

### 8.6 Taxonomy data migration (Story 15.1)

Migration `20261020100000_epic15_standard_taxonomy` (data only, idempotent, no fixed UUIDs); `pnpm prisma:deploy` applies it. On deploy it:
- creates the 3 standard ROOT categories by slug when missing: `franquicia-tcg`, `formato-sellado`, `idioma-edicion` (`cartas-sueltas` and `sobres-y-cajas` already exist and are protected);
- gives orphan SUBCATEGORY rows the root of their dimension as `parentId` (FRANCHISE, SEALED_FORMAT, EDITION_LANGUAGE);
- cleans obsolete childless roots: **deletes** them if no product uses them (e.g. `Prueba-categoria` when unused) and **deactivates** them (`isActive=false`, not deleted) if any product references them. In particular `ediciones-especiales` and `mazos-preconstruidos` are deactivated when they have products, so those products keep their category;
- removes SEALED_FORMAT tags from SINGLE_CARD products and adds the franchise tag to products of the 5 supported games.
The NOTICE lines list each root as deleted/deactivated and repeat "deactivated" on re-runs (cosmetic). A clean seeded DB still creates `ediciones-especiales`/`mazos-preconstruidos` active (the seed products reference them).

### 8.7 Deployment checklist

- [ ] Back up the DB, then `pnpm prisma:deploy`; `pnpm prisma migrate status` reports up to date.
- [ ] Verify roots/children: `GET /api/v1/categories?type=ROOT` and `GET /api/v1/catalog/facets` (`franquicia-tcg`, `formato-sellado` groups).
- [ ] Disable the leftover `Prueba-categoria` (and any other test category) in the admin if it survived the migration (it is only deactivated when products use it).
- [ ] Check that the two deactivated roots (8.6) are what the owners expect.
- [ ] `TCGAPI_KEY` set in the environment `.env` only; `grep -r` of the repo for the key value returns nothing.
- [ ] Run the first `pnpm tcg:ingest` with a small `--max-requests`, then confirm a `Tcg_Sync_Runs` row and `Master_Cards` rows.
- [ ] Set `TCG_NIGHTLY_SYNC_ENABLED=true` in production and restart; confirm the next 03:00 UTC `NIGHTLY` row exists.
- [ ] Confirm `TCG_IMAGE_ALLOWED_HOSTS` covers the image hosts that really appear in `Master_Cards.imageLarge`.
- [ ] Smoke: boot without `TCGAPI_KEY` (fake client) is fine for staging; production must have the key.

### 8.8 Contract changes for the frontend (all additive except where noted)

- Pagination `meta` on `GET /products` and the other paginated lists adds `hasNextPage` / `hasPreviousPage` (`GET /me/orders` keeps its original four fields).
- Category filter: `categoryId[]` is accepted as an alias of `categoryId` (merged, deduplicated, uuid, max 20). **Behaviour change:** `?categoryId[]=` (empty) now answers 400, like `?categoryId=`; before it was ignored.
- New `GET /admin/tcg-master-cards/search` (admin auth): response `{ data, meta }` where each item has `id`, `externalId`, name, set, number, rarity, `printing` (Normal/Foil are separate entries), images, `apiPriceUsd`, `alreadyInInventory`, `currentInventoryStock`.
- `POST /admin/products` accepts `masterCardId` + `stock` (multipart; also `isActive`, `categoryIds`, grading fields, `isPreorder`, `releaseDate`). Name, slug, description, franchise, type, rarity, language, price, category and images are derived from the master card; any of those sent alongside are ignored (uploaded files are deleted). `singleCondition` is **not** accepted. The manual creation flow is unchanged (image and price required).
- Admin product responses include `masterCardId`, `isManual`, `autoSyncPrice`, `lastMarketSyncAt`. `PATCH /admin/products/:id` accepts `autoSyncPrice` (boolean).
- New errors on creation from a master card: 404 `MASTER_CARD_NOT_FOUND`, 422 `MASTER_CARD_NO_PRICE`, 502 `MASTER_CARD_IMAGE_UNAVAILABLE`, 409 `PRODUCT_SLUG_TAKEN`; `PATCH autoSyncPrice` on a product without master card gives 409 `NOT_A_LINKED_PRODUCT`; missing `cartas-sueltas` category gives 500 `SINGLES_CATEGORY_MISSING`.
- Public contracts of `GET /products`, `/catalog/facets`, `/categories` are otherwise unchanged (Epic 13/14 regression suites pass unmodified).

## Verification status (read this before assuming any of the above works)

**Verified in this sandbox (no VPS, no SSH, no real GitHub secrets available):**

- `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:e2e` all pass on the
  existing codebase, unmodified by this story (baseline confirmed before
  and after adding these files).
- The exact CI sequence the `lint-and-test` job runs against its Postgres
  service (`pnpm prisma:deploy` then `pnpm test:e2e`) was dry-run locally
  against a throwaway `postgres:17-alpine` Docker container on a scratch
  port (5544), created and destroyed just for this check, standing in for
  GitHub's ephemeral service container — migrations applied cleanly and all
  6 e2e tests passed against it. This is the strongest verification
  possible without an actual GitHub Actions runner.
- `.github/workflows/ci.yml` validated against GitHub's own published JSON
  Schema for workflow files via `check-jsonschema --builtin-schema
  github-workflows` (run through `pipx run`, network access confirmed
  available in this sandbox) — passed with no errors. Also parses cleanly
  as YAML.
- `deploy/deploy.sh` checked with `shellcheck` (via `pipx run --spec
  shellcheck-py shellcheck`) — zero warnings — and `bash -n` (syntax-only
  parse) — clean.
- Both `deploy/systemd/*.service` files verified with `systemd-analyze
  verify` (systemd is available in this sandbox) against copies with the
  placeholder VPS paths substituted for real local ones — **and** with
  `ExecStart` repointed from `/usr/bin/node` to a real local Node binary
  (`/usr/bin/node` does not exist in this dev/CI sandbox; Node here is only
  installed per-user via nvm, e.g. `~/.nvm/versions/node/*/bin/node`, which
  `systemd-analyze verify` cannot resolve since it doesn't source shell rc
  files). With both substitutions, both units pass with no errors or
  warnings. This confirms the unit *structure* is correct — `Type`,
  `User`/`Group`, `WorkingDirectory`, `EnvironmentFile`, the hardening
  directives, and the `[Install]` section all parse and are internally
  consistent. It does **not** confirm that `/usr/bin/node` (or whichever
  path Node actually ends up at) is correct on the real VPS — leaving
  `ExecStart` as `/usr/bin/node` unchanged and only substituting the VPS
  paths reliably fails verification here with `Command /usr/bin/node is not
  executable: No such file or directory`, because that binary genuinely
  doesn't exist on this machine. The `ExecStart` path can only be confirmed
  once Angel provisions the real VPS, installs Node system-wide there, and
  runs `sudo -u cc212-staging which node` (per the comment already in each
  unit file) to verify it matches. The real files, as committed, still
  contain VPS-specific placeholder paths — and the placeholder
  `/usr/bin/node` — that don't exist on this dev machine.
- Both `deploy/nginx/*.conf.template` files checked with `nginx -t` inside a
  throwaway `nginx:alpine` Docker container (no nginx installed on this
  host) — both pass.
- Grepped `ci.yml` for hardcoded credentials: the only literal
  password-looking string is the throwaway, job-scoped CI test database
  password (not a real secret, never reused). Every real deploy credential
  goes through `${{ secrets.* }}`.

**NOT verified — genuinely untested, not just "should work":**

- No real SSH connection to any VPS was ever made — `appleboy/ssh-action`
  has never actually run in this pipeline.
- `deploy/deploy.sh` has never executed against a real systemd service, a
  real Postgres database, or a real `git checkout` of this repo on another
  machine.
- Neither systemd unit has ever been installed or started by real systemd
  with the real `cc212-staging`/`cc212-production` users, the real Node
  binary path, or the real `/opt/212cc/...` paths.
- Neither Nginx config has ever proxied a real request, and certbot's
  rewrite of these files has never been exercised.
- No GitHub Actions run of this workflow has ever executed — the
  `lint-and-test` job's Postgres-service YAML syntax is schema-valid but
  its actual behavior on GitHub's runners is unconfirmed.
- Branch protection and GitHub Environments (§3) do not exist yet — this
  document describes what to configure, not what is configured.

Angel should treat everything above the "Verification status" heading as a
reviewed, internally-consistent **plan and set of templates**, not a
proven-working deployment, until §4's manual walkthrough is actually done
against the real VPS.

## Pre-launch retirement checklist: manual email verification (FR-53, Story 13.7)

`MANUAL_EMAIL_VERIFY_ENABLED` and `POST /api/v1/admin/customers/verify-email`
are a TEMPORARY workaround until real SMTP exists (PRD §10). Before launch:

- [ ] Delete `src/admin-customers/` and its import in `AppModule`.
- [ ] Remove `MANUAL_EMAIL_VERIFY_ENABLED` from `.env.example` and from every
      environment (`/opt/212cc/{staging,production}/shared/.env`).
- [ ] Remove its e2e spec (`test/admin-customers-verify-email.e2e-spec.ts`).
- [ ] Until real SMTP exists, confirm `MANUAL_EMAIL_VERIFY_ENABLED` is `false`
      or absent in staging and production (the endpoint then answers 404; this
      is asserted by the "flag off" block of that e2e spec).

## Simulator: validating rarity mapping (Story 16.3, assumption (f) unverified)

`mapPackTier` (`src/simulator/pack-tiers.ts`) and the reverse-holo detection
(`REVERSE_PRINTING_PATTERN`, `/reverse/i` over `Master_Cards.printing`) are based on
Pokemon Scarlet & Violet knowledge, NOT on real tcgapi data: the local DB had 0
`Master_Cards` when written. After the **first real ingestion** of a Pokemon set
(never in tests; they use fixtures/`FakeTcgApiClient`):

1. `SELECT rarity, count(*) FROM "Master_Cards" WHERE "gameSlug"='pokemon' GROUP BY 1 ORDER BY 2 DESC;`
2. `SELECT DISTINCT printing FROM "Master_Cards";`
3. Call `GET /api/v1/admin/simulator/sets` (admin) and review, per set,
   `unmappedRarities` (raw values mapped to `null`, i.e. excluded from packs) and
   `hasReversePrintings` (false means the printing label differs from `reverse`).
4. Adjust **only the tables** in `pack-tiers.ts` (`EXACT_TIERS`, `FALLBACK_RULES`,
   `REVERSE_PRINTING_PATTERN`, and the matching `~* 'reverse'` in
   `simulator-sets.service.ts`) and re-check `tierCoverage`.

## 9. Home CMS and pack simulator (Epic 16, AD-60..AD-69)

### 9.1 Environment variables (all optional, defaults shown; see `.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `LANDING_IMAGE_MAX_BYTES` | `2097152` (2 MB) | Max size of an image sent to `POST /admin/landing-content/images` (413 `LANDING_IMAGE_TOO_LARGE`). |
| `SIMULATOR_RATE_LIMIT_PER_MIN` | `30` | Max `POST /simulator/packs` per client IP per minute (429 + `Retry-After`). |
| `LANDING_REVALIDATE_SECONDS` | `60` | **Frontend** env: cache TTL of the public Home; it is the ceiling of freshness after a publish. |

### 9.2 Deployment order and migration

1. `pnpm install` (new dependency `image-size`).
2. `pnpm prisma:deploy` applies `add_landing_draft` (draft/`publishedAt` columns on `Landing_Config_Entries`). It is additive; deploy the backend **before** the frontend so the new endpoints exist when the new admin/Home call them.
3. Verify: `pnpm exec prisma migrate status` is up to date and `prisma migrate diff` shows no drift.

### 9.3 Uploaded images: `uploads/public/landing/`

Admin images are stored in `<uploads>/public/landing/<uuid>.<ext>` and served from `/uploads/public/landing/...`. This directory lives outside the git tree and **must be persistent and included in the backup** together with the rest of `uploads/` (a deploy must not wipe it). Losing it leaves the published Home with broken image URLs.

### 9.4 Deployment requirement: `X-Forwarded-For` (rate limit by IP and the IP of the audit events)

Every limit by IP (simulator, admin login, contact, customer login/register/recovery, view signal) and the `ip` column of every audit event use `req.ip`. The chain is `Internet -> Nginx -> Next (BFF) -> backend` and, for the API subdomain, `Internet -> Nginx -> backend`, **every hop on loopback**.

**What each hop does (Story 20.5 follow-up; the admin login did NOT forward the IP before it, so every login arrived with the address of the Next server: 5 failures from an anonymous attacker on the user `admin` locked the real admin out for 15 min and every event stored the Next IP).**

1. **Nginx** appends the address it saw: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (what the client wrote, a comma, the peer address) and `proxy_set_header X-Real-IP $remote_addr;` (overwrites whatever the client sent). Both are in the two backend templates; the Next block has no template (see 11.3 for the lines it needs).
2. **Next** (`212CollectorsClub-frontend/lib/utils/client-ip.ts`, one helper for every route, `backendFor(request)`): takes the `X-Forwarded-For` entry counted from the **right** (`TRUSTED_PROXY_HOPS`, default 1 = Nginx; 2 with a CDN in front of Nginx), validates that it is an IP, and sends the backend **one single entry**. What the client wrote to the left of it is never forwarded; an invalid entry is not replaced by an earlier one; without `X-Forwarded-For`, `X-Real-IP`. Covered: all of `app/api/**` and the `lib/utils/*-proxy.ts` proxies (admin login/logout/me, every admin action, customer login/register/forgot/reset/verify/profile/change-password, cart, wishlist, checkout, consent, proof of payment, catalog, simulator, view beacon). Exempt (public cached reads with no per-IP limit and no audit): `/api/fx/current`, `/api/legal/current-versions`. A test fails if a route uses `backendApi` directly.
3. **Backend** (`common/trust-proxy.ts`, `main.ts`): `trust proxy` is **`loopback`** (override: `TRUST_PROXY`). `req.ip` is the first address, walking `X-Forwarded-For` from the right, that is **not** loopback. From Nginx that is the address Nginx appended; from Next (or from Next going through Nginx on the same host by mistake) it is the single address Next set, because the loopback addresses of the proxies are skipped. A connection that does **not** come from loopback (a port reachable from outside by mistake) is not believed at all: `req.ip` is its socket address and its `X-Forwarded-For` is ignored. With the previous `trust proxy 1` the header would have been believed from anyone.

Answers to the questions of the QA round: with `1` and the single entry Next adds, Nest sees that entry (the real client); a client cannot impersonate another address through Nginx or through Next (what it writes is to the left of what the trusted hop appends, or discarded); it could if it reached the backend port directly, which `loopback` closes.

> **Docker / Dokploy (Next and Nest in different containers): the default `loopback` does NOT work there; set `TRUST_PROXY` to the narrow container-network subnet. Full table, steps, risks and the test: section 17.8.**

Requirements: **only Nginx can reach the backend and the Next server** (both bound to 127.0.0.1 / blocked by the firewall; never expose 3000/3001) and `BACKEND_API_URL` on loopback (11.3).

Checklist: (1) `curl -s -H 'X-Forwarded-For: 1.2.3.4' https://<DOMAIN>/api/...` from outside must not let you choose your own throttle key; (2) 31 requests/min to `POST /simulator/packs` from one address get a 429, a second address is unaffected; (3) five wrong passwords for `admin` from one address lock **that address + that user** and the real admin, from another address, still logs in; (4) the `ip` of `LOGIN_ADMIN_OK` / `LOGIN_ADMIN_FAILED` in `GET /admin/audit/events` is the client's, never `127.0.0.1`.

Verified in this repo with a simulated chain (Nginx is not installed here): `test/admin-login-proxy-chain.e2e-spec.ts` runs real HTTP servers for Nginx (appends exactly what the template does), Next and Nest (real `AppModule`, real `ThrottlerGuard`), with a control that reproduces the bug (without forwarding, the real admin gets a 429), the fix (real admin gets in from his IP, the events carry the real IPs), forged `X-Forwarded-For` / `X-Real-IP` from the attacker, the 20-failures-per-IP lock, the 60/10 min ceiling, and Nginx straight to Nest. `src/common/trust-proxy.spec.ts` covers the setting with Express' own `req.ip` for loopback and non-loopback peers. The front end helper and its routes are tested in `212CollectorsClub-frontend/lib/utils/client-ip.test.ts` against a local HTTP server.

### 9.5 After the first real ingestion

Rarity mapping and the reverse printing label are assumptions until real data exists. Follow [Simulator: validating rarity mapping](#simulator-validating-rarity-mapping-story-163-assumption-f-unverified) (query `GET /admin/simulator/sets`, review `unmappedRarities` and `hasReversePrintings`, adjust `pack-tiers.ts`). `cardCount` in `/simulator/sets` and `/admin/simulator/sets` counts **unique cards** (`cardNumber ?? id`), so reverse printings are not counted twice.

### 9.6 Contract summary for the frontend

- Public: `GET /landing-content` returns `home.<block>` only when published (a draft is never exposed); `vitrina` comes with `products` already resolved (active and in stock only, same order as `productIds`). `GET /simulator/sets` -> `{data:[{setId,gameSlug,name,cardCount,imageUrl}]}` (cache 60 s). `POST /simulator/packs {setId}` -> 10 cards (`position`, `id`, `rarityTier`, `isReverse`, `imageUrl`, `marketPriceUsd`, optional `product`), totals, rare card last; 404 `SIMULATOR_SET_NOT_FOUND`, 422 `SIMULATOR_SET_INSUFFICIENT_CARDS`, 429 with `Retry-After`. The frontend proxy must forward `X-Forwarded-For`.
- Admin (Bearer): `GET /admin/landing-content/blocks[/:block]`, `PUT /blocks/:block` (draft), `POST /blocks/:block/publish`, `DELETE /blocks/:block/draft`, `POST /publish`, `GET /draft` (effective view for the previewer), `POST /images?kind=generic|card` (single `file` field; errors `LANDING_IMAGE_REQUIRED`, `UNSUPPORTED_FILE_TYPE`, `LANDING_IMAGE_KIND_INVALID`, `LANDING_IMAGE_MULTIPART_INVALID`, `LANDING_IMAGE_TOO_LARGE` 413, `LANDING_IMAGE_DIMENSIONS`/`LANDING_IMAGE_BAD_RATIO` 422). `GET|PUT /admin/simulator/config` (400 `SIMULATOR_CONFIG_INVALID`, `SIMULATOR_ODDS_INVALID_SUM`), `GET /admin/simulator/sets`. `PUT /admin/landing-content/pack_simulator/config` is reserved (400 `LANDING_KEY_RESERVED`).
- Concurrent edits of a draft: last write wins (R-d).

## 10. Libreta de direcciones y envío nacional (Epic 17, AD-70..AD-77)

### 10.1 Environment variable (optional; see `.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `CHECKOUT_REQUIRE_SHIPPING` | `false` (unset = disabled) | Only the exact string `true` enables it (`TRUE`, `1`, `yes`, ` true ` do **not**). It is read on every `POST /checkout` and not validated at startup (no config change needed); since it is a process env var, changing it in production still means restarting the service. When enabled, the legacy flat address (`addressLine1`/`city`/`state` without agency) is rejected with 400 `SHIPPING_REQUIRED`. When disabled, both the flat format and the new agency format are accepted. |

Activation plan: (1) deploy the backend with the flag off; (2) deploy the new frontend (checkout sending `customerAddressId` or `shippingAgencyId` + `deliveryMode` + `recipientIdDoc` + `state` + `municipality`); (3) verify one real checkout in the new format; (4) set `CHECKOUT_REQUIRE_SHIPPING=true` in the backend env and restart. Do **not** enable it before step 2: the old frontend would receive 400 `SHIPPING_REQUIRED` on every purchase. Rollback of the flag: set it to `false` (or remove it) and restart.

### 10.2 Deployment order and migrations

1. `pnpm prisma:deploy` applies, in order:
   - `20261026100000_add_customer_addresses_shipping`: creates enum `DeliveryMode` and tables `Shipping_Agencies`, `Shipping_Branches`, `Customer_Addresses`, `Order_Tracking_Events`; adds nullable columns to `Orders` (`recipientIdDoc`, `deliveryMode`, `shippingAgencyId`, `agencyBranchName`, `agencyBranchCode`, `municipality`, `parish`, `referencePoint`, `trackingNumber`); creates the hand-written partial unique index `Customer_Addresses_customerId_default_key` (`ON "Customer_Addresses"("customerId") WHERE "isDefault"`, one default address per customer); and **seeds the 4 agencies** (MRW, Zoom, Tealca, Domesa; Domesa with `allowsHomeDelivery=false`) with `ON CONFLICT ("code") DO NOTHING`. It is additive: no existing `Orders` row is rewritten.
   - `20261026110000_shipping_agency_code_upper`: widens `Shipping_Agencies.code` to `VARCHAR(50)` and upper-cases existing codes (`mrw` -> `MRW`, etc.) only when the upper-case form is not already taken. Idempotent.
2. Optional: `pnpm prisma:seed` also seeds the same 4 agencies (`createMany` with `skipDuplicates`, i.e. `ON CONFLICT DO NOTHING`), so it never overwrites an admin's edits to name, flags or `trackingUrlTemplate`. It is not required after `prisma:deploy`.
3. Deploy the backend **before** the frontend so the new endpoints exist when the new checkout, address book and admin call them.
4. Verify: `pnpm exec prisma migrate status` is up to date; `SELECT code, "isActive", "allowsHomeDelivery", "trackingUrlTemplate" FROM "Shipping_Agencies" ORDER BY "sortOrder"` returns `MRW, ZOOM, TEALCA, DOMESA`; `GET /api/v1/shipping/agencies` lists the 4 and never exposes `trackingUrlTemplate`.

### 10.3 Loading `trackingUrlTemplate` per agency (manual, after deploy)

The seeded agencies have `trackingUrlTemplate = NULL`; until the admin sets it, `trackingUrl` is `null` in every order view even when a `trackingNumber` exists. The template must be `https://` and contain exactly one `{trackingNumber}` placeholder (otherwise 400 `TRACKING_TEMPLATE_INVALID`); `null` clears it.

```bash
# <ID> from GET /api/v1/admin/shipping/agencies
curl -X PATCH https://<DOMAIN>/api/v1/admin/shipping/agencies/<ID> \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"trackingUrlTemplate":"https://<agency-tracking-page>?guia={trackingNumber}"}'
```

Use each agency's real public tracking URL (not verified by this repo). Agency `code` is upper-cased, unique and immutable after creation.

### 10.4 Contract summary for the frontend

- Public: `GET /shipping/agencies` -> `{data:[...]}` only active agencies ordered by `sortOrder`, without `trackingUrlTemplate`; `Cache-Control: public, max-age=60`.
- Customer (cookie `cc_session`): `GET|POST /auth/addresses`, `PATCH|DELETE /auth/addresses/:id`, `PATCH /auth/addresses/:id/set-default`. Max 10 per customer; the first is default automatically; deleting the default promotes the most recent remaining one; another customer's id answers 404 `ADDRESS_NOT_FOUND` (never 403). `recipientIdDoc` is normalized (`v12345678` -> `V-12345678`).
- Checkout: `POST /checkout` accepts the new format (`customerAddressId` for a logged-in customer, or `shippingAgencyId` + `deliveryMode` + `recipientIdDoc` + `state` + `municipality` ...) or, while the flag is off, the legacy flat format. The shipping data is snapshotted on the order (editing or deleting the saved address does not change it). `fulfillmentType: "pickup"` answers 400 `PICKUP_NOT_SUPPORTED`. Order views (`GET /orders/:orderId`, `GET /auth/orders[/:orderId]`, `GET /admin/orders/:orderId`) expose `fulfillment.{recipientIdDoc,deliveryMode,shippingAgency,trackingNumber,trackingUrl,...}`; historical `pickup` orders keep answering 200 with those fields `null`.
- Admin (Bearer): `GET|POST /admin/shipping/agencies`, `PATCH|DELETE /admin/shipping/agencies/:id` (DELETE only if no address or order references it, else 409 `SHIPPING_AGENCY_IN_USE`; deactivate with PATCH instead), `PATCH /admin/orders/:orderId/tracking` (`{trackingNumber}`, `^[A-Za-z0-9._/-]{3,64}$`, `null` or `""` clears it; works in any order status; no status change and no email; each effective change records an `Order_Tracking_Events` audit row).
- New `errorCode`s: `SHIPPING_REQUIRED`, `PICKUP_NOT_SUPPORTED`, `SHIPPING_INVALID` (400, `details.errors:[{field,code}]`, values never echoed), `ADDRESS_NOT_FOUND` (404), `ADDRESS_REQUIRES_ACCOUNT` (400, `customerAddressId` without session), `ADDRESS_LIMIT_REACHED` (422), `ADDRESS_DEFAULT_CONFLICT` (409, concurrent default race, retry), `SHIPPING_AGENCY_UNAVAILABLE` (422), `DELIVERY_MODE_NOT_ALLOWED` (422), `SHIPPING_AGENCY_NOT_FOUND` (404), `SHIPPING_AGENCY_CODE_TAKEN` (409), `SHIPPING_AGENCY_IN_USE` (409), `SHIPPING_AGENCY_EMPTY_UPDATE` (400), `AGENCY_WITHOUT_DELIVERY_MODE` (422), `TRACKING_TEMPLATE_INVALID` (400), `TRACKING_NUMBER_INVALID` (400).

### 10.5 Rollback

The new `Orders` columns are nullable and the new tables are independent, so the previous backend build keeps working against the migrated schema: roll back by redeploying the previous release (section 5) and leaving the migrations applied; the extra tables/columns can stay. Set `CHECKOUT_REQUIRE_SHIPPING=false` first if it was enabled. Dropping the objects is only needed for a full schema revert: `DROP TABLE "Order_Tracking_Events", "Customer_Addresses", "Shipping_Branches"`, remove the new `Orders` columns, `DROP TABLE "Shipping_Agencies"`, `DROP TYPE "DeliveryMode"`, and delete the two rows from `_prisma_migrations`; this loses saved addresses, snapshots and tracking numbers, so avoid it once real orders use the new fields.

### 10.6 Manual verification on a database copy (before the first production migration)

1. Restore a recent backup into a scratch database and point `DATABASE_URL` at it.
2. Record `SELECT count(*), status FROM "Orders" GROUP BY status` and `SELECT count(*) FROM "Order_Lines"` (or the equivalent line table).
3. `pnpm prisma:deploy`.
4. Repeat the same queries: the counts must be identical; the new `Orders` columns are all `NULL` for existing rows, and `SELECT count(*) FROM "Shipping_Agencies"` returns 4.
5. Start the backend against the copy and open one pre-existing order in `GET /admin/orders/:orderId`: it answers 200 with the new shipping fields `null`.

The automated smoke of the whole epic is `test/epic-17-regression.e2e-spec.ts` (run with `pnpm test:e2e --no-file-parallelism`); it creates and removes its own data and restores the 4 seeded agencies.

## 11. Tasa de cambio multi-fuente y vitrina inteligente (Epic 18, AD-78..AD-87)

Everything below describes what the code does today; the automated smoke of the whole epic is `test/epic-18-regression.e2e-spec.ts` (run with `pnpm test:e2e --no-file-parallelism`).

### 11.1 Environment variables (all optional, defaults shown; see `.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `FX_PROVIDER` | `dolarapi` | `dolarapi` (real, DolarAPI) or `fake` (deterministic, no network). Forced to the fake provider when `NODE_ENV=test`. Anything else behaves as `dolarapi`. |
| `FX_PROVIDER_BASE_URL` | `https://ve.dolarapi.com` | Base URL of the provider. |
| `FX_PROVIDER_TIMEOUT_MS` | `5000` | Per-request timeout; a positive integer, otherwise the default. |
| `FX_REFRESH_CRON` | `*/30 * * * *` | Cron expression of the periodic refresh. **Read once when the module loads**: it must be in the process environment (see 11.2), a plain `.env` read later is not enough. |
| `FX_REFRESH_ENABLED` | `true` (`false` under `NODE_ENV=test`) | Only `true`/`false` are recognised. `false` disables the cron AND the refresh at boot, and also the daily purge of old `Fx_Rate_Snapshots` (03:30 UTC). The admin button (`POST /admin/fx/refresh`) keeps working. |
| `VITRINA_RECOMPUTE_CRON` | `0 * * * *` (hourly) | Cron of the ranking recompute. Same loading rule as `FX_REFRESH_CRON`. |
| `VITRINA_CRON_ENABLED` | `true` (`false` under `NODE_ENV=test`) | `false` disables the hourly recompute, the recompute at boot (only when there is no current run) and the daily purge of old runs / `Product_Daily_Stats` (> 180 days). |
| `VIEW_DEDUP_WINDOW_SEC` | `1800` | Seconds in which a repeated view of one product from the same client is not counted. In memory, **per process**: a restart or a second replica forgets it. |
| `VIEW_RATE_LIMIT_PER_MIN` | `120` | Per-IP limit of `POST /products/:id/view`. Over the limit it still answers 204 and just stops counting. |
| `VIEW_DEDUP_SECRET` | random per process | Optional. The daily salt of the view dedupe derives from it; nothing is persisted, and no IP or user agent is ever stored. |

The rate source, thresholds (`maxAgeHours`, `maxVariationPct`) and the manual rate live in the database (`Fx_Rate_Settings`), edited from the admin screen; they are not env vars.

### 11.2 The process environment (systemd `EnvironmentFile`)

`FX_REFRESH_CRON` and `VITRINA_RECOMPUTE_CRON` are evaluated by the `@Cron(...)` decorator when the class is loaded, before NestJS reads `.env`. In production the systemd units already load `EnvironmentFile=/opt/212cc/<env>/shared/.env`, so putting the variable in that file is enough; when running `node dist/main` by hand, export it first (`set -a; . shared/.env; set +a`). A custom expression only in a `.env` that the app itself loads is silently ignored and the default is used. Changing any variable needs a restart of the service.

### 11.3 Nginx, `X-Forwarded-For` and the frontend's `BACKEND_API_URL`

The view signal and its rate limit are per client IP, so the whole chain must deliver the real address:

- **Nginx must be the only access** to the backend and to the Next server (both on loopback, ports 3000/3001 closed in the firewall; section 1.8). `main.ts` sets `trust proxy loopback` (9.4): Express uses the first non-loopback address of `X-Forwarded-For` from the right, i.e. the one Nginx appended (or the single one Next forwards).
- Nginx must set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` on every `location` that proxies to Next and to the backend (already in both backend templates, `deploy/nginx/api.conf.template` and `staging-api.conf.template`, which only proxy the **backend**; there is **no template for the Next server**, so the operator must write that server block/`location` for the storefront with at least `proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_read_timeout 60s;`; with a CDN in front of Nginx set `TRUSTED_PROXY_HOPS=2` for Next). Never replace it with `$remote_addr` alone and never pass a client-supplied header through. Same rule as 9.4.
- The frontend (`212CollectorsClub-frontend`) must have `BACKEND_API_URL` pointing at the backend on **loopback** (e.g. `http://127.0.0.1:3000/api/v1` for production). If it points at the public URL (`https://api.<domain>/...`) the Next server calls the backend through Nginx and every view arrives with the IP of the Next server: all visits collapse into one IP, the dedupe and the rate limit swallow almost everything and the "interest" signal is under-counted without any error. Every frontend BFF route forwards the visitor's address (9.4: the last trusted hop, one entry).
- Time budgets: Nginx cuts at `proxy_read_timeout 60s` (both templates). `PUT /admin/vitrina/algorithm` waits for the settings lock at most **25 s** (constant `PUT_LOCK_BUDGET_MS`, enforced by the database with `SET LOCAL lock_timeout` **and** `statement_timeout` (both set to the time left until one shared deadline, so a queue of waiters cannot add up to n x 25 s; both are lifted again after the last lock so the write phase is never cut short), so a blocked connection cannot overrun it; Postgres SQLSTATE `55P03` is mapped to the error) and then answers 409 `VITRINA_BUSY`, so the admin gets the application error and never an Nginx 504. The recompute keeps its own 60 s transaction budget (`TX_TIMEOUT_MS`); a 10 000-product catalog recomputes in well under 5 s. With `recompute: true` the PUT recomputes after saving, so its total time is the save plus one recompute.

### 11.4 Migrations and deployment order

1. `pnpm install`, then `pnpm prisma:deploy` (= `prisma migrate deploy`, forward-only, run by CI/CD before the restart) applies, in order:
   - `20261101100000_add_fx_rate_sources`: enum `FxRateSource` (`BCV_USD`, `BCV_EUR`, `PARALELO_USD`, `MANUAL`); new columns in `Fx_Rate_Settings` (`source` default `BCV_USD`, `manualVesPerUsd`, `maxAgeHours` default 48, `maxVariationPct` default 15, `rateFetchedAt`, `providerUpdatedAt`, `lastError`, `lastErrorAt`, `rejectedReading`) plus a CHECK on thresholds; nullable `Orders.fxRateSource`; new tables `Fx_Rate_Snapshots` and `Fx_Setting_Audits`. The existing rate row is kept and gets `rateFetchedAt = updatedAt`.
   - `20261101150000_add_fx_setting_audit_action`: enum `FxSettingAction` and `Fx_Setting_Audits.action` (default `SETTINGS_UPDATED`, so existing rows are backfilled).
   - `20261101200000_add_vitrina_scoring`: enum `VitrinaRunMode`; tables `Product_Daily_Stats`, `Vitrina_Algorithm_Settings`, `Vitrina_Algorithm_Audits`, `Product_Score_Runs`, `Product_Scores`; `CREATE INDEX IF NOT EXISTS` on `Order_Lines(productId, createdAt)`, `Orders(status, createdAt)` and `Wishlist_Items(productId, createdAt)`; and an idempotent insert of the `default` row of `Vitrina_Algorithm_Settings` (the production deploy does not run `seed.ts`).
2. **No data is lost or rewritten**: every change is additive (new columns have defaults or are nullable; existing orders keep `fxRateSource = NULL`, which is how "older than the epic" is told). The only `UPDATE` is the `rateFetchedAt` backfill of the single rate row.
3. Deploy the backend **before** the frontend (new endpoints must exist when the new admin screens and the checkout call them).
4. Verify: `pnpm exec prisma migrate status` is up to date and `prisma migrate diff` shows no drift. The first start refreshes the rate and, if there is no ranking yet, computes one (both in the background; they never block the boot).

### 11.5 Home vitrina: stays `MANUAL` after deploying (A62)

Existing published vitrinas have no `mode`; the backend treats that as `MANUAL` and returns exactly what it returned before (same products, same order, in-stock only, no `vitrina` key). Nothing changes on the Home after the deploy. To adopt the ranking, in the admin Home editor choose `AUTO` or `MIXED` (with a `size` of 4 to 12), review the draft and publish. `MANUAL` needs at least one product; `AUTO`/`MIXED` accept an empty list. Sold-out or deactivated products disappear from every mode on the next read, without recomputing. If there is no ranking (or it is empty): `AUTO` shows an empty list and `MIXED` only the pinned products, never a 5xx.

### 11.6 Runbooks

**Stale rate.** `GET /admin/fx/status` (or the "Tasa de cambio" screen) shows `stale` (older than `maxAgeHours`, default 48 h) and `hardStale` (older than `maxAgeHours x 3`, default 144 h). While `stale` the checkout keeps working with the last rate; once `hardStale` Pago Movil answers 503 `FX_RATE_UNAVAILABLE` (Stripe is unaffected) and `GET /fx/current` answers 503 too. A `MANUAL` rate never expires. Steps: (1) read `lastError` and `rejectedReading`; (2) `POST /admin/fx/refresh`; (3) if the provider is down, switch to `MANUAL` with a rate you trust (`PUT /admin/fx/settings` with `source` and `manualVesPerUsd`); (4) check the log for `FX refresh` errors. Switching source when the new source has no fresh reading falls back to that source's last snapshot; when that snapshot is older than `maxAgeHours x 3` the PUT response carries `hardStale: true` (checkout would answer 503): refresh again or use `MANUAL`.

**Rejected reading.** A reading that is not finite, is <= 0, is out of range, is dated in the future or regresses, or varies more than `maxVariationPct` (default 15 %, exactly 15 % is accepted) is never applied: the rate stays, `rejectedReading` and `lastError` are filled, and the screen shows it. If the admin trusts it (a real devaluation jump), `POST /admin/fx/accept-rejected`; structurally invalid readings answer 422 `FX_REJECTED_READING_NOT_ACCEPTABLE` and with nothing to accept 409 `FX_NO_REJECTED_READING`. Every PUT and every acceptance is audited in `Fx_Setting_Audits` (`GET /admin/fx/audit`).

**Concurrent refreshes.** Only one refresh runs at a time (advisory lock): the others get 409 `FX_REFRESH_IN_PROGRESS` or no-op. Same for the ranking: a second `POST /admin/vitrina/recompute` gets 409 `RECOMPUTE_IN_PROGRESS`. Retry after a few seconds.

**`FX_SETTINGS_BUSY`.** `PUT /admin/fx/settings` / `POST /admin/fx/accept-rejected` could not get the FX advisory lock (`fx:refresh`) or the `Fx_Rate_Settings` row lock within 25 s (`SET LOCAL lock_timeout`; the transaction rolls back, nothing is written or audited). Usually a refresh or another change is stuck: retry; if it persists look for a long transaction in `pg_stat_activity` (`wait_event_type = 'Lock'`) and `pg_locks`. Since Story 19.4a the WHOLE `PUT /admin/fx/settings` (lock, provider read, second lock, post-commit refresh) shares one 45 s budget (`FX_PUT_BUDGET_MS`): a PUT that had to release the lock to read the provider and then waits again answers 409 at ~45 s instead of ~60 s (Nginx cut-off); measured worst case 45.0 s (`pnpm test:perf`, `test/fx-put-budget.perf.spec.ts`).

**`VITRINA_BUSY`.** `PUT /admin/vitrina/algorithm` waited 25 s for the settings lock held by a running recompute. Retry; if it persists look for a stuck transaction (`pg_stat_activity`).

### 11.7 The dev/seed database has an old rate

The rate row of a development or seed database is weeks old. After migrating, `rateFetchedAt = updatedAt` is older than `maxAgeHours x 3`, so **Pago Movil checkout answers 503 `FX_RATE_UNAVAILABLE` until the rate is refreshed** (Stripe works). It heals by itself at boot if `FX_REFRESH_ENABLED` is not `false` and the provider is reachable; otherwise use the admin button, `POST /admin/fx/refresh`, or set a `MANUAL` rate. In production this is the same situation right after the first deploy if the old rate is older than 144 h. The e2e suite pins `rateFetchedAt` to "now" for its duration and restores it afterwards (`test/helpers/global-fx-fresh.ts`), and also snapshots/restores `Landing_Config_Entries`, `Product_Daily_Stats` and the Vitrina tables, so running it never alters the real data.

### 11.8 Rollback

Prisma has no down migrations. The previous release keeps working against the migrated schema (new columns are nullable or have defaults; the new tables are ignored): roll back by redeploying the previous commit (section 5) and leave the migrations applied. Before rolling back, set the Home vitrina back to `MANUAL` with at least one product and publish it: a previous build does not understand `AUTO`/`MIXED` and would show an empty vitrina. Set `FX_REFRESH_ENABLED=false` and `VITRINA_CRON_ENABLED=false` if you want the crons off meanwhile.

A full schema revert is only for a disaster, loses data (rate history and audits, the per-order `fxRateSource` label, the ranking runs and `Product_Daily_Stats`) and must be done on a backup first:

```sql
-- Vitrina (20261101200000)
DROP TABLE "Product_Scores", "Product_Score_Runs", "Vitrina_Algorithm_Audits", "Vitrina_Algorithm_Settings", "Product_Daily_Stats";
DROP TYPE "VitrinaRunMode";
-- FX (20261101100000 and 20261101150000)
ALTER TABLE "Orders" DROP COLUMN "fxRateSource";
DROP TABLE "Fx_Setting_Audits", "Fx_Rate_Snapshots";
ALTER TABLE "Fx_Rate_Settings" DROP CONSTRAINT "Fx_Rate_Settings_fx_config_check",
  DROP COLUMN "source", DROP COLUMN "manualVesPerUsd", DROP COLUMN "maxAgeHours", DROP COLUMN "maxVariationPct",
  DROP COLUMN "rateFetchedAt", DROP COLUMN "providerUpdatedAt", DROP COLUMN "lastError", DROP COLUMN "lastErrorAt", DROP COLUMN "rejectedReading";
DROP TYPE "FxSettingAction";
DROP TYPE "FxRateSource";
DELETE FROM "_prisma_migrations" WHERE "migration_name" IN
  ('20261101100000_add_fx_rate_sources','20261101150000_add_fx_setting_audit_action','20261101200000_add_vitrina_scoring');
```

The three indexes created with `IF NOT EXISTS` are harmless and can stay.

### 11.9 `errorCode`s of the epic

- Rate: `FX_RATE_UNAVAILABLE` (503, checkout Pago Movil and `GET /fx/current`), `FX_MANUAL_RATE_REQUIRED` (400), `FX_REFRESH_IN_PROGRESS` (409), `FX_SETTINGS_BUSY` (409, `PUT /admin/fx/settings` or `POST /admin/fx/accept-rejected` waited 25 s for the FX advisory lock / settings row and gave up; Story 19.1, same `lock_timeout` mechanism as `VITRINA_BUSY`: the wait is bounded by the database, so Nginx never shows a 504), `FX_NO_REJECTED_READING` (409), `FX_REJECTED_READING_NOT_ACCEPTABLE` (422).
- Vitrina: `VITRINA_WEIGHTS_INVALID` (400, weights do not add up to 100), `VITRINA_PARAMS_INVALID` (400), `VITRINA_BUSY` (409), `RECOMPUTE_IN_PROGRESS` (409), `LANDING_BLOCK_INVALID` (400, invalid `mode`/`size`/empty `MANUAL`).

Additive contract note: `PUT /admin/fx/settings` now also returns `hardStale` (boolean); no existing field changed.

### 11.10 NFR-18.3: indexes and recompute time

`test/vitrina-scoring-perf.e2e-spec.ts` seeds 10 000 products and 30 000 order lines: the recompute runs in < 5 s with a constant number of statements, and `EXPLAIN` (with `enable_seqscan = off`) shows that the sales query can use `Orders_status_createdAt_idx` and `Order_Lines_productId_createdAt_idx`, and that the lookup of a product's sales by date uses the latter on its own. Note the honest limit: the loader's sales query filters by date only (no `productId`), so on a table this size the planner prefers a sequential scan of `Order_Lines`, and the (productId, createdAt) index would serve it only as a full index scan. At the expected volume that is cheaper than an index and the measured time stays far below the limit; if `Order_Lines` grows into millions of rows, add an index on `Order_Lines(createdAt)`.

### 11.11 Post-deploy verification checklist

1. `pnpm exec prisma migrate status` up to date; the service is `active` and the log shows `FX refresh` (or `DISABLED`) without errors.
2. `GET https://api.<domain>/api/v1/fx/current` -> 200 `{vesPerUsd, source, updatedAt, stale:false}`. If 503 follow 11.6/11.7.
3. Admin "Tasa de cambio": `status` has a recent `fetchedAt`; change source to each live feed and back (an audit row per change), `rejectedReading` empty.
4. A Pago Movil test checkout stores `fxRateSource` and `totalVes = totalUsd x rate`; the Stripe one keeps them `null`; an old order answers `fxRateSource: null`.
5. `POST /admin/vitrina/recompute` -> 200 with `mode` `RANKED` (or `FALLBACK` with few sales); `GET /admin/vitrina/preview?mode=AUTO&size=8` lists products whose breakdown adds up to the score.
6. The Home still shows the same vitrina (mode `MANUAL`, 11.5); publish an `AUTO`/`MIXED` draft only when ready.
7. View signal: `curl -i -X POST https://<DOMAIN>/api/v1/products/<id>/view -H 'User-Agent: Mozilla/5.0 Firefox/130.0'` twice from the same machine -> 204 both and `views` of today's `Product_Daily_Stats` row +1 (not +2). Visits through the storefront must not all come from one IP (11.3: `BACKEND_API_URL` on loopback).
8. Nginx: `grep -n 'X-Forwarded-For' /etc/nginx/sites-enabled/*` shows `$proxy_add_x_forwarded_for` on every proxy location; ports 3000/3001 unreachable from outside.
9. After a few days: `Product_Daily_Stats` has no rows older than 180 days and only the last 3 runs of `Product_Score_Runs` remain.

## 12. Epic 19: documentos legales, consentimiento y lanzamiento (Stories 19.1 a 19.9)

Esta sección es para Angel. Se lee de arriba abajo en el orden en que se hace: 12.1 desplegar, 12.2 si la migración se queda esperando, 12.3 si una migración falla, 12.4 las dos variables que se activan antes de abrir al público, 12.5 la checklist de lanzamiento, 12.6 riesgos y 12.7 volver atrás. Lo que **no** está verificado se dice en cada punto.

### 12.1 Qué cambia y cómo se despliega

**Qué trae el epic.** Seis documentos legales administrables (`terminos`, `privacidad`, `cookies`, `envios`, `devoluciones`, `aviso-legal`) con borrador, versiones inmutables, historial, diff y bitácora; registro de aceptación en registro y checkout; re-aceptación; declaración de mayoría de edad solo en registro y re-aceptación; identidad del vendedor para el pie de página. El frontend no añade variables de entorno.

**Migraciones (todas aditivas, sin pérdida de datos; se aplican con `prisma migrate deploy`, que `deploy/deploy.sh` ya ejecuta antes de reiniciar el servicio).** Las del epic son seis, no dos como decía la historia original: `20261101300000_add_legal_documents`, `20261102100000_freeze_legal_row_identity`, `20261102200000_enforce_legal_version_insert`, `20261102300000_harden_legal_effective_from`, `20261102400000_legal_draft_revision_monotonic` y `20261103100000_add_consent_records`. Solo la última toca una tabla caliente (`Orders`, cuatro columnas NULL nuevas: los pedidos históricos quedan con NULL). Las tablas de versiones, bitácora y `Consent_Records` quedan protegidas por triggers: `UPDATE`, `DELETE` y `TRUNCATE` fallan (la única excepción es el `SetNull` de la clave foránea y el borrado de filas ya huérfanas de `Consent_Records`).

**Orden de despliegue.**

1. Desplegar el **backend** (migraciones incluidas) con `LEGAL_REQUIRE_PUBLISHED=false` y `CHECKOUT_REQUIRE_SHIPPING` como esté (ver 12.4). `deploy/deploy.sh` **no corre ningún seed**.
2. Desplegar el **frontend** del epic (casillas de aceptación, modal de re-aceptación, páginas legales, banner de cookies). Hay que hacerlo antes de abrir al público: sin las casillas, el registro devuelve 400 `CONSENT_REQUIRED` (la declaración de edad se exige siempre) y, cuando los documentos estén publicados, también el checkout.
3. Sembrar los borradores con **`pnpm seed:legal`**, en el servidor, desde el directorio de la aplicación y con el entorno cargado (en producción el `.env` vive fuera del árbol de git y solo systemd lo lee):

   ```bash
   cd /opt/212cc/production/app            # o la ruta real del clon
   set -a; source /opt/212cc/production/shared/.env; set +a
   pnpm seed:legal
   ```

   Imprime una línea `Legal drafts: terminos=CREATED privacidad=CREATED ...`. Es idempotente: una segunda ejecución imprime `SKIPPED_...` en cada documento y no cambia nada; nunca publica ni toca un documento que ya tiene borrador o versión. **No uses `pnpm prisma db seed` ni `pnpm prisma:seed` en producción:** ese es el seed completo de desarrollo y, además de los borradores, inserta el catálogo de prueba (31 productos con ids fijos), un usuario admin de desarrollo, contenido de la Home y agencias de envío. (`seed:legal` usa `tsx`, que es dependencia de desarrollo: está instalada porque `deploy.sh` ejecuta `pnpm install --frozen-lockfile` sin `--prod`.)
4. Comprobar: `curl -s https://<DOMINIO>/api/v1/legal | head -c 600` lista seis documentos, todos `IN_PREPARATION`, y las páginas `/terminos`, `/privacidad`, etc. del sitio muestran «en preparación» y `noindex`. Todavía **no** se publica nada.

**Cómo funciona por dentro (solo si hay que depurar).**

- *Worker de Markdown.* `LegalMarkdownService` nunca analiza Markdown en el event loop. Tras un prefiltro O(n), el análisis va a un pool acotado de `worker_thread` (`src/legal/legal-markdown-pool.ts`): máximo 2 hilos, 16 trabajos en cola (más: 503 `LEGAL_MARKDOWN_BUSY` al instante), 3 s de plazo duro por análisis (400 `LEGAL_MARKDOWN_INVALID` con `details.reason` = `TIMEOUT`, que significa que el servidor no alcanzó, no que el texto esté mal) y 192 MB por hilo. El worker es el archivo `src/legal/legal-markdown.worker.mjs`, que `nest build` copia a `dist/legal/`: si falta `dist/legal/legal-markdown.worker.mjs` tras un build, toda validación responde «demasiado complejo». Importa `unified`, `remark-parse`, `remark-gfm` y `mdast-util-to-string`, que son dependencias de producción.
- *Lectura pública.* `GET /legal/...` obtiene el índice (toc) de una caché por contenido (SHA-256, 256 entradas); si no se alcanza a analizar, el índice es `[]` y el cuerpo se sirve igual.
- *Guarda de BD.* Un trigger BEFORE INSERT en `Legal_Document_Versions` toma un lock por documento, rechaza cualquier `versionNumber` distinto de `max + 1` (SQLSTATE 23000) y pone `publishedAt` con el reloj de la BD. Que el rol de la aplicación no pueda hacer `DISABLE TRIGGER` lo resuelve la Story 20.1 con un rol de BD limitado (sección 13): mientras la app siga corriendo como propietario de las tablas, un DBA sí puede desactivarlos.
- *Consentimiento.* Con la variable apagada, un documento requerido sin versión vigente **no** se exige ni se registra (el backend avisa con un WARN, a lo sumo uno por minuto y documento, y `Orders.termsVersion`/`shippingVersion`/`returnsVersion` quedan NULL). `POST /me/consent` exige solo lo pendiente. La declaración de edad se graba con la versión de Términos vigente (0 si no hay).

### 12.2 La migración se queda esperando (Story 19.4a)

Un `ALTER TABLE` espera un lock exclusivo y, mientras espera, todas las consultas posteriores sobre esa tabla se encolan detrás (en `Orders`: checkout y consultas de pedido se detienen). QA midió la migración de consentimiento esperando 28,5 s con un `SELECT` sobre `Orders` bloqueado 25 s, aunque el archivo empieza con `SET LOCAL lock_timeout = '10s'`.

- **Solo una migración tiene ese `SET LOCAL lock_timeout` sin efecto:** `20261103100000_add_consent_records` (no empieza con `BEGIN;`, y un `SET LOCAL` fuera de una transacción no hace nada). Ya está aplicada en desarrollo y su checksum no puede cambiar, así que se dejó como está: en una base donde siga pendiente, **no** acota la espera. Varias migraciones posteriores (Stories 20.1 y 20.3) sí fijan `SET LOCAL lock_timeout = '10s'`, pero dentro de `BEGIN;`, donde sí surte efecto (lista en el último punto de esta lista; `grep -rn lock_timeout prisma/migrations` la reproduce). Las migraciones nuevas no lo fijan (regla de abajo).
- **Verificado sobre un clon de la base** (lock de lectura sobre `Orders` retenido 25-40 s y un `ALTER TABLE "Orders" ADD COLUMN` de prueba):

  | Mecanismo | Resultado |
  |---|---|
  | `SET LOCAL lock_timeout = '10s'` como primera línea de `migration.sql` | **sin efecto**: esperó hasta que se liberó el lock (38 s) |
  | `PGOPTIONS='-c lock_timeout=10s' pnpm prisma migrate deploy` | **sin efecto** (23 s y 38 s): el motor de Prisma no lee `PGOPTIONS` |
  | parámetro `options` en la cadena de conexión: `DATABASE_URL='postgresql://...?schema=public&options=-c%20lock_timeout%3D10000'` | **funciona**: falla a los ~10 s con SQLSTATE `55P03` |
  | `SET lock_timeout = '10s';` de sesión (sin `LOCAL`) como primera línea de una migración nueva | **funciona**: falla a los ~10 s con `55P03` |

- **`deploy/deploy.sh` lo aplica** (es el único sitio donde corre `prisma migrate deploy` en CI/CD): añade `options=-c lock_timeout=<ms>` a la `DATABASE_URL` que ve **solo** el comando de migración (por defecto `MIGRATE_LOCK_TIMEOUT_MS=10000`). Si la espera vence, el script se detiene **antes de reiniciar el servicio** (sigue corriendo la versión anterior). Se niega a correr si `DATABASE_URL` ya trae un parámetro `options`. Probado contra el clon con y sin `?schema=public`; **no** se ha ejecutado en un VPS real (ver «Verification status»).
- **Salida del script:** muestra la salida de Prisma filtrada: se tachan las URL y la línea `Datasource ...` (que trae usuario, host y puerto de la base). Es un filtro de mejor esfuerzo, **no** una garantía de que nunca aparezca otro dato de conexión en otra línea; no pegues esa salida en lugares públicos sin mirarla.
- **Ejecución manual** (fuera de `deploy.sh`): usa la cadena con `options`, no `PGOPTIONS`.
- **Migraciones nuevas (regla de la 20.3):** **no fijes `lock_timeout` dentro del archivo** (ni `SET LOCAL` ni `SET` de sesión). `deploy.sh` ya lo acota con `options=-c lock_timeout=<MIGRATE_LOCK_TIMEOUT_MS>` y una línea `SET ... lock_timeout = '10s'` en la migración **anula** ese valor para toda la migración: con `MIGRATE_LOCK_TIMEOUT_MS=3000` seguiría esperando 10 s, y con `60000` fallaría a los 10 s. Si una migración necesita la espera acotada, depende del `options` de `deploy.sh` (o, en ejecución manual, de la cadena con `options` de arriba). Empieza con `BEGIN;` en la primera línea. Si una migración debe tomar locks de varias tablas, hazlo con `LOCK TABLE` al principio (todo o nada) y deja que el `options` ponga el límite.
- **Migraciones ya escritas con `SET LOCAL lock_timeout = '10s'`** (no se editan: su checksum ya está aplicado en desarrollo): `20261103100000_add_consent_records`, `20261104200000_legal_revision_never_decreases`, `20261105100000_audit_chain_hardening`, `20261106100000_iddoc_encrypted_columns`, `20261106200000_audit_restore_safe` y `20261106210000_pin_trigger_function_search_path` (`grep -rn lock_timeout prisma/migrations`). Las cinco que empiezan con `BEGIN;` (todas menos `add_consent_records`) tienen el `SET LOCAL` dentro de su transacción, así que **sí surte efecto**: en una base donde alguna siga pendiente, la espera de **esa** migración es siempre 10 s, sea cual sea `MIGRATE_LOCK_TIMEOUT_MS` (más alto o más bajo). En `add_consent_records` (sin `BEGIN;`) el `SET LOCAL` no hace nada y manda el `options` de `deploy.sh`.
- **Si la espera vence** (o cualquier otra sentencia falla) la migración queda registrada como fallida y Prisma se niega a seguir (`P3009`). **No basta con `resolve --rolled-back` y reintentar:** sigue 12.3. Las migraciones **no** son atómicas.

### 12.3 Una migración falló: guía de recuperación (verificada sobre un clon)

`prisma migrate deploy` **no** envuelve un `migration.sql` en una transacción: si la sentencia N falla, la N se revierte pero las sentencias 1..N-1 **quedan confirmadas** (tres pruebas: un lock timeout, `SELECT 1/0` y un `ALTER` de una tabla inexistente, cada una tras un `CREATE TYPE`; todas dejaron el tipo). `migrate resolve --rolled-back` solo edita la fila de `_prisma_migrations`; no deshace nada. Si reintentas sin limpiar, la primera sentencia vuelve a fallar con `42710 type "..." already exists` (o `42P07 relation ... already exists`). El orden es: **identificar, limpiar, resolver, confirmar, reintentar.**

**Prepara la sesión** (en el servidor, como el usuario del servicio, desde el directorio de la aplicación). La cadena de conexión se carga en el entorno de esta sesión; no la imprimas ni la pegues en ningún sitio:

```bash
cd /opt/212cc/production/app                 # o la ruta real del clon
set -a; source /opt/212cc/production/shared/.env; set +a
```

`psql` puede no estar instalado en el servidor (el VPS solo necesita Node; el cliente viene con el paquete `postgresql-client`). Hay dos formas, elige una:

- **Con `psql`** (si `command -v psql` lo encuentra). `psql` no acepta el sufijo `?schema=public`, de ahí `${DATABASE_URL%%\?*}`:

  ```bash
  q() { psql "${DATABASE_URL%%\?*}" -At -c "$1"; }
  ```
- **Sin `psql`**, con Node, que ya está y trae el módulo `pg` (dependencia de la aplicación; el comando va desde el directorio de la aplicación):

  ```bash
  q() { node --input-type=module -e 'import pg from "pg"; const c = new pg.Client({ connectionString: process.env.DATABASE_URL.split("?")[0] }); await c.connect(); const r = await c.query(process.argv[1]); for (const row of r.rows ?? []) console.log(Object.values(row).join("|")); await c.end();' "$1"; }
  ```

A partir de aquí todo usa `q '<SQL>'`. Prisma también puede ejecutar SQL sin `psql` (`echo '<SQL>' | pnpm prisma db execute --stdin`), pero no imprime filas: sirve para los `DROP` del paso 3, no para las comprobaciones.

1. **Identifica qué falló y guárdalo en `MIG`.** Con un comando, sin copiarlo a mano (la migración fallida es la que tiene `finished_at` y `rolled_back_at` vacíos):

   ```bash
   MIG=$(q 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 1')
   echo "$MIG"
   ```

   Debe imprimir un solo nombre (por ejemplo `20261103100000_add_consent_records`). Si no imprime nada, no hay migración fallida registrada y esta guía no aplica; si el nombre no es el que esperas, detente. Contrástalo con `pnpm prisma migrate status` (lista `The failed migration(s)`).
2. **Averigua qué dejó a medias.** Abre `prisma/migrations/$MIG/migration.sql`: todo objeto creado por una sentencia **anterior** a la que falló existe ahora; la sentencia que falló y las siguientes no. La que falló es la primera que toma un lock sobre una tabla ocupada (`ALTER TABLE`, `CREATE INDEX`, `ADD CONSTRAINT`) o la que nombra el error de Prisma.
3. **Limpia, pero este paso vale SOLO si el fallo fue en el `ALTER TABLE "Orders"` de `20261103100000_add_consent_records`.** En ese caso concreto las sentencias previas son los dos `CREATE TYPE`, así que los restos son exactamente los tipos `"ConsentType"` y `"ConsentContext"`; la tabla `"Consent_Records"`, sus índices, restricciones, funciones, triggers y las cuatro columnas de `"Orders"` **no** existen. Compruébalo en vez de suponerlo:

   ```bash
   q "SELECT typname FROM pg_type WHERE typname IN ('ConsentType','ConsentContext') ORDER BY 1"
   q "SELECT to_regclass('\"Consent_Records\"')"
   q "SELECT column_name FROM information_schema.columns WHERE table_name = 'Orders' AND column_name IN ('termsVersion','termsAcceptedAt','shippingVersion','returnsVersion')"
   ```

   Esperado: dos filas (los tipos), la segunda consulta vacía, la tercera sin filas. Si todo coincide, borra solo esos restos (no contienen datos, nada los referencia todavía, sin `CASCADE`):

   ```bash
   echo 'DROP TYPE "ConsentContext"; DROP TYPE "ConsentType";' | pnpm prisma db execute --stdin
   ```

   **Si el fallo fue en otra migración, o en otra sentencia, o si hay más objetos de los que explican las sentencias anteriores: no ejecutes ese `DROP`.** Haz el paso 2 con el archivo de *esa* migración, identifica sus objetos con consultas parecidas (`pg_type`, `to_regclass`, `information_schema`, `pg_trigger`, `pg_proc`) y borra solo lo que puedas rastrear hasta ese archivo. Si algo no se puede rastrear, detente y pregunta: no borres nada que no sepas de dónde salió. Si el fallo fue en la **primera** sentencia, no queda nada que limpiar.
4. **Márcala como revertida:** `pnpm prisma migrate resolve --rolled-back "$MIG"`.
5. **Confirma con `pnpm prisma migrate status`:** debe decir `Following migration have not yet been applied: <MIG>` y **no** listar una migración fallida. Si todavía informa el fallo, el paso 4 no surtió efecto.
6. **Reintenta fuera de hora punta** (poco tráfico, sin informes largos ni procesos por lotes): vuelve a lanzar el despliegue (`deploy/deploy.sh <entorno> <ref>`) o `pnpm prisma migrate deploy` con la cadena `options=-c%20lock_timeout%3D10000` de 12.2. Al final `pnpm prisma migrate status` debe terminar con `Database schema is up to date!`. Si falla otra vez (p. ej. la transacción larga sigue ahí), la migración queda de nuevo como fallida con los mismos restos: repite desde el paso 1.

Nunca marques una migración `--applied` sin haber comprobado que **todos** los objetos del archivo existen. Un `P3009` que sale de un despliegue que no esperó ningún lock (el fallo anterior sigue registrado) necesita el mismo procedimiento; `deploy.sh` dice cuál de los casos ocurrió (espera de lock `55P03`, `P3009`, violación única `23505`, objeto ya existente `42710`/`42P07`) y filtra lo que imprime según 12.2.

**Red de seguridad para migraciones futuras** (verificada sobre el clon con migraciones desechables; nada de esto edita una migración ya aplicada). Prisma acepta un `BEGIN;` ... `COMMIT;` escrito en el archivo, y entonces lo de en medio es atómico.

| Forma de `migration.sql` (lock retenido sobre `"Orders"` por otra sesión, `lock_timeout` 10 s) | Tras el fallo |
|---|---|
| `CREATE TYPE ...;` y luego `ALTER TABLE "Orders" ...;` (lo que hizo 19.4) | `55P03` a los 10 s; **el tipo se queda** (necesita la limpieza de arriba) |
| `ALTER TABLE "Orders" ...;` **primero**, nada antes | `55P03`; no queda nada |
| `BEGIN; LOCK TABLE "Orders" IN ACCESS EXCLUSIVE MODE; CREATE TYPE ...; ALTER TABLE "Orders" ...; COMMIT;` | falla a los 10 s; **no queda nada**; basta `resolve --rolled-back` y reintentar. Sin holder se aplica normal |
| `BEGIN; CREATE TYPE ...; SELECT 1/0; COMMIT;` | no queda nada |
| `CREATE TYPE ...;` **y luego** `BEGIN; ...; COMMIT;` | resultados inconsistentes entre pruebas: no te apoyes en esto; `BEGIN;` va en la **primera línea** |

Reglas para migraciones nuevas que alteren una tabla grande o caliente: (1) envuelve el archivo en `BEGIN;` ... `COMMIT;` y toma el lock **primero** (`LOCK TABLE "<tabla>" IN ACCESS EXCLUSIVE MODE;`); (2) si no cabe una transacción (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE`), que el `ALTER` arriesgado sea la **primera** sentencia y una por migración; (3) cuando una sentencia falla dentro de la transacción del propio archivo, Prisma informa `current transaction is aborted, commands ignored until end of transaction block` en vez de `55P03` (el error original solo está en el log de Postgres; `deploy.sh` reconoce ese mensaje); (4) revisión de cada migración nueva: «si falla la sentencia N, ¿qué dejan las 1..N-1?».

### 12.4 Antes de abrir al público: dos variables del backend

Ambas se leen en cada petición (no se validan al arrancar), pero son variables de entorno del proceso: cambiarlas en producción exige editar `/opt/212cc/production/shared/.env` y **reiniciar el servicio** (`sudo systemctl restart 212cc-backend-production.service`). Solo vale el texto exacto `true` (`TRUE`, `1`, `yes` o ` true ` **no** activan).

**`LEGAL_REQUIRE_PUBLISHED=true`** (por defecto `false`). Ponla **solo cuando** los cuatro documentos con aceptación (`terminos`, `privacidad`, `envios`, `devoluciones`) estén publicados con una versión vigente. Qué pasa en cada caso:

| Variable | Documento requerido sin versión vigente | Documentos publicados |
|---|---|---|
| `false` (por defecto) | **No se exige ni se registra** su aceptación; se vende sin esos términos (el backend avisa con un WARN y `Orders.termsVersion`/`shippingVersion`/`returnsVersion` quedan NULL). Aceptable en desarrollo y pruebas; **un error grave en producción**. | Se exigen y se registran las casillas de los documentos que sí tienen versión vigente. |
| `true` | Registro, checkout y `POST /me/consent` responden **503 `LEGAL_NOT_PUBLISHED`** (`details.documents` dice cuáles): la tienda no puede vender ni dar de alta cuentas hasta publicarlos. No existe retiro de documentos, solo versiones nuevas: no se puede volver a ese estado por accidente. | Funciona normal: cada cuenta y cada pedido guarda las versiones aceptadas. |

La declaración de mayoría de edad se exige siempre, con la variable en `true` o `false`. `cookies` y `aviso-legal` no tienen casilla y no bloquean nada. Para activar: publica los cuatro (admin → Legal; cada uno exige haber reemplazado todos los `[[PLACEHOLDERS]]` y quitado el aviso de plantilla), comprueba `curl -s https://<DOMINIO>/api/v1/legal/current-versions` (deben aparecer los cuatro), pon la variable, reinicia, y haz un registro y una compra de prueba. Para desactivar en una emergencia: `false` y reiniciar (las ventas continúan sin exigir aceptación: úsalo solo mientras se corrige).

**`CHECKOUT_REQUIRE_SHIPPING=true`** (por defecto `false`). Decisión de Angel: con ella la cédula del comprador es **obligatoria en las facturas**; con `false` el checkout acepta también la dirección plana antigua (sin agencia ni cédula) y entonces la cédula no es obligatoria, lo que contradice lo que dicen los Términos, Envíos y Privacidad. Con `true`, la dirección plana se rechaza con 400 `SHIPPING_REQUIRED`: actívala **después** de desplegar el frontend del Epic 17 (que ya envía `customerAddressId` o `shippingAgencyId` + `deliveryMode` + `recipientIdDoc`) y de verificar una compra real en ese formato; ver §10.1. Para volver atrás: `false` y reiniciar.

### 12.5 Checklist de lanzamiento

Marca cada punto solo cuando lo hayas comprobado tú. Los textos sembrados son **plantillas orientativas, no asesoría jurídica** (A64): ningún documento sale sin revisión de un abogado venezolano.

**A. Identidad del vendedor y placeholders**

- [ ] Admin → Legal → Identidad: razón social, RIF, domicilio fiscal, registro mercantil, correo, teléfono y horario completos (alimentan el pie de página y el Aviso Legal). Sin esos datos el pie de página omite la línea.
- [ ] Reemplazar **todos** los placeholders `[[...]]` de los seis documentos (la publicación se bloquea mientras quede uno, y también mientras quede el aviso «Plantilla — revisar con un abogado antes de publicar»). Los de plazos y datos del negocio: `[[PLAZO_DESPACHO]]`, `[[PLAZO_TRANSITO_ESTIMADO]]`, `[[PLAZO_RECLAMO]]`, `[[PLAZO_RESPUESTA_RECLAMO]]`, `[[PLAZO_REEMBOLSO]]`, `[[POLITICA_DE_REENVIO]]`, `[[COSTO_DE_ENVIO_Y_QUIEN_LO_PAGA]]`, `[[LISTA_DE_AGENCIAS]]`, `[[HOSTING]]`, `[[PROVEEDOR_CORREO]]`, `[[FUENTE_TASA_BS]]`, `[[CONTADOR_O_IMPRENTA]]`, `[[PLAZO_CONSERVACION_*]]`, `[[PLAZO_RESPUESTA_DERECHOS]]`, `[[CIUDAD_JURISDICCION]]`, `[[FECHA_VERSION]]`.
- [ ] Revisión de los seis textos por un abogado venezolano (los `[[REVISAR_*]]` y `[[CONFIRMAR_CON_ABOGADO*]]` son sus puntos).

**B. Marcadores `CONFIRMAR_*` / `VERIFICAR_*`: qué se puede confirmar hoy y qué no.** Un marcador se quita del texto **solo si lo que afirma es cierto**. Los que dependen del Epic 20 **no se pueden confirmar todavía** (no están implementados); si se publican antes, el texto debe seguir sin afirmarlos.

*Dependen de stories ya hechas: se pueden verificar y confirmar hoy.*

- [ ] `CONFIRMAR_REGISTRO_DE_ACEPTACION_IMPLEMENTADO` (19.4): cada registro y cada compra graban `Consent_Records`; prueba con una cuenta y un pedido de prueba y mira `GET /api/v1/admin/legal/consents`.
- [ ] `CONFIRMAR_DECLARACION_DE_MAYORIA_DE_EDAD_IMPLEMENTADA` (19.4 y 19.7): casilla de edad en registro y en la re-aceptación (no en el checkout).
- [ ] `CONFIRMAR_CHECKOUT_REQUIRE_SHIPPING_ACTIVO_PARA_CEDULA_OBLIGATORIA`: solo es cierto con `CHECKOUT_REQUIRE_SHIPPING=true` (12.4).
- [ ] `CONFIRMAR_NO_HAY_RETIRO_EN_TIENDA`: el backend ya rechaza `pickup` (`PICKUP_NOT_SUPPORTED`); confirma que el negocio tampoco ofrece retiro.
- [ ] `VERIFICAR_CLAVES_DE_ALMACENAMIENTO_LOCAL_CONTRA_EL_SITIO_PUBLICADO` y `VERIFICAR_NOMBRES_Y_DURACIONES_CONTRA_EL_SITIO_PUBLICADO` (19.8): compara el texto de Cookies con lo que de verdad guarda el sitio publicado (cookie de preferencias `212_cookie_prefs`, 1 año; sesión, carrito) mirando el navegador en producción.

*Dependen del negocio, el contador o el abogado (no del código):* `CONFIRMAR_PRODUCTOS_ORIGINALES_CON_EL_DUENO`, `CONFIRMAR_UBICACION_DE_PROVEEDORES`, `CONFIRMAR_QUIEN_PAGA`, `CONFIRMAR_IVA_E_IGTF_CON_CONTADOR`, `CONFIRMAR_METODO_DE_FACTURACION_CON_CONTADOR`, `CONFIRMAR_METODOS_DE_PAGO_VIGENTES`, `CONFIRMAR_CRITERIO_DE_TASA_EN_REEMBOLSOS`, `CONFIRMAR_CON_ABOGADO_QUE_NO_REQUIERE_CONSENTIMIENTO` y `CONFIRMAR_CON_ABOGADO`.

*Dependen del Epic 20 (Stories 20.2 a 20.9): NO confirmar todavía.*

- [ ] `CONFIRMAR_CEDULA_CIFRADA_Y_ENMASCARADA_IMPLEMENTADA` (20.2, 20.3, 20.4, 20.9): el Epic 20 aún no está implementado: la cédula no se cifra en la base y la consulta de pedido la devuelve completa (sin enmascarar).
- [ ] `CONFIRMAR_CEDULA_EN_ALMACENAMIENTO_LOCAL_DEL_NAVEGADOR` (20.9): la libreta del frontend guarda la cédula en `localStorage` en claro (sin story que lo corrija todavía fuera del 20.9).
- [ ] `CONFIRMAR_RETENCION_FISCAL_DE_CEDULA_IMPLEMENTADA` (20.6 y 20.8) y `CONFIRMAR_REGISTRO_DE_CONSULTAS_DE_CEDULA_IMPLEMENTADO` (20.4, 20.5 y 20.7): todavía no existen.
- [ ] `CONFIRMAR_REGISTRO_DE_USO_7_DIAS_IMPLEMENTADO` (20.7, `privacidad` §2, §3, §7 y §9): confírmala cuando el despliegue tenga la migración `20261110100000_add_usage_logs_retention`, el log activo (`USAGE_LOG_ENABLED` no es `false`) y la purga diaria funcionando (`PURGE_USAGE_LOG_DAYS`, 19.6). **`CONFIRMAR_CON_ABOGADO_BASE_LEGAL_DEL_REGISTRO_DE_USO`** (20.7) es del abogado: si el interés legítimo basta para guardar IP y agente de usuario 7 días y si ese plazo es el adecuado (19.2).
- [ ] `CONFIRMAR_BORRADO_DE_SESIONES_VENCIDAS_IMPLEMENTADO` y `CONFIRMAR_BORRADO_DE_CARRITOS_Y_LISTAS_ANONIMOS_VENCIDOS_IMPLEMENTADO` (20.8, ver §20): el job existe y el texto de `privacidad` §7 coincide con lo que hace (sesión vencida: se elimina a los 7 días de vencer; IP y agente: se anulan a los 90 días de **creada** la sesión y solo si ya venció, una sesión viva no se toca; carritos y listas anónimos: se eliminan al vencer su cookie de 30 días con renovación). **Confírmalos solo cuando la corrida ya haya pasado en producción**: despliega con `NODE_ENV=production` (el job arranca solo en producción o con `RETENTION_PURGE_ENABLED=true`), pulsa `POST /admin/retention/run` o espera la de las 04:30 UTC y mira `GET /api/v1/admin/retention/runs` (estado `OK`, `auditedAt` no nulo, las tareas `sessions_expired`, `session_pii`, `anon_carts` y `anon_wishlists` sin `error`). Lo que el texto promete y el valor de la variable: `PURGE_SESSION_PII_DAYS` solo admite 30..90 justamente para que «90 días» no pueda volverse falso. **Los plazos de §7 que dependen de ti** (contactos 12 meses, comprobantes, cédula) están en §20.8, en la lista de decisiones.

*Sin implementación prevista en ningún epic:* `CONFIRMAR_SEGUIMIENTO_VISIBLE_AL_CLIENTE` (`envios` §6). El frontend no muestra la guía de envío al cliente ni deja cargarla desde el admin (solo existe `PATCH /admin/orders/:id/tracking`). No lo confirmes; o se implementa, o el texto no debe prometerlo.

**C. Publicar y activar**

- [ ] Publicar `terminos`, `privacidad`, `envios` y `devoluciones` (los cuatro con aceptación) y además `cookies` y `aviso-legal`. Usa vigencia «ahora» solo si el servidor y el sitio están listos: una vigencia lejana congela el documento hasta esa fecha.
- [ ] Solo entonces: `LEGAL_REQUIRE_PUBLISHED=true` y reiniciar (12.4); `CHECKOUT_REQUIRE_SHIPPING=true` y reiniciar (12.4).
- [ ] Probar en producción: registro (con las casillas), compra con cédula, modal de re-aceptación con una cuenta antigua, `/terminos`… con versión, fecha e índice, banner de cookies (Rechazar deja la analítica apagada).
- [ ] `POST /me/consent` y las rutas legales públicas responden 200; `GET /api/v1/legal` lista seis `PUBLISHED`.

**D. Credenciales**

- [ ] **Rotar antes de lanzar toda credencial real que haya estado alguna vez en un `.env` de desarrollo** (o que haya pasado por `/tmp`, el chat o una copia de seguridad del equipo): claves de Stripe y su secreto de webhook, `TCGAPI_KEY`, SMTP, contraseñas de base de datos y de los usuarios admin, y los secretos de sesión (`ADMIN_AUTH_SECRET`, `CUSTOMER_AUTH_SECRET`, `COOKIE_SECRET`; rotar estos cierra todas las sesiones). Genera valores nuevos con `openssl rand -hex 32` y ponlos solo en los `.env` de `/opt/212cc/<entorno>/shared/`.

### 12.6 Riesgos del epic (R1 a R7) y lectura legal pendiente

- **R1.** Desplegar sin documentos publicados con `LEGAL_REQUIRE_PUBLISHED=false` vende sin términos aceptados. Mitigación: 12.4 y 12.5-C.
- **R2.** El registro no es atómico: la cuenta se crea y la aceptación se graba en una transacción corta aparte, con borrado compensatorio de la cuenta si falla (A77). Una caída entre ambos pasos puede dejar una cuenta sin registro de aceptación: el modal de re-aceptación la detecta como «pendiente».
- **R3.** El trigger de `Consent_Records` permite borrar evidencia de cuentas o pedidos ya eliminados (filas huérfanas); se revisa con la retención del Epic 20.
- **R4.** `remark`/`react-markdown` son ESM: el build de Nest y el de Next ya los empaquetan (verificado con `pnpm build` en ambos).
- **R5.** El frontend cachea las páginas legales hasta 5 minutos (ISR): una versión con vigencia futura aparece por expiración natural, no al instante (publicar y guardar identidad sí invalidan la caché).
- **R6.** Con `LEGAL_REQUIRE_PUBLISHED=true` el 503 `LEGAL_NOT_PUBLISHED` bloquea ventas si faltara un documento; como no existe retiro de documentos, solo ocurriría por restaurar una base anterior.
- **R7.** Las plantillas sembradas no son asesoría jurídica (A64); el seed solo crea borradores y la publicación se bloquea mientras haya placeholders o el aviso de plantilla.
- **Lectura legal pendiente (A72).** El beacon de vistas de producto es agregado y anónimo (sin cookies ni identificadores) y se considera fuera del régimen de consentimiento; el frontend no lo envía si el navegador emite Global Privacy Control o Do Not Track, y se declara en Cookies y Privacidad. **Un abogado debe confirmar esta lectura**; hasta entonces es una suposición del equipo.

### 12.7 Volver atrás

Las columnas y tablas nuevas son inertes para la compilación anterior: despliega la versión anterior (§5) y deja las migraciones aplicadas. `Consent_Records` no se puede truncar por diseño, y las versiones y la bitácora tampoco. Antes de volver atrás pon `LEGAL_REQUIRE_PUBLISHED=false` y `CHECKOUT_REQUIRE_SHIPPING=false` si estaban en `true`.

## 13. Epic 20, Story 20.1: auditoría inmutable y rol de BD limitado

Esta sección es para Angel. 13.1 qué trae, 13.2 las migraciones, 13.3 **el paso que tienes que hacer tú** (el rol de BD limitado), 13.4 variables, 13.5 anclaje del hash, 13.6 lo medido, 13.7 lo que **no** está verificado, 13.8 volver atrás. El resto del Epic 20 (cédula cifrada, purgas, `Usage_Logs`) tendrá su propio apartado cuando se implemente (Story 20.10).

### 13.1 Qué trae la Story 20.1

- Tabla `Audit_Events` (solo se añade, nunca se cambia ni se borra): triggers que rechazan `UPDATE`, `DELETE` y `TRUNCATE` (SQLSTATE `23000`), un trigger que exige que cada fila nueva sea el `seq` siguiente con el hash de la anterior (la cadena no se puede bifurcar ni dejar huecos) y `REVOKE UPDATE, DELETE, TRUNCATE` a todo rol que no sea superusuario ni propietario. Cada fila lleva el hash SHA-256 de la anterior más su contenido (cadena de hash). Tabla `Audit_Verifications` (registro operativo de cada verificación; esa sí admite `UPDATE`).
- `AuditService` (único escritor), `GET /admin/audit/events|events/:seq|head|verifications` y `POST /admin/audit/verify`, todos tras `AdminAuthGuard` y todos de solo lectura salvo `verify` (que solo añade su propio evento `AUDIT_VERIFIED`).
- Cada respuesta HTTP lleva `X-Request-Id` (uuid generado por el servidor; el que mande el cliente se ignora).
- Verificación semanal automática (`AUDIT_VERIFY_CRON`, domingo 05:00 UTC) y, si defines `AUDIT_ANCHOR_EMAIL`, envío del hash de cabeza por correo.
- Un segundo trigger para que `Legal_Drafts.revision` y `Legal_Documents.draftRevisionFloor` no bajen nunca con el rol de la app (observación de 19.2).
- `scripts/db-roles.sql` (`pnpm db:roles`): crea el rol limitado.
- **Todavía no se emite ningún evento de negocio** (pagos, órdenes, FX, login...: Stories 20.4 a 20.8). Tras desplegar solo aparecen los `AUDIT_VERIFIED` que tú generes.

### 13.1b Segunda ronda de QA de la 20.1 (qué cambió)

- **Lo que se hashea es lo que Postgres guarda.** Todo texto que llega al log (columnas, `reason`, claves y valores de `before`/`after`) se normaliza en la app antes de hashear e insertar: un *surrogate* suelto (un emoji cortado por un `slice()`) y `U+0000` pasan a `U+FFFD`; `reason` se corta a 500 **caracteres** (no unidades UTF-16) sin partir un par; `entityType`/`entityId` se miden en caracteres. El `INSERT` devuelve la fila guardada y se recalcula su hash con el mismo código del verificador: si no coincide, la acción se aborta en el acto (`AuditRoundTripError`, 500, log de error) en vez de dejar una cadena que nunca podrá verificar.
- **IP:** `audit_normalize_ip(text)` (migración nueva) hace el cast a `inet` dentro de un bloque de excepción y devuelve `NULL` si falla; antes un `X-Forwarded-For: fe80::1%eth0` (sin nginx) abortaba la transacción de la acción. Se acepta `[::1]:443` y `1.2.3.4:80`, se elimina el *zone id* y lo demás queda en `NULL`.
- **`occurredAt`:** el trigger de la cadena rechaza (SQLSTATE `23000`) una fila anterior a la previa, una más de 1 minuto en el futuro y una anterior a 2020. Sin cota inferior frente a `now()` para no romper una restauración con triggers. El servicio nunca escribe una hora anterior a la cabeza (si el reloj retrocedió, reutiliza la de la cabeza).
- **Guard de PII/floats** (`src/audit/audit-payload.ts`, criterio en su cabecera y en AD-99): por defecto **estricto** (lanza `AuditPayloadError`: se ve en los tests) y **permisivo en producción** (`NODE_ENV=production`: enmascara el valor con `[REDACTED:...]`, convierte floats en texto, registra rutas y motivos, nunca valores, y la acción sigue). Un falso positivo ya no puede tumbar una venta. `AUDIT_PAYLOAD_STRICT=true|false` lo fuerza. El `reason` siempre se enmascara, nunca se rechaza.
- **Verificación parcial:** `Audit_Verifications.partial` (`fromSeq` > 1, cortada por `limit` o incremental). `POST /verify` responde `partial` y `GET /verifications` añade `lastCompleteVerificationAt` (última OK de una sola pasada génesis-cabeza). El cron devuelve `INCOMPLETE` (no `OK`) si llega a 50 trozos sin terminar la cadena, lo registra como error y lo dice en el asunto del correo ancla.
- **`AUDIT_ANCHOR_EMAIL`:** sin definir, producción avisa (`WARN`) al arrancar, y `GET /admin/audit/head` y `/verifications` devuelven `anchorEmailConfigured` para la pantalla 20.9.
- **`GET /head`:** `count` es el `seq` de la última fila (el trigger solo admite `seq = anterior + 1`, así que coincide con `count(*)` mientras la cadena esté íntegra; un hueco lo detecta la verificación). Ya no hace un `count(*)` O(n).
- **Filtros de `GET /events`:** fechas con calendario estricto (`2026-02-30` es 400, años fuera de 2000-2999 son 400), `entityId` sin NUL ni *surrogates* sueltos, `cursor`/`seq` ≤ 2^53: todo 400 `AUDIT_FILTER_INVALID`, nunca 500.
- **Uso seguro de `record`:** ver la cabecera de `AuditService`. El lock de cadena se retiene hasta el `COMMIT`: usa `AuditService.transaction` (el lock se toma al final, después de tu callback) o llama a `record` como **última** sentencia y sin ningún `await` lento después (Stripe, correo, HTTP). Un test estático (`findRecordMisuse`) lo comprueba en cada call site. Prisma no tiene un gancho previo al commit, así que no se puede diferir el lock de una transacción que no abre `AuditService`.
- **Contraseña del rol:** `pnpm db:roles` convierte `APP_DB_PASSWORD` en un verificador SCRAM-SHA-256 en el cliente y el servidor nunca ve la contraseña: si `CREATE ROLE` falla, Postgres escribe la sentencia en su log (`CONTEXT: SQL statement "CREATE ROLE ... PASSWORD ..."`) y antes ahí quedaba la contraseña en claro. `scripts/db-roles.sql` rechaza una contraseña que no sea SCRAM. Aun así: un log de Postgres no es un buen sitio para nada secreto, rota la contraseña si alguna vez falló con una versión anterior.
- **`_prisma_migrations`:** con el `init` del compose en volumen vacío el rol se crea antes de que Prisma cree la tabla y los privilegios por defecto le daban DML; la migración `20261105110000_revoke_prisma_migrations_from_app_roles` se lo quita a los roles `collectorsclub_<env>_app` (solo a esos).
- **Tests e2e:** ningún esquema `audit_t_*` sobrevive a una corrida: un `globalSetup` borra los de la corrida y los de más de 3 h.
- `AUDIT_VERIFY_CRON` escrito solo en `.env` se **ignora en desarrollo** (se lee del entorno del proceso antes de cargar `.env`): expórtalo en la shell.

### 13.1c Tercera ronda de QA de la 20.1 (qué cambió)

- **Datos públicos del vendedor en `SELLER_IDENTITY_UPDATED`.** El guard rechazaba `rif`, `address`, `sellerEmail`, `phone`, `pagoMovilBank`... (en producción los enmascaraba como `[REDACTED:KEY]` y el evento perdía su contenido). Esos datos los publica el propio vendedor; lo que el guard protege es la PII de los *clientes*. Mecanismo: cada acción del catálogo (`AUDIT_ACTIONS`) puede declarar `publicFields`, un mapa *clave exacta → clases de valor de las que queda exenta* (`EMAIL`, `PHONE`, `CEDULA`). Solo `SELLER_IDENTITY_UPDATED` lleva la lista del vendedor (`legalName`, `rif`, `sellerRif`, `fiscalAddress`, `legalAddress`, `address`, `contactEmail`, `sellerEmail`, `phone`, `sellerPhone`, `phoneCountry`, `pagoMovilPhone`, `pagoMovilBank`, `pagoMovilRif`); `PAYMENT_PAGO_MOVIL_*` solo `pagoMovilBank` (la palabra *movil* disparaba el guard) y `SHIPPING_AGENCY_CHANGED` solo `address` y `branches[].address` (sucursal del transportista). **Cuarta ronda:** la clave pública se reconoce solo en el **primer nivel** del payload o por su **ruta completa declarada** (`branches[].address`): `{ customer: { rif: 'V-12345678' } }` en `SELLER_IDENTITY_UPDATED` ya no pasa (antes la lista se aplicaba a cualquier profundidad). Y la barrera del catálogo es una **lista positiva**: solo `PAYMENT_PAGO_MOVIL_CONFIRMED`, `PAYMENT_PAGO_MOVIL_REJECTED`, `SELLER_IDENTITY_UPDATED` y `SHIPPING_AGENCY_CHANGED` pueden declarar `publicFields`; cualquier otra (p. ej. `STRIPE_PAYMENT_STATE_CHANGED`) falla el test hasta que un revisor la añada a propósito (antes era una lista negra por prefijo). El resto sigue igual dentro de esas acciones: la clave se compara exacta (distingue mayúsculas), su valor debe ser texto o `null` (un objeto bajo una clave pública se rechaza), solo queda exenta de *sus* clases (un email en `rif` o una cédula en `phone` siguen fallando) y `cedula`, `idDoc`, `password`, `token`... no están en ninguna lista. `src/audit/audit-catalog-payloads.spec.ts` prueba un payload representativo de **cada** acción del catálogo (escrito leyendo las stories 20.4 a 20.8) en modo estricto y permisivo, y no compila si se añade una acción sin ejemplo.
- **Fechas, `BigInt` y `Decimal` de Prisma.** Siguen lanzando `AuditPayloadError` en ambos modos (error de código, que debe verse en el test del emisor), pero el mensaje nombra el helper: `auditDate(d)`, `auditBigInt(n)`, `auditDecimal(d)` y `toAuditPayload(fila)`, que convierte en profundidad lo que devuelve Prisma y descarta las claves `undefined`. Un `Decimal` tampoco compila como `AuditPayload`.
- **Clave sensible en la ruta.** Una clave que es en sí un dato (`{ 'z@z.com': 1 }`, `sk_live_...`) ya no aparece en el `warn` ni en el mensaje del error estricto: la ruta lleva `[REDACTED:EMAIL]` y las claves se acortan a 64 caracteres.
- **Verificación parcial y alerta.** `chainBroken` ya no sigue a la *última* fila de `Audit_Verifications`: se apaga solo cuando una verificación **completa** (no `partial`: génesis a cabeza en una pasada) posterior a la última `BROKEN` da OK. Una parcial (`fromSeq`, incremental, cortada por `limit`) no demuestra nada sobre lo que no leyó y no la limpia. Una cadena que no ha cambiado vuelve a dar `BROKEN` en la completa, así que repetirla no sirve para descartar la alerta; si la completa da OK, es que la cadena verifica ahora y la alerta se apaga (el historial conserva la fila `BROKEN` y `lastBrokenAt`). Reescribir toda la cadena con hashes coherentes sigue sin detectarse: ese caso lo cubre el anclaje externo (13.5).
- **`fx-lock-budget.e2e-spec.ts` (causa encontrada en la cuarta ronda: el reloj de WSL2, no el producto).** Fallaba a ratos con 23 729 / 23 782 / 23 806 ms frente a un mínimo de 24 500 ms para el presupuesto de 25 s. Medido con tres relojes a la vez durante la espera (`test/helpers/clock-probe.ts`: `performance.now()` de Node, `Date.now()` de Node y `clock_timestamp()` de Postgres, cada 250 ms): `monoSpan` 23 810 ms, `wallSpan` 25 013 ms, `pgSpan` 25 010 ms, y el backend que esperaba el lock lo vio esperar 24 974 ms según el reloj de Postgres. Es decir, Postgres contó 25,0 s de reloj de pared y el monotónico solo 23,8 s: el reloj de pared de la VM de WSL2 (que Node y el contenedor comparten, mismo kernel) da un salto hacia delante de ~1,2 s respecto del monotónico. Un programa de Node sin Postgres lo reproduce: en 120 s midió 120 041 ms monotónico contra 123 575 ms de pared, en tres saltos de 1 208, 1 177 y 1 149 ms a los 23,6, 55,8 y 88,1 s (uno cada ~32 s, así que una espera de 25 s contiene un salto en ~78 % de las corridas). `lock_timeout`/`statement_timeout` de Postgres se miden con el reloj de pared, por eso el 409 llega 1,2 s antes en tiempo monotónico. **No es el presupuesto repartido con trabajo previo:** el `pg_advisory_xact_lock` empezó 26 ms después de llegar la petición y se armó con 24 974 ms. Cambiar `LockBudget` a `performance.now()` no podía arreglarlo porque quien vence es Postgres. Ajuste del test: el suelo (`presupuesto - 500 ms`) se mide con el mayor de los dos relojes (el presupuesto está gastado cuando cualquiera lo dice), el **techo no se toca** (`presupuesto + 3 s`, monotónico). En un servidor con NTP (sin saltos) los dos relojes coinciden y el suelo es el mismo de siempre. Un defecto real (presupuesto consumido por trabajo previo) fallaría por segundos, no por un salto de 1,2 s.
- **Salto de reloj de la BD de más de 60 s (comportamiento documentado, no cambia).** El servicio nunca escribe una hora anterior a la cabeza; si el reloj de la BD retrocede **más de 1 minuto** respecto de la última fila, la hora reutilizada queda más de un minuto en el futuro y el trigger la rechaza: las acciones auditadas responden `503 AUDIT_UNAVAILABLE` (`WRITE_FAILED`) **hasta que el reloj alcance a la cabeza**. Es temporal y deliberado (mejor parar que escribir una hora falsa); corrige el reloj del servidor (NTP) y las acciones vuelven solas.
- **Restauración de copias de seguridad (13.9).** Los triggers de auditoría, legales y de consentimiento usaban nombres de tabla sin esquema y fallaban con `relation "Audit_Events" does not exist` al restaurar un `--data-only` con triggers activos (`pg_dump` fija un `search_path` vacío). Dos migraciones nuevas fijan el `search_path` de cada función; ver 13.9.
- **`pnpm db:roles` y contraseñas con caracteres que SASLprep cambia.** `scripts/scram-verifier.mjs` solo aplicaba NFKC; Postgres además descarta U+00AD, U+200B, U+FEFF, U+1806, los selectores de variación..., sustituye los espacios no ASCII y, si el resultado contiene un carácter prohibido (U+0340) o no asignado en Unicode 3.2, vuelve a la contraseña sin tocar. El verificador salía distinto, el script decía `done` y el login fallaba. Ahora el script **rechaza con un mensaje claro** (sin repetir la contraseña) cualquier contraseña que SASLprep cambiaría; las ASCII y el texto que ya es NFKC sin caracteres invisibles se aceptan y dan el mismo verificador que Postgres. Comprobado contra un Postgres 17 desechable con todos los puntos de código del BMP y 33 230 cadenas más (astrales, secuencias combinantes, mezclas RTL/LTR, aleatorias): 0 casos aceptados con verificador distinto. **Si tu contraseña actual tiene alguno de esos caracteres, cámbiala** (o el login ya falla).
- **Tests.** El `globalSetup` solo borra esquemas con el formato exacto que genera `sandboxName()`; un `audit_t_foo` ajeno ya no se interpreta como «muy antiguo». `findRecordMisuse` (`test/helpers/find-record-misuse.ts`) usa ahora el AST de TypeScript; sigue siendo una red, no una barrera: lee un archivo cada vez, reconoce `await` en un helper del mismo archivo, `Promise.all`, alias, desestructuración, `this.audit['record']` y el uso de `tx` después, y respeta ramas `else`, `catch`, `return` previo, comentarios y cadenas; no ve un helper de **otro** archivo, trabajo dentro de un callback anidado ni una llamada lenta sin `await` que no use `tx`.
- **Avisos de desarrollo.** `collectorsclub_dev_app_password` (rol `collectorsclub_dev_app`, `deploy/db/init-roles.sql`) y `collectorsclub_dev_password` (propietario) están en el repositorio: **no los uses en staging ni producción**; allí `pnpm db:roles` con un secreto real. `docker-compose.yml` publica el `5433` solo en `127.0.0.1` y `[::1]`; un contenedor ya creado conserva su publicación anterior hasta que lo recrees (`docker compose up -d`, los datos del volumen se conservan).

### 13.2 Migraciones (dos, aditivas) y, en la segunda ronda de QA, dos más

`20261105100000_audit_chain_hardening` (función `audit_normalize_ip`, trigger de cadena con cotas de `occurredAt`, columna `Audit_Verifications.partial`) y `20261105110000_revoke_prisma_migrations_from_app_roles`. Ambas empiezan con `BEGIN;`; la primera con `SET LOCAL lock_timeout = '10s'`.

Tercera ronda: `20261106200000_audit_restore_safe` (función de la cadena con `search_path` propio y la opción de restauración `audit.allow_unordered_restore`, ver 13.9; también fija `audit_events_immutable` y `audit_normalize_ip`) y `20261106210000_pin_trigger_function_search_path` (fija las funciones `legal_*` y `consent_*` de Epic 19). Solo `ALTER/CREATE OR REPLACE FUNCTION`, sin tocar datos ni tablas; empiezan con `BEGIN;` y `SET LOCAL lock_timeout = '10s'`.

**Cuarta ronda (bloqueante B1): `20261107100000_pin_trigger_functions_pg_temp_last`.** Las dos migraciones de la tercera ronda **no cerraban** el secuestro por `search_path` que prometían: `SET search_path FROM CURRENT` guarda `"$user", public`, y Postgres busca el esquema temporal de la sesión (`pg_temp`) **primero** para relaciones y tipos mientras no esté listado. Con `TEMPORARY` sobre la base (lo tiene `PUBLIC` por defecto, así que el rol limitado también), `CREATE TEMP TABLE "Audit_Events"(...)` con una cabeza falsa hacía que `audit_events_chain_guard` leyera la temporal y aceptara una fila que continuaba la cabeza falsa; con una copia temporal de `"Legal_Documents"` con `"isSandbox" = true`, `legal_guard_version_insert` aceptaba una versión con fecha anterior. Reproducido con `collectorsclub_q_app` y cerrado: la migración fija en las 14 funciones `SET search_path = pg_catalog, public, pg_temp` (`pg_catalog` primero para que nada en `public` tape un tipo, función u operador incorporado; `pg_temp` **explícito y último**: se sigue buscando para relaciones, pero después de las reales; para funciones y operadores `pg_temp` nunca se busca sin calificar). Los comentarios de las migraciones ya aplicadas que llaman «protección» a `FROM CURRENT` no se pueden editar (cambiaría su checksum): esta sección y la migración nueva son la corrección. Solo `ALTER FUNCTION`, sin datos ni tablas, sin `lock_timeout` dentro (regla de 12.2) y con `BEGIN;` en la primera línea. Probado sobre un clon con el rol limitado, cada variante antes (migración sin aplicar) y después:

| Variante (rol `collectorsclub_q_app`) | Antes | Después |
|---|---|---|
| tabla temporal `"Audit_Events"` con cabeza falsa seq 49, fila real seq 50 | aceptada | 23000 |
| vista temporal `"Audit_Events"` | aceptada | 23000 |
| funciones temporales `clock_timestamp`, `current_setting`, `pg_has_role`, `repeat` con `pg_temp` primero en la sesión | 23000 | 23000 |
| operadores temporales `<>` y `+` sobre `bigint` con `pg_temp` primero | 23000 | 23000 |
| tabla temporal `pg_class` y opción de restauración activa | 23000 | 23000 |
| dominio temporal `text` y `audit_normalize_ip` | igual | igual |
| copia temporal de `"Legal_Documents"` con `isSandbox = true` y versión de hace 300 días | aceptada | 23000 |
| vista temporal `"Legal_Documents"` con `isSandbox = true` | aceptada | 23000 |
| `"Legal_Document_Versions"` temporal con `versionNumber` 98 y una versión 99 | aceptada | 23000 |
| consentimiento falsificado con `"Legal_Document_Versions"` y `"Legal_Documents"` temporales | aceptado | 23000 |

(Las que ya daban 23000 antes confirman que funciones y operadores temporales nunca se buscaban sin calificar.) El test `src/audit/migration-search-path.spec.ts` exige ahora `pg_catalog` primero y `pg_temp` último en **todas** las funciones, entiende `AS '...'`, `$tag$`, `public.f`, `CREATE PROCEDURE`, `ALTER ... RESET`, `RENAME` y `DROP`, y rechaza un bloque `DO` que toque funciones; `test/trigger-pg-temp.e2e-spec.ts` repite las variantes contra la base real (todo dentro de una transacción que se revierte) y contra un esquema sandbox. Una migración futura que cree o reemplace una función **debe** terminar con `ALTER FUNCTION ... SET search_path = pg_catalog, public, pg_temp`.

**Segunda capa: `REVOKE TEMPORARY` (`pnpm db:roles`).** `scripts/db-roles.sql` quita ahora `TEMPORARY` sobre la base a `PUBLIC` y al rol de la aplicación, de modo que el rol limitado ni siquiera puede crear el señuelo (`permission denied to create temporary tables in database`). La aplicación no usa tablas temporales (ni `src/`, ni los scripts, ni la suite e2e completa con el rol limitado y `TEMPORARY` revocado: ver 13.6). Efecto a tener en cuenta: el privilegio viene de `PUBLIC`, así que el `REVOKE` también se lo quita a **cualquier otro rol sin privilegios especiales de esa misma base**; el propietario y los superusuarios lo conservan. Si otro rol (informes, BI) lo necesita: `GRANT TEMPORARY ON DATABASE <base> TO <rol>`, o ejecuta `DB_ROLES_REVOKE_TEMP=off pnpm db:roles` para no tocarlo. Es una segunda capa, no la primera: la primera es el `search_path` de las funciones.



`20261104100000_add_audit_events` (tablas nuevas, no toca ninguna tabla existente) y `20261104200000_legal_revision_never_decreases` (dos triggers sobre `Legal_Drafts` y `Legal_Documents`). Cada una empieza con `BEGIN;` y termina con `COMMIT;`: si una sentencia falla no queda nada a medias (regla de 12.3). La segunda toma un lock sobre dos tablas existentes y empieza con `SET LOCAL lock_timeout = '10s'` **dentro** del `BEGIN`.

Verificado sobre un clon (Postgres 17): con otra sesión reteniendo un lock sobre `Legal_Drafts`, `prisma migrate deploy` falló a los 11 s; la primera migración quedó aplicada, de la segunda **no quedó ninguna función ni trigger**, Prisma dijo `current transaction is aborted` (el texto que `deploy.sh` ya reconoce, 12.3), y bastó `pnpm prisma migrate resolve --rolled-back 20261104200000_legal_revision_never_decreases` + volver a desplegar. Esta vez, a diferencia de la línea de 12.2, **el `SET LOCAL` sí funciona** porque está dentro de un `BEGIN`/`COMMIT` escrito en el propio archivo.

Una rareza inofensiva: `prisma migrate diff` propone `ALTER COLUMN "ip" SET DATA TYPE inet` para `Audit_Events` en cada ejecución (limitación de Prisma con columnas `Unsupported`; no cambia nada). No generes una migración a partir de eso.

Si en la BD ya hay roles que no son superusuario (p. ej. `qa_app`), la migración les quita `UPDATE/DELETE/TRUNCATE` sobre `Audit_Events` (tabla nueva): no modifica los roles.

### 13.3 El paso que tienes que hacer tú: el rol de BD limitado (A90)

**Por qué.** Hoy la app corre como `collectorsclub`, que es superusuario y propietario: con ese rol cualquier fallo de la app (o una inyección SQL) podría hacer `ALTER TABLE ... DISABLE TRIGGER` y reescribir el log. Con un rol que no es propietario ni superusuario eso es imposible: no puede ejecutar DDL, ni desactivar triggers, ni `UPDATE/DELETE/TRUNCATE` sobre `Audit_Events`. Las migraciones y `deploy.sh` siguen con el propietario.

**Qué hace `pnpm db:roles`.** Crea (o actualiza, es idempotente) `collectorsclub_<entorno>_app`: `LOGIN`, sin `SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS`, no propietario de nada. Le da `CONNECT`, `USAGE` sobre `public`, `SELECT/INSERT/UPDATE/DELETE` sobre todas las tablas y `USAGE/SELECT` sobre las secuencias, **y `ALTER DEFAULT PRIVILEGES` para que las tablas que creen las migraciones futuras (las ejecuta el propietario) queden accesibles sin ningún `GRANT` manual**. Después le quita `UPDATE/DELETE/TRUNCATE` sobre `Audit_Events` y todo sobre `_prisma_migrations` (con el `init` del compose en volumen vacío la tabla aún no existe: lo hace la migración `20261105110000`). Si creas la tabla de otra manera que no sea una migración del propietario, vuelve a ejecutarlo.

**En tu máquina de desarrollo (no se ha tocado tu `.env`):**

1. Elige una contraseña para el rol; no la pegues en ningún chat ni commit. En una terminal (el script lee tu `.env` para conectarse como propietario y no imprime ninguna URL ni contraseña):
   ```bash
   DB_ROLES_ENV=dev APP_DB_PASSWORD='<la-contraseña>' pnpm db:roles
   ```
   Debe terminar con `role collectorsclub_dev_app created` y `done`.
2. En tu `.env`, **copia** la línea actual `DATABASE_URL=...` a una línea nueva `MIGRATE_DATABASE_URL=...` (sin cambiarla) y cambia el usuario y la contraseña de `DATABASE_URL` por `collectorsclub_dev_app` y la contraseña del paso 1 (misma base y puerto). El CLI de Prisma (`migrate`, `studio`, `db execute`) usa `MIGRATE_DATABASE_URL`; la app, los seeds (`prisma:seed`, `seed:legal`), `tcg:ingest` y los tests usan `DATABASE_URL`.
3. Reinicia `pnpm start:dev` y comprueba `GET /api/v1/health` y un login.
4. Para volver atrás basta con quitar `MIGRATE_DATABASE_URL` y restaurar `DATABASE_URL`.

Si recreas el volumen de Docker desde cero, `docker-compose.yml` monta `deploy/db/init-roles.sql` y el rol `collectorsclub_dev_app` (contraseña de desarrollo `collectorsclub_dev_app_password`, solo local) se crea solo; en un volumen que ya existe no corre, de ahí el paso 1. **Aviso:** al cambiar `docker-compose.yml`, el próximo `docker compose up -d` recreará el contenedor de Postgres (los datos del volumen se conservan).

**Para ejecutar la suite e2e con el rol limitado** (sin tocar el `.env`; en una terminal, con las dos URL ya exportadas):

```bash
DATABASE_URL='<url del rol app>' MIGRATE_DATABASE_URL='<url del propietario>' pnpm test:e2e --no-file-parallelism
```

Los pocos specs que necesitan privilegios (crear el esquema sandbox de auditoría, devolver `revision`/`draftRevisionFloor` de los borradores reales a su valor guardado) usan `MIGRATE_DATABASE_URL` y, si no existe, `DATABASE_URL`. Los tests de triggers de `TRUNCATE` aceptan `42501` (permiso denegado) cuando el rol no tiene el privilegio. Con una sola URL (tu configuración actual) todo corre como antes.

**En staging y producción (en este orden, fuera de hora punta):**

1. Despliega el código como siempre. Las migraciones corren con la URL que ya existe (`MIGRATE_DATABASE_URL` si la defines, si no `DATABASE_URL`; `deploy.sh` usa esa misma con el `lock_timeout`).
2. En el servidor, desde `/opt/212cc/<entorno>/app` y con las variables en el entorno de esa sesión (no impresas), como en 12.3:
   ```bash
   set -a; source /opt/212cc/<entorno>/shared/.env; set +a
   DB_ROLES_ENV=<staging|production> APP_DB_PASSWORD='<contraseña nueva>' pnpm db:roles
   ```
3. Edita `/opt/212cc/<entorno>/shared/.env`: `MIGRATE_DATABASE_URL` = la URL actual (propietario); `DATABASE_URL` = la del rol `collectorsclub_<entorno>_app`. `deploy.sh` ya usa `MIGRATE_DATABASE_URL` para `prisma migrate deploy` (rechaza una URL que ya traiga un parámetro `options`). Verificado sobre el clon (el bloque de migración de `deploy.sh`, extraído y ejecutado): con `MIGRATE_DATABASE_URL` migra como propietario; si pones el rol limitado en `DATABASE_URL` y **olvidas** `MIGRATE_DATABASE_URL`, `prisma migrate deploy` falla (el rol no puede tocar `_prisma_migrations`) y `deploy.sh` se detiene **antes** de reiniciar el servicio.
4. `sudo systemctl restart 212cc-backend-<entorno>` y comprueba el health check, un registro y una compra de prueba.
5. Comprueba que el rol es el limitado (como propietario, con `psql` o con el `q` de 12.3):
   ```sql
   SELECT has_table_privilege('collectorsclub_<entorno>_app', '"Audit_Events"', 'UPDATE')   AS upd,   -- f
          has_table_privilege('collectorsclub_<entorno>_app', '"Audit_Events"', 'DELETE')   AS del,   -- f
          has_table_privilege('collectorsclub_<entorno>_app', '"Audit_Events"', 'TRUNCATE') AS trunc,  -- f
          has_table_privilege('collectorsclub_<entorno>_app', '"Audit_Events"', 'INSERT')  AS ins;   -- t
   SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'collectorsclub_<entorno>_app';  -- f f f
   ```
6. Vuelve a ejecutar `pnpm db:roles` tras restaurar una copia de seguridad o si alguna vez creas tablas sin pasar por una migración del propietario. **Sin contraseña solo sirve si el rol ya existe** (no la rota); en un servidor o clúster nuevo el rol todavía no existe y falla con `dbroles.password is required to create the role collectorsclub_<entorno>_app`: ahí hay que pasar `APP_DB_PASSWORD` (los roles son del clúster, no de la base: una base restaurada en el mismo servidor conserva el rol). Verificado: sin contraseña en un servidor sin el rol falla con ese mensaje; con `APP_DB_PASSWORD` lo crea; y de nuevo sin contraseña con el rol ya existente dice `password unchanged`.

Limitaciones que conviene saber: (a) las migraciones deben ejecutarlas **siempre el mismo propietario** que ejecutó `pnpm db:roles` (los privilegios por defecto son «para las tablas de ese rol»); (b) en PostgreSQL anterior al 15 el esquema `public` deja crear objetos a cualquiera: si tu servidor es antiguo, valora `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; (c) el propietario o un superusuario **sí pueden** desactivar los triggers y reescribir la cadena entera: la defensa es el anclaje externo (13.5); (d) **otra razón para usar el rol limitado:** la opción `audit.allow_unordered_restore` (13.9) la respeta el propietario de la tabla. Si la aplicación corre con el mismo rol que es propietario (desarrollo, o producción sin `MIGRATE_DATABASE_URL`), cualquier SQL que ejecute la aplicación puede hacer `SET audit.allow_unordered_restore = 'on'` e insertar una fila con `occurredAt` anterior a la previa; sigue sin poder saltarse `seq`, `prevHash` ni las cotas de futuro y de 2020, pero la regla de orden de tiempo deja de proteger. Con el rol limitado (que no es propietario) la opción se ignora.

### 13.4 Variables de entorno (todas opcionales; ver `.env.example`)

| Variable | Por defecto | Para qué |
|---|---|---|
| `MIGRATE_DATABASE_URL` | = `DATABASE_URL` | URL del propietario para `prisma migrate`, `deploy.sh` y `pnpm db:roles`. |
| `AUDIT_VERIFY_CRON` | `0 5 * * 0` (UTC) | Verificación semanal. Como la del FX, se lee del entorno del proceso al arrancar: expórtala (systemd `EnvironmentFile`), no basta con el `.env` de dev. |
| `AUDIT_VERIFY_CRON_MODE` | `full` | `full` recalcula toda la cadena cada vez; `incremental` solo lo posterior a la última verificación OK. **Deja `full`**: un incremental confía en las filas anteriores a su ancla y no vería que alguien cambió el contenido de una fila vieja sin tocar su hash. Solo si la cadena llega a millones de filas. |
| `AUDIT_VERIFY_ENABLED` | `true` (`false` con `NODE_ENV=test`) | Apaga el job. |
| `AUDIT_PAYLOAD_STRICT` | `true` salvo `NODE_ENV=production` | Guard de `before`/`after`: `true` lanza, `false` enmascara y sigue (13.1b). |
| `AUDIT_ANCHOR_EMAIL` | sin definir (producción avisa al arrancar) | Tras cada ejecución semanal se envía `seq` + `hash` de la cabeza por el `Mailer`. Un fallo de correo solo queda en el log. |
| `DB_ROLES_ENV`, `APP_DB_PASSWORD` | sin definir | Solo para `pnpm db:roles`; no los dejes en el `.env` del servicio. |
| `DB_ROLES_REVOKE_TEMP` | sin definir (= se revoca) | `off` hace que `pnpm db:roles` no quite `TEMPORARY` a `PUBLIC` (13.2). Solo para `pnpm db:roles`. |

### 13.5 Anclaje externo del hash (el único freno contra un DBA)

Quien tenga privilegios plenos en la BD puede desactivar los triggers y reescribir **toda** la cadena con hashes nuevos coherentes; la verificación no lo vería. Lo que sí lo delata es un hash escrito **fuera** de la BD y del servidor. Define `AUDIT_ANCHOR_EMAIL` con un buzón que no controle quien administra la BD (cada domingo recibe el hash de cabeza), o anota a mano el resultado de `GET /api/v1/admin/audit/head`. Para contrastar: `GET /admin/audit/events/<seq>` de ese `seq` debe dar el mismo `hash`.

### 13.6 Lo medido (clon, contenedor Postgres 17 en la máquina de desarrollo, cliente en `localhost`)

- **`POST /admin/audit/verify` con 200 000 filas** (`mode: full, limit: 200000`) por HTTP: 1 936 ms (≈ 6,2 millones filas/min; el mínimo exigido es 50 000/min). **Retraso del event loop durante la verificación:** media 1,5 ms, p99 9,4 ms, máximo 24,7 ms (sonda de temporizador: 23,5 ms). El verificador lee por *keyset* de 5 000 y calcula los hashes en tramos de 250 filas cediendo el control entre tramos; sin ceder, el máximo medido fue 43 ms. No hizo falta moverlo a un worker.
- **Coste del lock de la cadena** (cada acción auditada toma `pg_advisory_xact_lock` hasta su `COMMIT`; transacciones con forma de checkout: 2 filas de producto `FOR UPDATE`, un pedido y dos líneas, y el evento al final):

  | Transacciones simultáneas | Sin auditoría: tx/s, p50 / p95 / p99 (ms) | Con auditoría: tx/s, p50 / p95 / p99 (ms) |
  |---|---|---|
  | 1 | 458, 2,1 / 2,6 / 2,9 | 247, 4,0 / 4,9 / 6,7 |
  | 5 | 1 575, 3,1 / 4,4 / 5,9 | 508, 9,7 / 11,5 / 15,1 |
  | 10 | 1 725, 5,3 / 9,2 / 13,8 | 503, 19,2 / 23,2 / 33,6 |
  | 25 | 1 669, 12,6 / 27,0 / 43,7 | 485, 47,3 / 78,7 / 104,5 (máx. 120) |

  (La app de producción usa el pool por defecto de 10 conexiones, así que en la práctica hay como mucho 10 transacciones en cola; 25 es margen.)

  Lectura: la sección serializada (lock, lectura de cabeza, `INSERT`, `COMMIT`) dura unos 2 ms, así que el techo con auditoría es de ~450-500 acciones auditadas por segundo en este hardware, frente a ~1 700 sin ella. Un checkout real tarda mucho más que estas transacciones sintéticas, y la tienda hace unas pocas acciones auditadas por segundo como mucho (R2 del epic: < 10/s): el lock no es el cuello de botella. Ninguna espera se acercó a los 5 s del presupuesto. **Si se agotan los 5 s** (BD saturada, o un proceso que retiene el lock), la acción **falla cerrada**: la API responde `503 AUDIT_UNAVAILABLE` (`details.reason`: `LOCK_TIMEOUT`, `WRITE_FAILED` o `TX_TIMEOUT`) y la acción auditada se revierte; nunca un 500. El front debe tratar ese 503 como «reintenta en unos segundos».
- **Con el rol limitado, sobre un clon:** servidor real arrancado con `collectorsclub_d201_app` (`node dist/main`): login admin, `GET head`, `POST verify` (cadena sana: `ok`; tras alterar una fila como propietario: `ok: false`, `brokenAt {seq, reason: HASH_MISMATCH, expected, found}`; tras restaurarla: `ok` otra vez), `GET verifications` (`chainBroken: true` hasta que una verificación completa posterior dé OK), un registro (201) y un checkout con Pago Móvil (201). La suite e2e completa pasó con ese rol salvo `related-products` (preexistente) y los ajustes de test descritos en 13.3.
- **Cuarta ronda, suite e2e completa con el rol limitado** (contenedor Postgres 17 desechable, clon de la base de desarrollo, `DATABASE_URL` = `collectorsclub_q_app`, `MIGRATE_DATABASE_URL` = propietario, `pnpm db:roles` ya ejecutado con `REVOKE TEMPORARY`, migración `20261107100000` aplicada): 87 de 88 archivos y 1 167 de 1 168 pruebas; la única que falla es `related-products` (preexistente, residuos). Con el rol de desarrollo normal contra la base de desarrollo: el mismo resultado. Con `TEMPORARY` revocado no falló nada más, así que la aplicación no usa tablas temporales.

### 13.7 Lo que NO está verificado

- Nada de esto se ha ejecutado en un VPS real (ni `deploy.sh` con `MIGRATE_DATABASE_URL`, ni `pnpm db:roles` contra el Postgres del servidor, ni el correo de anclaje con un SMTP real). Se probó sobre una instancia desechable de Postgres 17 con una copia de la base de desarrollo.
- `docker-compose.yml` con `deploy/db/init-roles.sql` se probó solo en un contenedor desechable nuevo; el volumen de Angel ya existe y no ejecuta ese script.
- Medidas hechas en `localhost` con cliente y servidor en la misma máquina: en una red real el lock se mantiene unos milisegundos más por viaje (unos 5 viajes a la BD dentro de la sección serializada).
- La Story 20.1 no emite eventos de negocio: lo que pasaría con el lock en un checkout real se midió con transacciones sintéticas con la misma forma.
- El rol con `DB_ROLES_ENV=dev` en el volumen real de Angel no se ha creado (se hizo en la instancia desechable); el paso 1 de 13.3 es suyo.

- Restauración: no se ha probado con un `pg_dump` de producción, con una versión de Postgres distinta de la 17 ni con `pg_restore` en paralelo (`-j`). `--data-only --disable-triggers` exige superusuario (ver 13.9 para la alternativa sin él). Los 30 eventos de la prueba salieron de un generador, no de la app.
- La migración `20261107100000` nombra `public` en el `search_path` de las funciones. Si algún día el esquema de la aplicación deja de ser `public`, hay que cambiarlo en una migración nueva (las tablas del proyecto no llevan esquema y se resuelven contra ese `search_path`).
- Los clones y la prueba de `REVOKE TEMPORARY` se hicieron en Postgres 17; `GRANT SET ON PARAMETER` (13.9) existe desde PostgreSQL 15.

### 13.8 Volver atrás

Las tablas y triggers nuevos son inertes para la versión anterior del código: despliega la anterior y deja las migraciones aplicadas. `Audit_Events` no se puede vaciar por diseño (solo el propietario puede `DROP TABLE`, y no se debe). Para volver al rol único, quita `MIGRATE_DATABASE_URL` y pon en `DATABASE_URL` la del propietario; el rol limitado puede quedarse sin efecto, o eliminarse con `DROP OWNED BY collectorsclub_<entorno>_app; DROP ROLE collectorsclub_<entorno>_app;`.

### 13.9 Restaurar una copia de seguridad (probado de principio a fin sobre un clon)

Probado en un contenedor Postgres 17 desechable con una copia de la base de desarrollo, 30 eventos de auditoría (uno con la hora 1,5 s **anterior** a la fila previa, como los que escribió el código antiguo con un reloj que retrocedía), una versión legal y un consentimiento, aplicadas las migraciones `20261106200000_audit_restore_safe` y `20261106210000_pin_trigger_function_search_path`. En cada caso se ejecutó después una verificación `full` de la cadena (`AuditChainVerifier`).

**Forma recomendada: volcado completo.** `pg_dump` crea los triggers **después** de cargar los datos, así que no disparan:

```bash
pg_dump --no-owner --no-privileges "$DB" > backup.sql                 # o -Fc para pg_restore
createdb nueva && psql -v ON_ERROR_STOP=1 -d nueva < backup.sql       # o: pg_restore --no-owner --exit-on-error -d nueva backup.dump
```

Resultado: cadena `ok: true, rows: 30` en ambos formatos (texto plano y custom). Tras restaurar en un servidor distinto, ejecuta `pnpm db:roles` (sin contraseña) para devolver los permisos del rol limitado y verifica la cadena: `POST /api/v1/admin/audit/verify {"mode":"full"}` debe responder `ok: true`.

**Solo datos (`--data-only`) sobre un esquema ya migrado.** Hay dos casos:

1. *Toda la base.* **No** se puede hacer sobre una base creada con `prisma migrate deploy`: las migraciones siembran filas (`Categories`, `Legal_Documents`, `Shipping_Agencies`, `_prisma_migrations`, ...) y el `COPY` del volcado choca con ellas (`duplicate key value violates unique constraint "Categories_slug_key"`; reproducido). Se parte de un **esquema vacío** tomado del origen:

   ```bash
   # 1. En el origen: esquema y datos por separado.
   pg_dump --schema-only --no-owner --no-privileges origen > schema.sql
   pg_dump --data-only --disable-triggers --no-owner --no-privileges origen > datadis.sql   # avisa de la FK circular de Categories: es esperado
   # 2. En el destino (base NUEVA y vacía; no ejecutes antes prisma migrate deploy):
   createdb destino
   psql -v ON_ERROR_STOP=1 -d destino < schema.sql
   psql -v ON_ERROR_STOP=1 -d destino < datadis.sql      # requiere SUPERUSUARIO (ver abajo)
   ```

   `_prisma_migrations` viaja en el volcado de datos, así que Prisma ve la base al día (`pnpm prisma migrate status` dice `Database schema is up to date`); no hace falta ni se debe correr `migrate deploy` antes. Ejecutado tal cual (contenedor Postgres 17 desechable, 30 eventos de auditoría con uno de hora anterior, una versión legal y un consentimiento): restauración completa sin errores, cadena `ok: true, rows: 30`, 53 filas en `_prisma_migrations`, ningún trigger desactivado y `UPDATE "Audit_Events"` sigue dando `Audit_Events is immutable: UPDATE rejected`. Después ejecuta `pnpm db:roles` **con `APP_DB_PASSWORD` si el servidor es nuevo** (13.3, paso 6).

   **`--disable-triggers` exige superusuario.** `pg_dump` lo implementa con `ALTER TABLE ... DISABLE TRIGGER ALL`, que incluye los triggers internos de las claves foráneas. Con un propietario normal el segundo `psql` falla con `permission denied: "RI_ConstraintTrigger_a_21003" is a system trigger` (reproducido). Alternativas sin superusuario:
   - **Volcado completo** (la forma recomendada de arriba): no necesita nada especial.
   - **PostgreSQL 15 o posterior:** un superusuario concede una vez `GRANT SET ON PARAMETER session_replication_role TO <propietario>;` y el propietario restaura un volcado de datos **sin** `--disable-triggers` en modo réplica, en el que no se disparan ni los triggers ni las claves foráneas:
     ```bash
     pg_dump --data-only --no-owner --no-privileges origen > datadis.sql
     PGOPTIONS='-c session_replication_role=replica' psql -v ON_ERROR_STOP=1 -d destino < datadis.sql
     ```
     Verificado con un rol `NOSUPERUSER CREATEDB`: 30 filas, cadena `ok: true`, triggers activos después (el modo réplica es solo de esa sesión). En un servicio gestionado que no permita ese `GRANT`, usa el volcado completo.
   - Después de **cualquier** restauración: `POST /api/v1/admin/audit/verify {"mode":"full"}`; es la prueba de que la copia no está truncada ni alterada.
2. *Solo `Audit_Events` / `Audit_Verifications`* (p. ej. `pg_dump --data-only -t '"Audit_Events"' -t '"Audit_Verifications"'`) **con los triggers activos**: ahora funciona porque las funciones de los triggers tienen su propio `search_path` (antes: `relation "Audit_Events" does not exist`). Si el volcado contiene un par antiguo con la hora **no monótona**, el trigger lo rechaza (`goes back before the previous row`); el propietario (o un superusuario) lo autoriza solo para esa sesión:

   ```bash
   PGOPTIONS='-c audit.allow_unordered_restore=on' psql -v ON_ERROR_STOP=1 -d destino < audit-only.sql
   # con pg_restore: PGOPTIONS='-c audit.allow_unordered_restore=on' pg_restore --data-only -d destino ...
   ```

   Medido: sin la opción, el `COPY` falla en la fila 7; con ella carga las 30 filas y la cadena verifica `ok: true`. La opción **solo la respeta el propietario de la tabla o un superusuario** (un rol sin ese permiso la ignora y sigue rechazado, probado con un rol de prueba), solo relaja el orden de `occurredAt` (la continuidad de `seq` y `prevHash` y las cotas de futuro y de 2020 siguen exigidas) y el valor desaparece al cerrar la sesión. No la dejes en el `.env` del servicio.

Los triggers siguen activos después de la restauración (insertar fuera de secuencia da `chain fork or gap rejected`). La verificación de la cadena después de **cualquier** restauración no es opcional: es la prueba de que la copia no está truncada ni alterada.

Las funciones se fijan con `SET search_path FROM CURRENT` (el de la sesión que migra: `"$user", public` con Prisma). Un test estático (`src/audit/migration-search-path.spec.ts`) falla si una migración futura crea o reemplaza una función sin `SET search_path` (`CREATE OR REPLACE FUNCTION` borra el ajuste).
Las funciones se fijan con `SET search_path = pg_catalog, public, pg_temp` (migración `20261107100000`, ver 13.2; las de la tercera ronda usaban `FROM CURRENT`, que reparaba la restauración pero **no** el secuestro por `pg_temp`). Un test estático (`src/audit/migration-search-path.spec.ts`) falla si una migración futura crea o reemplaza una función sin ese ajuste (`CREATE OR REPLACE FUNCTION` borra el ajuste) o si lo deja sin `pg_temp` al final.

**Quién puede usar `audit.allow_unordered_restore`.** Solo el propietario de `Audit_Events` (o un superusuario): la función comprueba `pg_has_role(current_user, <propietario de la tabla>, 'USAGE')`. Si la aplicación corre con ese mismo rol (desarrollo, o producción sin `MIGRATE_DATABASE_URL`), su SQL también puede activarla, y eso es una razón más para usar el rol limitado de 13.3 (con él la opción se ignora, probado). No la dejes nunca en el `.env` ni en `PGOPTIONS` del servicio.

## 14. Epic 20, Story 20.2: claves de cifrado de la cédula (módulo `crypto`)

Esta sección es para Angel. Story 20.2 solo entrega las utilidades (cifrado AES-256-GCM, índice ciego, normalización, enmascarado, redacción de logs); **todavía no cifra ninguna fila** (eso es 20.3) y no tiene migración. Aun así, **la app ya no arranca sin las tres variables** (también en desarrollo y en test), así que hay que prepararlas antes del próximo despliegue.

### 14.1 Variables (en el `.env` de cada entorno, nunca en el repo)

| Variable | Contenido | Notas |
|---|---|---|
| `IDDOC_ENC_KEYS` | `1:<base64 de 32 bytes>[,2:<...>]` | Llavero: versión y clave. Descifrar usa la versión que lleva cada valor (`v1:...`), así que tras rotar siguen leyéndose los valores antiguos. |
| `IDDOC_ENC_ACTIVE_KEY` | `1` | Versión con la que se cifra lo nuevo. Debe existir en el llavero. |
| `IDDOC_BLIND_KEY` | base64 de ≥ 32 bytes | Clave del índice ciego (HMAC) y del hash de email de la auditoría. **Distinta** de toda clave de cifrado. |
| `RIF_CHECKDIGIT_STRICT` | `false` (opcional) | Con `false` el RIF se valida solo por formato (por si el dígito verificador del SENIAT divergiera, A98). |

Genera cada clave por separado, en tu máquina o en el servidor: `openssl rand -base64 32`. Cada variable lleva una clave **distinta**. `.env.example` solo trae marcadores (`<generate ...>`), que no son claves válidas: si alguien copia el ejemplo tal cual, el arranque falla con un mensaje claro. **No hay clave por defecto en ningún entorno.** `deploy/deploy.sh` aborta el despliegue si falta alguna de las tres líneas en `/opt/212cc/<entorno>/shared/.env`.

Tu `.env` de desarrollo local también las necesita (el servidor de desarrollo no arrancará hasta que las añadas): genera tres claves con el comando anterior y pégalas a mano. Los tests (`pnpm test`, `test:e2e`, `test:perf`) generan claves desechables al vuelo y no usan las tuyas.

El arranque aborta, con la lista de **todos** los problemas y sin imprimir ninguna clave, si: falta una variable; una clave no es base64 o no mide exactamente 32 bytes (la ciega, al menos 32); hay versiones repetidas o no enteras; la versión activa no existe; una clave son todos bytes iguales (marcador); o la ciega coincide con una de cifrado.

### 14.2 Si pierdes `IDDOC_ENC_KEYS`: las cédulas son irrecuperables

La cédula es obligatoria en las facturas y se conserva durante el plazo fiscal. Se guarda **solo cifrada** (desde 20.3). Sin la clave de la versión que cifró un valor, ese valor no se puede descifrar por ningún medio (ni nosotros ni PostgreSQL): habría que volver a pedir la cédula a cada comprador, y las órdenes antiguas perderían el dato de la factura. Tampoco sirve la copia de la BD sin la clave.

**Respaldo (haz esto ANTES de que 20.3 cifre datos reales y antes de activar una versión nueva):**

1. Guarda `IDDOC_ENC_KEYS`, `IDDOC_ENC_ACTIVE_KEY` e `IDDOC_BLIND_KEY` en un gestor de secretos (o, como mínimo, en un archivo cifrado o gestor de contraseñas) que **no** esté en el servidor ni en el mismo almacenamiento que los backups de la base de datos. Quien tenga el backup de la BD y la clave puede leer todas las cédulas; guárdalas separadas.
2. Al menos **dos copias** en sitios distintos, con dos personas de confianza que sepan dónde están.
3. Tras cada cambio del llavero, actualiza las copias **antes** de reiniciar el servicio.
4. Prueba de restauración: con un backup de la BD en un clon y las claves del gestor, el endpoint de revelado (20.4) o el script `iddoc:report` (20.3) debe poder descifrar una fila. Hazlo antes de lanzar y tras cada rotación.
5. Nunca elimines una versión del llavero mientras exista alguna fila cifrada con ella.

### 14.3 Rotación de la clave de cifrado

1. Genera la clave nueva y añade `2:<clave>` a `IDDOC_ENC_KEYS` (conservando la `1`). Copia el llavero actualizado al gestor de secretos.
2. Cambia `IDDOC_ENC_ACTIVE_KEY=2` y reinicia: lo nuevo se cifra con la `2`, lo antiguo sigue leyéndose con la `1` (sin ventana de parada).
3. Re-cifra lo antiguo con `pnpm iddoc:reencrypt --to 2 [--dry-run]` (Story 20.3, sección 15.5). Cuando `iddoc:report` no muestre filas `v1`, y solo entonces, puedes retirar la `1`.

El **índice ciego no rota con la clave de cifrado** (A97). Cambiar `IDDOC_BLIND_KEY` obliga a descifrar y recalcular el índice de todas las filas (procedimiento previsto en 20.3); hasta entonces, no la cambies.

### 14.4 Qué protege el índice ciego, y qué no

`blind = HMAC-SHA256(IDDOC_BLIND_KEY, "iddoc:v1:" + tipo + dígitos)`. Sirve para buscar por cédula exacta y detectar duplicados sin guardar la cédula en claro. **Solo protege mientras `IDDOC_BLIND_KEY` no se filtre**: una cédula tiene pocos valores posibles (unos 40 millones por tipo), así que quien tenga la clave ciega y la BD puede probarlos todos en minutos y recuperar las cédulas. Por eso la clave ciega vive fuera de la BD y de los backups, igual que las de cifrado. Una función hash sin clave (SHA-256 a secas) se descartó por la misma razón: se rompería sin necesidad de ninguna filtración. Además el índice revela **igualdad** entre filas (dos órdenes con el mismo valor ciego son de la misma cédula), cosa aceptada para detectar duplicados (A97). Nunca hay búsqueda parcial ni `LIKE`.

La normalización une todas las grafías de la misma cédula (`V-12.345.678`, `v12345678`, ` V 12 345 678 `, E/J/P/G) y no une cédulas distintas: el tipo y los dígitos (incluidos los ceros a la izquierda) cuentan siempre. Un valor heredado que no se puede interpretar (por ejemplo `12345678` sin tipo) se conserva en mayúsculas sin adivinar el tipo, se marca `unparsed` y **no recibe índice ciego**.

### 14.5 Logs

El logger de la app (`RedactingLogger`, en `main.ts` y en `pnpm tcg:ingest`) sustituye por `[REDACTED]` los campos cuyo nombre contiene `idDoc`, `buyerId`, `recipientId`, `cedula`, `password`, `token`, `authorization`, `cookie` o `secret`, y por `[REDACTED_ID]` cualquier texto con forma de cédula (`V-12345678`, `v-12.345.678`, `J-12345678-9`...), también dentro de mensajes de error y *stack traces* (por ejemplo un error de Prisma/Postgres que repite el valor). No altera UUID, fechas ni importes. Límite conocido: solo redacta lo que pasa por el logger de Nest; un `console.log` directo o un log de otro proceso (Nginx, journald de otro servicio) no se cubre. La app no activa el log de consultas de Prisma (que mostraría parámetros): no lo actives en producción.

### 14.6 Lo medido (`pnpm test:perf`, `test/iddoc-crypto.perf.spec.ts`, máquina de desarrollo)

- Redacción por línea de log: 0,23 µs (línea sin cédula, con pid de 7 dígitos, el peor caso del filtro previo), 0,28 µs (línea con cédula), 1,4 µs (objeto de 9 campos). Es despreciable aun con miles de líneas por segundo.
- Lote de 20 000 cédulas (normalizar + cifrar + índice ciego): 163 ms en total (≈ 8 µs por valor), retraso máximo del event loop 5,4 ms, porque `protectMany` cede el control cada 200 valores. Un backfill (20.3) puede ir por lotes sin bloquear el servidor.

### 14.7 Lo que NO está verificado

- Nada se ha probado en un VPS real ni con las claves reales de Angel; los tests usan claves desechables.
- Desde la Story 20.3, `deploy.sh` valida el llavero con el mismo analizador que el arranque (`parseIdDocKeyring`) antes de migrar y de reiniciar (sección 15.3); ya no depende de que la app caiga al reiniciar.
- El respaldo y la prueba de restauración de las claves (14.2) son un procedimiento operativo que Angel debe ejecutar; el código no lo hace.

## 15. Epic 20, Story 20.3: cédula cifrada en la base de datos (migración fase 1, backfill, máscara)

Esta sección es para Angel. Desde 20.3 la cédula **solo se escribe cifrada** (`recipientIdDocEnc` + índice ciego `recipientIdDocBlind`) y **todas las vistas de cliente, públicas y de admin la devuelven enmascarada** (`V-****5678`). La cédula de una orden **no se purga ni se enmascara de forma irreversible** (se necesita para la factura): queda cifrada y recuperable durante el plazo fiscal. Los scripts de esta story no pueden tocarla (lo comprueba un test estático).

### 15.1 Qué cambia

- **Migración `20261106100000_iddoc_encrypted_columns`** (100 % aditiva, `BEGIN; ... COMMIT;`): `Orders` gana `recipientIdDocEnc`, `recipientIdDocBlind`, `buyerIdType` (+ enum `BuyerIdType`), `buyerIdDocEnc`, `buyerIdDocBlind`, `buyerLegalName`; `Customer_Addresses` gana `recipientIdDocEnc`, `recipientIdDocBlind` y su `recipientIdDoc` pasa a admitir NULL. Tres índices btree sobre las columnas ciegas. **No se elimina ni se reescribe ninguna columna en claro.** Verificado sobre un clon con datos de desarrollo: el hash de `Orders` (sin las columnas nuevas) es idéntico antes y después.
- **El código nuevo** escribe solo `Enc/Blind` (la columna en claro queda NULL en filas nuevas) y lee `Enc ?? plano` hasta la fase 2.
- **Rollback de la app:** el build anterior verá NULL en las filas nuevas (cédula ausente, no corrupta). Las columnas en claro no se tocan. Si se vuelve al build anterior **después** del backfill, las filas ya cifradas conservan su claro (el backfill no lo borra), así que el build anterior sigue leyéndolas.
- **No existe la fase 2** (`..._drop_plain_iddoc`): es una release posterior y separada, no está en la carpeta de migraciones.

### 15.2 La migración sobre `Orders` en producción (sigue 12.2 y 12.3)

La migración empieza con `BEGIN;`, fija `SET LOCAL lock_timeout = '10s'` y toma **primero** `LOCK TABLE` sobre `Customer_Addresses` y `Orders`: si no consigue el lock falla entera y **no deja nada a medias** (probado sobre un clon: un lector que retiene `Orders` 14 s hace fallar la migración con `55P03` a los 10 s y no queda ni el tipo, ni las columnas, ni los índices; reintentar sin el lector la aplica). `deploy.sh` además añade `options=-c lock_timeout=<ms>` a la URL de migración (12.2), pero el `SET LOCAL lock_timeout = '10s'` de **esta** migración lo anula: su espera es siempre 10 s, tenga el valor que tenga `MIGRATE_LOCK_TIMEOUT_MS` (regla para migraciones nuevas en 12.2). Si la espera vence: `pnpm prisma migrate resolve --rolled-back 20261106100000_iddoc_encrypted_columns` y reintenta fuera de hora punta (12.3; aquí no hace falta limpiar objetos). Los tres `CREATE INDEX` no son `CONCURRENTLY` (van dentro de la transacción): mientras se construyen, `Orders` no admite escrituras; con las tablas de una tienda son milisegundos. Medido solo sobre un clon pequeño: **no** sobre una tabla grande.

### 15.3 Despliegue (lo que hace `deploy/deploy.sh`)

1. Comprueba que las tres variables existan **y** que formen un llavero válido con `parseIdDocKeyring` (`node dist/crypto/cli/check-keyring.js --env-file <.env>`; lee el archivo como datos, no lo ejecuta; imprime nombres de variables y versiones, nunca claves). Una copia de `.env.example` pasa el `grep` pero **no** esta validación: el despliegue se detiene antes de migrar y de reiniciar.
2. `prisma migrate deploy`, reinicio y health check, como antes.
3. **Después del reinicio** corre `pnpm iddoc:backfill` y `pnpm iddoc:backfill --check` (con `DATABASE_URL`, el rol limitado del servicio; límite de 30 min, `IDDOC_BACKFILL_TIMEOUT_SECONDS`). Si fallan, **el servicio no se toca** (sigue levantado y sirve: lo no cifrado todavía se lee por el respaldo y todo lo nuevo se escribe cifrado), el despliegue termina con código 1 (el job de CI queda rojo) y el log imprime el comando exacto para reanudar. El backfill es idempotente y reanudable.

### 15.4 Antes del primer despliegue

1. **Local:** `pnpm iddoc:keys` añade al `.env` local las tres líneas que falten (claves generadas al vuelo; no imprime valores, no pisa líneas existentes, es idempotente, se niega a correr con `NODE_ENV=production`, bajo `/opt/212cc` o sobre un archivo que declare producción). `--file <ruta>` apunta a otro archivo. **Guarda una copia de las claves** (14.2) antes de cifrar datos reales.
2. **Servidor:** las claves reales se generan a mano (`openssl rand -base64 32`, 14.1) y se guardan en un gestor de secretos **antes** de desplegar: el backfill cifra datos reales con ellas.
3. Respalda la base de datos antes del primer backfill.

### 15.5 Comandos (todos por lotes, con `DATABASE_URL`)

| Comando | Qué hace | Código de salida |
|---|---|---|
| `pnpm iddoc:backfill` | (1) Cifra todo claro sin `Enc` de `Orders` y `Customer_Addresses` (lotes de 500, una transacción corta por lote). (2) **Fase de nombres:** si `recipientName` de una orden o dirección lleva una cédula (`Ana (V-70123456)`, formato de la tienda antigua), la extrae a `Enc/Blind`, **verifica por descifrado desde la base** que el `Enc` coincide y solo entonces deja el nombre limpio, todo en la misma transacción bajo bloqueo de fila (ver 15.6). Registra `DATA_MIGRATION_RUN`. Idempotente, reanudable. Opciones `--batch-size N`, `--pause-ms N`. | 0 ok; 1 hubo errores o conflictos de nombre; 3 problema de claves (no escribió nada) |
| `pnpm iddoc:backfill --verify` | Descifra **todas** las filas, compara con el claro normalizado (si aún existe) y recalcula el índice ciego; además falla si algún nombre aún lleva una cédula (`nameHits`). Solo lectura. Imprime contadores e ids de fila, nunca valores. | 1 ante cualquier diferencia, claro sin cifrar o nombre con cédula |
| `pnpm iddoc:backfill --check` | Healthcheck (el que corre `deploy.sh`): sale con 1 si queda claro sin cifrar (los vacíos no cuentan), un cifrado **malformado**, un claro que **ya no coincide con su cifrado** (`plainMismatch`: un build antiguo, tras un rollback de la app, editó el claro y el `Enc` quedó desfasado) o un nombre que aún lleva cédula. Imprime contadores por conjunto y hasta 20 ids de fila por problema (`sampleIds`), nunca valores. Qué hacer con cada uno: 15.7. | 0 / 1 |
| `pnpm iddoc:backfill --scrub` | **Opcional y posterior, solo la libreta de direcciones.** Hace un `--verify` real dentro de la misma corrida y, si pasa, vuelve a verificar cada fila bajo bloqueo antes de poner `recipientIdDoc = NULL`. **Nunca** acepta `Orders`. Los claros vacíos o en blanco (nada que proteger, sin `Enc`) también se ponen a NULL: antes se quedaban para siempre y hacían fallar cada corrida. No se ejecuta en esta story. | 1 si el verify falla (no toca nada) |
| `pnpm iddoc:reencrypt --to <N> [--dry-run]` | Rotación (14.3): re-cifra a la versión `N`, con prueba en memoria por valor y escritura con comparación (`WHERE enc = <viejo>`), sin cambiar el enmascarado ni el índice ciego. `--dry-run` descifra y cuenta (también detecta valores ilegibles) sin escribir ni registrar. | 1 si algún valor es ilegible |
| `pnpm iddoc:report` | Filas por versión de clave y claros sin cifrar. Cuando no muestre `v1`, puede retirarse la clave `1`. | 0 |
| `pnpm iddoc:keys [--file ruta]` | Ver 15.4. Solo desarrollo local. | 2 si se niega |

**Claves:** antes de escribir, los comandos comprueban (a) que la clave activa cifra y descifra, (b) que **cada versión de clave guardada en la base** exista en `IDDOC_ENC_KEYS` y descifre de verdad una muestra (una clave equivocada bajo una versión conocida falla la autenticación), y (c) que `IDDOC_BLIND_KEY` reproduzca un índice ciego guardado. Si algo falla: código 3, mensaje con variable y versión (nunca un valor) y **cero escrituras**. Si el llavero activo cambia entre lotes, ambas versiones se leen y se verifican.

**Carrera con escrituras nuevas:** cada `UPDATE` exige `Enc IS NULL` y que el claro siga siendo el que se leyó; si la app (o un build antiguo) cambió la fila entre medias, no se pisa. Las filas nuevas se escriben ya cifradas, así que no entran al escaneo; una fila en claro que un build antiguo inserte "detrás" del cursor se detecta en una segunda pasada (hasta 3) o en `--check`. Un build antiguo que **edite el claro** de una fila ya cifrada deja un `Enc` desfasado: `--verify` lo informa (`plainMismatch`).

**Auditoría:** cada corrida (backfill, verify, scrub, reencrypt real) escribe un `DATA_MIGRATION_RUN` con solo contadores (modo, resultado, filas, duración), al final de su propia transacción corta, con el rol limitado. Una corrida cortada a la fuerza (kill -9) no llega a escribirlo. Si la auditoría no está disponible, el trabajo ya confirmado se mantiene, el comando lo dice y sale con código 1.

### 15.6 Quién lee la cédula, y la cédula dentro del nombre (inventario con `grep recipientIdDoc|idDoc|recipientName` sobre `src/`, `scripts/`, `prisma/`)

Lectores de `Order.recipientIdDoc*`: solo `OrderLookupService.toDetailDto` (lookup público por token, vistas del cliente y `admin/orders/:id`, todos por el serializador único). Lectores de `CustomerAddress.recipientIdDoc*`: `CustomerAddressesService.toAddressResponse` (serializador) y `resolveCheckoutShipping` (copia `Enc/Blind` sin descifrar). Las listas de admin, correos, comprobantes, dashboard y reportes **no** leen la cédula. Ninguna búsqueda usa `LIKE` sobre ella. No hay ningún `decrypt` fuera de `src/crypto/` (test estático ampliado a `scripts/`, `prisma/` y a formas como `svc['decrypt']`, alias, `.call` y `createDecipheriv`).

**Edición de dirección:** `recipientIdDoc` ausente, nulo, vacío o **enmascarado** conserva la cédula guardada; un valor nuevo se normaliza, se cifra de nuevo y borra el claro anterior; uno inválido da 400 `SHIPPING_INVALID`. «Enmascarado» es **solo** la forma exacta que produce `maskIdDoc` (`V-****5678`, `V-****`, `****5678`, `****`). Cualquier otro valor con `*` (`V-70123456*`, `V-*******8`) ya **no** se descarta en silencio: pasa por la validación normal y da 400. Un valor enmascarado al **crear** o en el **checkout** es 400.

**La cédula dentro de `recipientName` (hallazgo de QA de la 20.3).** La tienda antigua (`buildCheckoutBody`) mandaba el formato plano con la cédula concatenada en el nombre (`"Ana (V-70123456)"`, sin `recipientIdDoc` ni agencia). Con `CHECKOUT_REQUIRE_SHIPPING=false` (el valor por defecto) eso acababa **en claro** en `Orders.recipientName` y en `GET /orders/:id`, `GET /admin/orders/:id` y `GET /admin/orders`. Ahora:

1. **Checkout** (formato plano, agencia y libreta; `src/checkout/checkout-shipping.ts` + `src/crypto/id-doc-in-name.ts`): **(desde la 20.4 las longitudes son las del tipo, ver 16.5)** si `recipientName` contiene una cédula **inequívoca** (letra de tipo `V E J G P` suelta + lo que `normalizeIdDoc` acepta; entre paréntesis o corchetes, al final, al principio o en medio; con o sin espacios, puntos, `CI:`, `C.I.`, `cédula`, letras de ancho completo o caracteres de ancho cero), se extrae, se cifra a `Enc/Blind` y se guarda el nombre limpio. Si llega `recipientIdDoc` en su campo, **gana ese**. Un nombre sin cédula no se toca, y uno con cifras legítimas (`Ana 3era`, `Calle 12345`) tampoco se muta ni se rechaza. Dos cédulas distintas en el nombre, o un nombre que es solo una cédula, dan 400 `SHIPPING_INVALID` (campo `recipientName`). El formato plano acepta ahora `recipientIdDoc` en su campo (ya no lo convierte en formato agencia: solo lo hacen los campos de agencia); uno inválido o enmascarado da 400.
2. **Backfill** (fase de nombres, 15.5): `Orders` y `Customer_Addresses`. Extrae al `Enc`; solo tras leer el `Enc` de la base y **descifrarlo** para comprobar que contiene esa cédula limpia el nombre (comparando el nombre leído y con la condición SQL `Enc IS NOT NULL`). No es una purga: la cédula queda recuperable en `Enc` y el test estático (`iddoc-static.spec.ts`) comprueba que esa sentencia no puede ejecutarse sin un `Enc` verificado. Si la fila ya tenía un `Enc` **distinto** del extraído, o el nombre lleva dos cédulas distintas, es un **conflicto**: no se pisa nada, se cuenta (`nameConflicts`, resultado `NAME_CONFLICTS`, salida 1) y `--check` sigue en rojo con el id de la fila (15.7).
3. **Vistas:** `recipientName` del lookup público, de las vistas del cliente, de la libreta y de `admin/orders` (detalle y lista) pasa por `stripIdDocFromName` al leer, así que un despliegue **antes** del backfill tampoco la expone.

**Otros campos con la misma práctica (revisados):** no hay campo de notas en `Orders`. `recipientPhone`, `addressLine1/2`, `referencePoint`, `agencyBranchName` y `OrderTrackingEvent` no tienen ninguna ruta de código que les ponga una cédula; el único empaquetado de datos en texto libre que encontré es el de la tienda antigua en `addressLine2` (`[Agencia: …]`), que no es una cédula pero sí datos de envío concatenados (queda para 20.9). El teléfono del formato plano se guarda sin normalizar (no se valida): no hay evidencia de que lleve cédulas, pero tampoco nada que lo impida. Los snapshots de órdenes no copian la cédula. Las imágenes de comprobantes de pago pueden contener la cédula del pagador: eso no se procesa.

### 15.7 Cuando `--check` o el backfill se detienen: ids sin valores y cómo repararlos

Todas las salidas traen contadores y **ids de fila** (uuid), nunca cédulas ni cifrados. `psql` solo con el rol del servicio; respalda antes de reparar.

- **Cifrado malformado (`malformed`, o `KEY_PREFLIGHT_FAILED ... is not a ciphertext (row ids: ...)`).** El backfill se niega a escribir mientras exista un `Enc` que no tenga la forma `v<N>:<iv>:<tag>:<ct>` (una edición manual, una escritura mala): la alternativa sería leerlo como si fuera una cédula. Mira el mensaje o `pnpm iddoc:backfill --check` (`sampleIds.malformed`, hasta 20 ids). Para cada id: si la fila **aún tiene el claro** (`recipientIdDoc` no nulo) basta `UPDATE "Customer_Addresses" SET "recipientIdDocEnc" = NULL, "recipientIdDocBlind" = NULL WHERE id = '<id>';` (o `"Orders"`) y volver a correr `pnpm iddoc:backfill`, que lo cifra de nuevo. Si **no** tiene el claro, ese `Enc` era la única copia: restaura la fila desde la copia de seguridad (no hay forma de recuperar la cédula de un valor que no descifra) o, si es una dirección, pide al cliente que la vuelva a escribir. **No** pongas `Enc` a NULL en una orden que no tenga su claro sin una copia a mano.
- **Claro que no coincide con su cifrado (`plainMismatch`, solo en filas con claro).** Un build antiguo (tras un rollback de la app) editó el claro y el `Enc` quedó viejo. Decide cuál vale (el claro suele ser el más reciente): `UPDATE ... SET "recipientIdDocEnc" = NULL, "recipientIdDocBlind" = NULL WHERE id = '<id>';` y `pnpm iddoc:backfill` lo cifra de nuevo desde el claro. Para una orden compara antes con la factura.
- **Nombre con cédula (`nameHits`).** Corre `pnpm iddoc:backfill`: lo resuelve solo. Si queda en rojo es un **conflicto** (`nameConflicts`): el `Enc` de esa fila es distinto de la cédula del nombre, o el nombre lleva dos. No se arregla solo: mira la fila con `psql` (el nombre es texto), decide cuál es la cédula correcta y corrige a mano `recipientName` y, si hace falta, el `Enc` (poniéndolo a NULL con el claro a mano, como arriba).
  **Atajo cuando el nombre AÚN lleva la cédula (Story 20.4):** si la fila tiene un `Enc` que no corresponde (conflicto, o un `Enc` que salió de un falso positivo de reglas anteriores, p. ej. `G-20000` extraído de `Inversiones G-20000 C.A.`) y el nombre todavía contiene la cédula verdadera, basta poner `Enc` y `Blind` en NULL y volver a correr `pnpm iddoc:backfill`, que la extrae otra vez del nombre con las reglas actuales: `UPDATE "Orders" SET "recipientIdDocEnc" = NULL, "recipientIdDocBlind" = NULL WHERE id = '<id>';` (o `"Customer_Addresses"`). **Solo si el nombre aún la lleva Y estás seguro de que el `Enc` actual es el equivocado:** una fila nueva guarda la cédula del campo `recipientIdDoc` solo en el `Enc` (el claro es NULL), y si el nombre ya fue limpiado ese `Enc` es la única copia; no lo pongas a NULL sin una copia a mano. Una fila cuyo nombre fue limpiado por un falso positivo antes de la 20.4 (`Inversiones C.A.` más una «cédula» `G-20000`) no se puede reconstruir sola: el texto original de la parte quitada solo existe en el `Enc` (descífralo con una copia del llavero en un entorno aparte) o en la copia de seguridad.
- **`PORT` inválido en `deploy.sh`.** Un `.env` guardado con finales de línea de Windows (`PORT=3804\r`) rompía la URL del health check y solo avisaba. Ahora `deploy.sh` quita `\r`, espacios y comillas, y si lo que queda no es un número termina con código 1 (después del backfill) con un error explícito. Nota para la auditoría (anterior a esta story): `deploy.sh` hace `source "$ENV_FILE"`, que **ejecuta** el archivo como shell y conserva un `\r` final dentro de los valores; sustituirlo por un lector tipo dotenv queda como seguimiento.

### 15.8 Lo medido (disposable Postgres 17 en contenedor, rol limitado `collectorsclub_d203_app`, 12 000 órdenes + 3 000 direcciones sintéticas, máquina de desarrollo)

- Backfill de 12 262 filas (con 4 hilos de carga simulada de checkouts, lecturas y ediciones de dirección): 1 478 ms, 25 lotes, retraso máximo del event loop 15,4 ms. Latencia de la carga: checkout p99 12,5 ms durante el backfill frente a 4,1 ms sin él; lecturas p99 6,3 ms frente a 3,9 ms; 0 errores. Segunda corrida: 0 filas cifradas. `--verify` de 17 243 filas: 0,8 s. `iddoc:reencrypt --to 2` de 17 243 filas: 5,5 s; después `iddoc:report` muestra 0 filas `v1`.
- Corte forzado (kill -9) a mitad de la corrida y reanudación: sin pérdidas ni duplicados.
- **No verificado:** un VPS real; checkouts HTTP concurrentes contra el servidor Nest durante el backfill (la carga fue de SQL equivalente, la app sí se probó con checkouts reales en los e2e, pero no a la vez); tablas de millones de filas; `deploy.sh` entero (solo su tramo posterior al reinicio, con `pnpm` simulado); la restauración de claves de 14.2.


## 16. Epic 20, Story 20.4: cédula del comprador en el checkout, búsqueda por cédula y revelado

Esta sección es para Angel. **No hay migraciones nuevas** en esta story (las columnas `buyerId*` ya las creó la 20.3). Lo que cambia es código, tres variables de entorno y la plantilla de Nginx.

### 16.1 Qué cambia

- `POST /checkout` acepta `buyerId {type, number}`, `buyerSameAsRecipient`, `buyerLegalName` y `expectedCustomerId` (contrato exacto en 16.3). La cédula del comprador se valida **antes** de la transacción (sin Order ni StockHold si falla), se cifra y se guarda en `Orders.buyerIdType/buyerIdDocEnc/buyerIdDocBlind/buyerLegalName`; nunca el claro. Las órdenes históricas no se tocan.
- `POST /admin/orders/search {idDoc: 'V-12345678'}`: búsqueda exacta por índice ciego (destinatario **o** comprador). **La cédula va en el cuerpo, nunca en la URL** (FR-124): `GET /admin/orders?idDoc=` responde 400 (16.6).
- `POST /admin/orders/:orderId/reveal-id-doc {field: 'recipient'|'buyer'}`: devuelve la cédula completa **después** de comprometer el evento de auditoría `ID_DOC_REVEALED`; máximo `ID_DOC_REVEAL_MAX_PER_HOUR` (30) por admin y hora.
- Las vistas de orden ya devolvían `buyerIdDoc` (enmascarado), `buyerIdType` y `buyerLegalName` desde la 20.3.
- `SHIPPING_INVALID` (checkout y libreta) lleva ahora `details.field` y `details.reason` (el primer error; `details.errors[]` sigue con la lista completa).
- La extracción de la cédula metida en `recipientName` ya no confunde `Inversiones G-20000 C.A.` ni `Edificio P-12345` con cédulas (16.5).

### 16.2 La exigencia de la cédula del comprador: `CHECKOUT_REQUIRE_BUYER_ID` (léelo antes de activar nada)

**La cédula es obligatoria en facturas (decisión de Angel), pero la tienda actual (frontend) todavía no la envía: la manda la Story 20.9.** Por eso la exigencia es un interruptor de despliegue, no un comportamiento fijo:

| Valor | Efecto |
|---|---|
| `CHECKOUT_REQUIRE_BUYER_ID=false` o ausente (**valor por defecto**) | Un checkout **sin** `buyerId`/`buyerSameAsRecipient` se acepta y la orden queda sin cédula de comprador (`buyerIdType`, `buyerIdDocEnc`, `buyerIdDocBlind` en NULL, como una orden histórica). Un `buyerId` que **sí** llegue se valida siempre (400 si es inválido) y se guarda. La tienda sigue vendiendo exactamente igual que antes de la 20.4. |
| `CHECKOUT_REQUIRE_BUYER_ID=true` (valor exacto, en minúsculas; se lee en cada petición) | Un checkout sin comprador responde `400 BUYER_ID_REQUIRED` (`details.field = buyerId`, `reason = REQUIRED`) **sin Order ni StockHold**. |

**Qué se rompe y cuándo.** Con el valor por defecto, nada se rompe al desplegar la 20.4. **Si activas `true` antes de la 20.9, la tienda deja de vender: el 100 % de los checkouts del frontend actual responde 400** (el frontend no manda `buyerId`; en el formato plano antiguo ni siquiera existe `buyerSameAsRecipient`, que allí siempre es `BUYER_ID_REQUIRED`). En producción el backend avisa con un WARN al arrancar mientras el interruptor no esté en `true`. **Cualquier otro valor que no sea `true`, `false` o ausente (`TRUE`, `True`, `1`, `yes`, ` true`, vacío...) deja el interruptor apagado y escribe un WARN en el log (`CHECKOUT_REQUIRE_BUYER_ID="TRUE" is not recognized...`) en cualquier entorno**, una vez por valor distinto; si activaste la exigencia y ves ese aviso, no está activa: corrige el valor.

**Orden de despliegue recomendado:**

1. Desplegar el backend con la 20.4 (interruptor apagado). Nada cambia para el cliente.
2. Desplegar el frontend de la 20.9 (envía `buyerId` o `buyerSameAsRecipient`, y `expectedCustomerId`).
3. Pasar `CHECKOUT_REQUIRE_BUYER_ID=true` en el `.env` del entorno y reiniciar el servicio. Desde ese momento ninguna orden nueva nace sin cédula.
4. Entre los pasos 1 y 3, las órdenes nuevas que lleguen sin comprador quedan sin cédula fiscal. Para saber cuántas y desde cuándo: `SELECT count(*), min("createdAt"), max("createdAt") FROM "Orders" WHERE "buyerIdDocEnc" IS NULL AND "createdAt" > '<fecha del paso 1>';` (esas habrá que completarlas con el cliente antes de facturar; **no** se completan solas).

**Interacción con `CHECKOUT_REQUIRE_SHIPPING`** (17.4, también `false` por defecto):

- Los dos son independientes y se comprueban en este orden: primero la cuenta esperada (409), luego `SHIPPING_REQUIRED`, luego `BUYER_ID_*`, todo antes de tocar la BD. Un cuerpo que viola ambos recibe `SHIPPING_REQUIRED`.
- `buyerSameAsRecipient: true` solo existe en el formato agencia/libreta (Epic 17). Con `CHECKOUT_REQUIRE_SHIPPING=false` el formato plano antiguo sigue siendo válido, pero ahí el comprador **tiene que ir explícito** (`buyerId`), nunca "igual que el destinatario".
- Activar solo `CHECKOUT_REQUIRE_BUYER_ID=true` rompe a toda tienda que no envíe el comprador (formato plano incluido). Activar solo `CHECKOUT_REQUIRE_SHIPPING=true` rompe a toda tienda que use el formato plano. Con la 20.9 desplegada pueden activarse juntos.

### 16.3 Contrato exacto para la Story 20.9

**Request de `POST /api/v1/checkout`** (campos nuevos; todos opcionales a nivel de DTO):

```jsonc
{
  "buyerId": { "type": "V" | "E" | "J" | "P" | "G", "number": "12345678" },  // solo el número, sin la letra; puntos/espacios/guiones se ignoran
  "buyerSameAsRecipient": true,        // copia la cédula del destinatario (solo formato agencia/libreta, destinatario V/E)
  "buyerLegalName": "Empresa C.A.",    // ≤ 200; OBLIGATORIO si type es J o G; se ignora en V/E/P
  "expectedCustomerId": "<uuid>" | null // id de cuenta que la tienda cree tener (de /auth/me); null = "soy invitado"; ausente = sin comprobación
}
```

Reglas: `V/E` 6-9 dígitos; `J/G` RIF de 9 dígitos (8 + dígito verificador, ver 16.4); `P` 6-12 letras/dígitos con al menos un dígito. `buyerId` y `buyerSameAsRecipient: true` juntos son una contradicción (400 `BUYER_ID_INVALID`, `CONFLICTS_WITH_BUYER_ID`); `buyerSameAsRecipient: false` junto a `buyerId` es válido.

**Errores** (todos 400 salvo indicación; `details.field` y `details.reason` sin valores):

| `errorCode` | `details.field` | `details.reason` |
|---|---|---|
| `BUYER_ID_REQUIRED` | `buyerId` | `REQUIRED` (no se envió comprador y el servidor tiene el interruptor en `true`) |
| `BUYER_ID_REQUIRED` | `buyerId.type`, `buyerId.number` | `REQUIRED` |
| `BUYER_ID_REQUIRED` | `buyerLegalName` | `REQUIRED` (J/G sin razón social) |
| `BUYER_ID_REQUIRED` | `buyerSameAsRecipient` | `SAME_AS_RECIPIENT_NEEDS_AGENCY_FORMAT` (formato plano), `RECIPIENT_ID_MISSING` (la dirección guardada no tiene cédula) |
| `BUYER_ID_INVALID` | `buyerId.type` | `INVALID_TYPE` |
| `BUYER_ID_INVALID` | `buyerId.number` | `INVALID_FORMAT` (letras donde van dígitos, máscara, letra de tipo dentro del número), `INVALID_LENGTH`, `INVALID_CHECK_DIGIT` (RIF) |
| `BUYER_ID_INVALID` | `buyerLegalName` | `TOO_LONG`, `INVALID_FORMAT`, `CONTAINS_ID_DOC` (la razón social lleva una cédula o RIF, p. ej. `Emp V-87654321 C.A.` o el RIF propio de la empresa: se **rechaza**, no se recorta, porque la factura saldría con otro nombre; el RIF del comprador va en `buyerId`) |
| `BUYER_ID_INVALID` | `buyerSameAsRecipient` | `CONFLICTS_WITH_BUYER_ID`, `RECIPIENT_ID_NOT_VE` (la dirección guardada no es V/E o su índice no coincide) |
| `SHIPPING_INVALID` | `recipientIdDoc`, `recipientName`, ... | `REQUIRED`, `INVALID` (con `buyerSameAsRecipient` y cédula de destinatario ausente o no V/E, el error es este y habla del **destinatario**) |
| `CHECKOUT_ACCOUNT_MISMATCH` (409) | — | `expectedCustomerId` no coincide con la sesión de esta petición; sin efecto (el carrito de la cuenta se conserva) |
| `INVALID_CUSTOMER_TOKEN` (401) | — | cuenta anonimizada o inexistente (20.6, ver 18) |
| `CHECKOUT_UNAVAILABLE` (503) | — | **retirado en la 20.6**: era el fallo del sondeo de la columna `anonymizedAt`; el sondeo ya no existe (18.1) |

**Respuestas de lectura**: `fulfillment.buyerIdDoc` (`"J-****3805"`), `fulfillment.buyerIdType`, `fulfillment.buyerLegalName`; `recipientIdDoc` sigue enmascarado. La orden de la tienda antigua puede traer los tres a `null`.

**Admin**:

- **Búsqueda por cédula: `POST /api/v1/admin/orders/search`** (`AdminAuthGuard`, `Content-Type: application/json`). Cuerpo (se rechaza con 400 cualquier propiedad desconocida):

  ```jsonc
  {
    "idDoc": "V-12.345.678",          // OBLIGATORIO, string ≤ 30; cualquier grafía aceptada (V12345678, v-12.345.678...)
    "page": 1, "limit": 20,           // opcionales, como GET /admin/orders (limit ≤ 100); números JSON
    "status": "paid",                 // opcionales, como GET /admin/orders (enums en minúscula)
    "paymentRail": "pago_movil",
    "refundPending": true,            // booleano JSON
    "sortOrder": "desc"               // asc | desc, por Order.createdAt
  }
  ```

  Respuesta `200`: **la misma forma que `GET /admin/orders`** (`{data: [...], meta: {page, limit, total, totalPages}}`) con `Cache-Control: no-store`; sin coincidencias, página vacía y 200. `400 ID_DOC_FILTER_INVALID` (`details = {field: 'idDoc', reason: 'INVALID_FORMAT'}`) si no es una cédula completa (el valor no se devuelve). Solo igualdad exacta (7 dígitos de un V de 8 **no** encuentra nada, no hay prefijos). `401 INVALID_ADMIN_TOKEN`. Lo mismo vale para la Story 20.6 (`POST /admin/customers/search {q?, idDoc?, cursor?}`; **`GET /admin/customers?idDoc=` no debe existir**) y la 20.9 (el frontend usa el POST; nunca pone una cédula en una URL, ni en `fetch` ni en la barra del navegador).
- **`GET /admin/orders` con una clave de cédula en la URL** (`idDoc`, `idDoc[]`, `idDoc[a]`, repetida, cualquier mayúscula/minúscula, `recipientIdDoc`, `cedula`...): `400 ID_DOC_IN_URL_NOT_ALLOWED` (`details = {reason: 'USE_POST_SEARCH'}`), sin eco del valor y **sin consultar la base de datos** (antes `?idDoc[]=` devolvía la lista sin filtrar).
- `POST /admin/orders/:orderId/reveal-id-doc` con `{field}`: `200 {value, unparsed}` y `Cache-Control: no-store` (también en los errores). `unparsed: true` marca un valor heredado sin tipo (sin índice ciego: no se pudo contrastar con la fila; se entrega igualmente y el evento de auditoría lo registra). Errores: `404 ORDER_NOT_FOUND`, `404 ID_DOC_NOT_FOUND` (esa orden no tiene cédula en ese campo: p. ej. una orden histórica sin comprador), `429 ID_DOC_REVEAL_RATE_LIMITED` con cabecera `Retry-After` (segundos hasta que el evento más antiguo de la última hora deje de contar) y `details.limitPerHour`, `500 ID_DOC_INTEGRITY_FAILED` (`details.reason`: `BLIND_MISMATCH`, `BLIND_MISSING`, `DECRYPT_FAILED`, `ENC_MALFORMED`; no se entrega nada; **sí se audita** como `ID_DOC_INTEGRITY_FAILED` y no gasta cupo), `503 AUDIT_UNAVAILABLE` (la auditoría no se pudo comprometer, ni la del revelado ni la del fallo de integridad: **no** se entrega; reintentar). El frontend oculta el valor a los 30 s.

### 16.4 El dígito verificador del RIF: confirma uno real antes de dejar `RIF_CHECKDIGIT_STRICT` en estricto

El algoritmo es el del SENIAT (pesos `4 3 2 7 6 5 4 3 2` sobre `[letra, d1..d8]`, `dv = 11 - (suma mod 11)`), probado con el RIF publicado de Banesco (`J-07013380-5`). **El caso «resto 1 → dígito 9» no está confirmado** contra un RIF real: hay implementaciones públicas que en ese caso dan `0`. Si el valor estricto rechazara RIFs válidos, el 1 de cada 11 RIFs aproximadamente (los de resto 1) daría `400 BUYER_ID_INVALID/INVALID_CHECK_DIGIT` a clientes legítimos en el checkout.

- **Recomendación hasta confirmarlo: `RIF_CHECKDIGIT_STRICT=false`** (el `.env.example` ya lo trae así). Solo se omite el dígito verificador; el formato (9 dígitos, tipo J/G) se exige igual. Cuesta poco: un RIF mal tecleado pasará, pero la factura la revisa una persona.
- **Cómo confirmarlo:** toma un RIF real de J o G cuyo cálculo dé resto 1 (suma de `4×letra + 3·d1 + 2·d2 + 7·d3 + 6·d4 + 5·d5 + 4·d6 + 3·d7 + 2·d8` con J=3, G=5, módulo 11 igual a 1) y comprueba en la consulta del SENIAT que su dígito es el que el código espera (9). Con un resultado distinto, el cambio es de una línea en `src/crypto/rif-check-digit.ts` y su test. Mientras no lo confirmes, el valor por defecto del **código** (variable ausente) sigue siendo estricto: por eso el `.env.example` lo pone explícitamente en `false`.

### 16.5 Falsos positivos de la extracción de la cédula en el nombre

Alineada con las reglas de `buyer-id.ts`: un token con letra de tipo solo cuenta como cédula si tiene los dígitos que ese tipo tiene (V/E 6-9, J/G 9, P 6-12). `Inversiones G-20000 C.A.`, `Edificio P-12345` y `Local J-12345678` se dejan intactos (antes quedaban como `Inversiones C.A.` y se cifraba `G-20000` como «cédula»). Un cuerpo con `buyerId` explícito no depende de esto: gana siempre el campo. Una etiqueta inequívoca sin letra (`Ana CI 12345678`, `C.I.: 12.345.678`, `cédula 12345678`) se toma como `V`; `RIF 12345678` o `pasaporte 12345678` sin letra no (no se puede saber el tipo). Los datos ya migrados con las reglas anteriores y los pasos para repararlos están en 15.7.

### 16.6 La cédula nunca va en una URL: búsqueda por `POST`, Nginx y logs

La primera versión de la 20.4 buscaba con `GET /admin/orders?idDoc=`. Incumplía FR-124 («cédulas jamás en … URLs») y NFR-20.5: aunque el `access_log` use `$uri`, el **`error_log` de Nginx imprime la línea completa de la petición** cuando falla el `proxy_pass` (`upstream timed out`, `connect() failed`...), y ningún formato lo evita. La corrección es de contrato, no de logs: **la búsqueda es `POST /admin/orders/search {idDoc}`** (16.3) y un `GET` que lleve la cédula responde 400 sin consultar.

- **Qué hace la aplicación**: no tiene log de acceso (Nest no imprime peticiones), el middleware de uso de la 20.7 no guardará nunca la query string (AD-100), el redactor de logs enmascara `idDoc=...`/`idDoc[]=...` si apareciera en un mensaje, y el 400 de `GET` no repite el valor.
- **`log_format` de las plantillas de Nginx (`cc_prod_noquery` / `cc_staging_noquery`): se CONSERVA**, ya no como arreglo de la cédula sino como defensa en profundidad: sigue evitando que cualquier query string (un cliente antiguo que aún mande `?idDoc=`, tokens en enlaces, etc.) llegue al `access_log`. Cuesta una línea y no cambia nada para quien no lo use. **Si ya copiaste la plantilla de la primera versión, no hay que volver a hacerlo**; si no la has copiado, cópiala igualmente con el resto (1.7). Lo que **no** cubre sigue siendo el `error_log`: por eso la cédula no debe viajar nunca por GET.
- **Rutas revisadas** (query y path de cédula): ninguna otra ruta admin ni de cliente lleva cédula en la URL. Las únicas con campos de cédula son cuerpos JSON (`POST /checkout`, `POST/PATCH /auth/addresses`, `POST /admin/orders/search`, `POST /admin/orders/:orderId/reveal-id-doc`, y `POST /admin/customers/:id/addresses/:addressId/reveal-id-doc` en la 20.6). Los `@Query`/`@Param` restantes son identificadores (UUID, slug, `seq`) o filtros de catálogo.
- **Para quien añada rutas** (20.6, 20.9): usar `assertNoIdDocInQuery(request.query, '<POST path>')` (`src/common/id-doc-not-in-url.ts`) en cualquier `GET` de listado que pudiera confundirse con una búsqueda.

### 16.7 El revelado y el lock de la cadena de auditoría (lo medido)

- Flujo: se lee la orden, se **descifra y se contrasta en memoria** con el índice ciego de la fila (`blindIndexOf(decrypt(enc))`; el AAD del cifrado es constante, así que un cifrado válido puede copiarse a otra orden y descifraría igual; si no coincide no se entrega nada, se registra `ID_DOC_INTEGRITY_FAILED order=<id> field=<campo> reason=<motivo>`, se **audita** el intento (`ID_DOC_INTEGRITY_FAILED`: admin, orden, campo y motivo, sin valor; no gasta cupo ni usa el lock del conteo) y, si ese evento no se puede escribir, la respuesta es `503 AUDIT_UNAVAILABLE` en vez del 500). Luego una transacción de auditoría **propia y comprometida primero**: toma el lock de la cadena, cuenta los `ID_DOC_REVEALED` del admin en la última hora (conteo exacto dentro del lock: a prueba de carreras y de varias instancias), si hay `≥ ID_DOC_REVEAL_MAX_PER_HOUR` responde 429 sin escribir, y si no inserta el evento con `AuditService.record` **como última sentencia**. Solo con el commit hecho se devuelve el valor.
- El evento lleva actor, `Order`, id de la orden, `after: {field}` (más `unparsed: true` si aplica), `requestId` e IP; nunca el valor ni el cifrado.
- **Solo `revealOrderIdDoc` devuelve un claro.** La verificación (`#verifyStored`) es privada en tiempo de ejecución y un test estático (`decrypt-usage.spec.ts`) falla si la clase gana otro método público. El generador de facturas de la historia futura **no** debe obtener la cédula por una puerta lateral: necesita su propio método explícito en `IdDocRevealService` que deje evento, o una decisión explícita (añadirlo a ese test a propósito).
- El conteo bajo el lock es el único trabajo extra. Se escribió con `statement_timestamp()` (estable) en vez de `clock_timestamp()` (volátil): **medido con 1 000 000 de filas, la versión volátil no podía usar el índice y tardaba 103 ms bajo el lock** (recorría 998 000 filas de `Audit_Events_occurredAt_idx`); la versión estable usa `Audit_Events_occurredAt_idx` + `Audit_Events_action_seq_idx` y tarda 0,13 ms.
- **Cifras** (`pnpm test:perf`, `test/id-doc-reveal.perf.spec.ts`; esquema sandbox sin triggers en el Postgres de desarrollo, 1 000 000 de filas, ~1 800 en la última hora, `ANALYZE` hecho): conteo p50 0,13 ms, p95 0,18 ms (plan solo con índices, 19 buffers). **Lock retenido** con 31 transacciones concurrentes: transacción de auditoría simple de un evento p50 2,4 ms, p95 5,4 ms, máx 7,0 ms; revelado completo p50 5,1 ms, p95 16,5 ms, máx 23,5 ms (incluye el `record` y el segundo `LockBudget`). Contra el servidor real (clon, rol limitado `_app`), 31 reveals concurrentes de un admin: 30 × 200 y 1 × 429 con `Retry-After: 3600`; latencia del cliente p50 195 ms, p95 251 ms, 255 ms en total.
- Corte de la auditoría: con la tabla sin poder escribir (`CHECK` imposible en el sandbox) el revelado responde 503 y no entrega; con el lock retenido por otra sesión responde 503 a los ~5 s (`lock_timeout` del presupuesto de auditoría), sin valor ni evento.

### 16.8 Variables nuevas (ver `.env.example`)

| Variable | Defecto | Qué hace |
|---|---|---|
| `CHECKOUT_REQUIRE_BUYER_ID` | `false` | Exige comprador en el checkout (16.2). Se lee en cada petición. |
| `ID_DOC_REVEAL_MAX_PER_HOUR` | `30` | Límite de revelados por admin y hora. Un valor que no sea un entero positivo se ignora (queda 30). |
| `RIF_CHECKDIGIT_STRICT` | ausente = estricto (`.env.example`: `false`) | 16.4. |

### 16.9 Lo que NO está verificado ni hecho

- El `FOR SHARE` de `anonymizedAt` (AC4) era el punto de enganche de la 20.6 con un sondeo de existencia de columna: **la 20.6 lo retiró** (18.1) y lo probó contra el `FOR UPDATE` real (18.8).
- `log_format` de Nginx: no se probó con `nginx -t` (no hay imagen de Nginx en esta máquina); la sintaxis es la estándar.
- Los RIF de los tests son uno publicado (Banesco) y valores calculados a mano; el caso resto 1 no se ha contrastado con un RIF real (16.4).
- Nada de esto se ha probado en un VPS real ni con tablas de producción.

## 17. Epic 20, Story 20.5: eventos de auditoría desde las acciones reales, límite del login admin y base de pruebas desechable

### 17.1 `pnpm test:e2e` y `pnpm test:perf` ya no tocan tu base de desarrollo

**Por qué.** `Audit_Events` es inmutable (triggers + `REVOKE`) y, desde esta story, casi cualquier e2e escribe eventos (login admin, FX, vitrina, checkout con consentimiento, legal). Una fila escrita en tu base real **no se puede borrar**. Ya pasó una vez (un e2e de la 20.4 renombró una tabla de un sandbox y, con `search_path = sandbox,public`, una sentencia sin esquema cayó en la tabla real). Además, la suite llevaba meses dejando residuos en tu base (`Acc%`, instantáneas FX, órdenes) y restaurando a mano lo que tocaba.

**Qué hace ahora.** `test/helpers/global-test-db.ts` (primer `globalSetup`; se desmonta el último):

1. Borra clones viejos de corridas muertas (`<base>_e2e_<epoch>_<hex8>` de más de 3 horas; solo nombres de ese formato exacto, nunca la base fuente).
2. `CREATE DATABASE "<base>_e2e_<epoch>_<hex8>" TEMPLATE "<base>"` (126 MB: unos 2 s). Postgres solo clona una base **sin otras sesiones conectadas**, y cada intento rechazado espera él mismo ~5 s a que se vayan. El helper reintenta hasta que pasen **60 s en total** (un plazo, no un número de intentos: con 40 intentos la corrida abortaba a los 272 s) y entonces aborta con un mensaje (no mata ninguna sesión). Salida: parar el servidor de desarrollo, o `E2E_DB_SOURCE=<otra base tranquila>` (abajo). Justo después de crear el clon le pone un `COMMENT ON DATABASE` con una marca que solo conoce esa corrida.
3. Apunta `DATABASE_URL` (y `MIGRATE_DATABASE_URL` si existe) de **toda la corrida** al clon antes de crear los workers, y comprueba con `SELECT current_database()` que es un clon. Cada archivo de test vuelve a comprobarlo (`test/helpers/assert-test-db.ts`, `setupFiles`): una URL que no case con `^[a-z0-9_]+_e2e_\d{10}_[0-9a-f]{8}$` aborta el archivo.
4. Al terminar: **verifica la cadena de auditoría completa** del clon (génesis a cabeza, cada hash) con `AuditChainVerifier` e imprime `[e2e db] audit chain of <clon> after the run: OK, N rows verified from genesis`; si está rota, la corrida falla. Después `DROP DATABASE ... WITH (FORCE)` (un `DROP`, no un `DELETE`: los triggers de inmutabilidad no aplican), **solo tras un chequeo positivo** (`assertDroppable`): el nombre tiene el formato de clon, no es la base fuente ni la que apuntaba `DATABASE_URL`, existe, y su comentario es la marca de esta corrida. Si algo no cuadra no se borra nada y la corrida falla con el motivo.

Los `global-*` de snapshot (FX, `Product_Daily_Stats`, vitrina, landing, consentimientos huérfanos) siguen funcionando, ahora sobre el clon (son inofensivos y protegen si alguien apunta la suite a otra base); su marcador de aborto lleva la identidad de la base, así que uno viejo de tu base real **no** se restaura en un clon.

Necesita `CREATEDB`: el propietario (`MIGRATE_DATABASE_URL`) o, con una sola URL, el rol actual. Con rol limitado: `DATABASE_URL='<app>' MIGRATE_DATABASE_URL='<propietario>' pnpm test:e2e --no-file-parallelism` (el clon hereda los privilegios del rol).

**Cómo crear la plantilla tranquila (`E2E_DB_SOURCE`).** Si tu servidor de desarrollo mantiene sesiones abiertas sobre `collectorsclub_dev`, el clon no se puede crear. Una vez, con el servidor parado (o desde `postgres`, sin sesiones en la base):

```sql
-- conectado a la base `postgres`, sin sesiones en collectorsclub_dev
CREATE DATABASE collectorsclub_e2e_template TEMPLATE collectorsclub_dev;
```

y luego `E2E_DB_SOURCE=collectorsclub_e2e_template pnpm test:e2e --no-file-parallelism` (o ponlo en tu `.env` local). Nadie debe conectarse a la plantilla (ni `prisma migrate`, ni el servidor): es solo el molde. Cuando una migración nueva cambie el esquema, bórrala y vuelve a crearla (`DROP DATABASE collectorsclub_e2e_template;` y el `CREATE` de arriba), o aplícale las migraciones con `DATABASE_URL` apuntando a ella y cierra la sesión. Los clones se llaman `<plantilla>_e2e_<epoch>_<hex8>`; el nombre de la plantilla no puede tener ese formato (el helper se niega a clonar un clon). Con rol limitado el clon hereda los privilegios de la plantilla.

Comprobado: tras `pnpm test:e2e` completo `SELECT count(*) FROM "Audit_Events"` en `collectorsclub_dev` sigue en 1 y no queda ninguna base `*_e2e_*`.

**El sandbox no cae a `public` (seguimiento de la 20.4).** Los e2e de auditoría siguen usando `search_path = <sandbox>,public` con nombres sin esquema, así que si la tabla del sandbox faltara, `"Audit_Events"` resolvería en silencio a `public."Audit_Events"` (en un clon desechable, el clon de la tabla real). `createAuditSandbox` ahora **verifica** con `to_regclass('"<sandbox>"."Audit_Events"')` al crearlo y `sb.exec()` lo vuelve a verificar antes de cualquier sentencia que nombre la tabla: si no existe lanza `Audit sandbox "..." has no "Audit_Events" table ... Refusing to continue` en vez de leer o escribir en `public`. Probado por `test/audit-events.e2e-spec.ts` (se borra la tabla del sandbox y `exec` lanza). Lo que el helper **no** puede impedir: una escritura de la **aplicación** (que va por su propio pool) si un test hace desaparecer la tabla a mitad de camino; por eso no se renombra ni se borra la tabla del sandbox en ningún test (el CHECK imposible de la 20.4 es la forma permitida de simular un fallo de escritura).

Efecto colateral: `test/related-products.e2e-spec.ts` fallaba por residuos de tu base (productos NARUTO activos de corridas viejas llenaban los 10 puestos del ranking). Ahora, como corre en un clon, aparca (`isActive=false`) los NARUTO activos mientras dura y los devuelve; tus datos no se tocan.

### 17.2 Qué acción emite qué (todas en la **misma transacción** y como **última sentencia**)

Todas usan `AuditService.transaction(fn)`: `audit.add(ev)` solo acumula; el lock de la cadena y el `INSERT` van **después** de `fn`, justo antes del commit. Ninguna llama a Stripe, correo, proveedor FX ni nada externo dentro de la transacción (Stripe en el checkout se llama **después** de que la transacción confirma; el proveedor FX, antes de abrirla). Un fallo al auditar revierte la acción y responde `503 AUDIT_UNAVAILABLE`, salvo `LOGIN_ADMIN_FAILED` (best-effort).

| Acción | Dónde | Notas |
|---|---|---|
| `PAYMENT_PAGO_MOVIL_CONFIRMED/REJECTED` | `AdminOrderPaymentService` | ids, estados, `amountUsd/amountVes/fxRate` como string, nº de holds. Sin referencia bancaria, teléfono ni nombre. |
| `STRIPE_PAYMENT_STATE_CHANGED` | `StripePaymentsService` | solo si la transición guardada gana; un duplicado devuelve `duplicate` antes de añadir nada (sin lock de cadena). |
| `ORDER_STATUS_CHANGED` | cumplir/cancelar (admin), cron de expiración de holds y de timeout de `payment_processing` (actor `SYSTEM`), fallo al crear la sesión Stripe | |
| `ORDER_TRACKING_CHANGED` | `AdminOrderTrackingService` | misma tx que `Order_Tracking_Events` (se mantiene); un valor igual no emite. |
| `PRODUCT_PRICE_CHANGED`, `PRODUCT_STOCK_ADJUSTED` | `AdminProductsService` (`PATCH /admin/products/:id` y `/:id/stock`) | bloquea la fila (`FOR UPDATE`) para que `before` sea el `after` anterior; solo si cambia. |
| `SHIPPING_AGENCY_CHANGED` | `ShippingAgenciesService` (crear/editar/borrar) | |
| `FX_SOURCE_CHANGED`, `FX_RATE_CHANGED` | `AdminFxService` (`PUT /settings`, `accept-rejected`) y `FxRefreshService` (refresco del proveedor: cron cada 30 min y el «refrescar» del admin) | `Fx_Setting_Audits` se mantiene. El refresco emite `FX_RATE_CHANGED` con actor `SYSTEM` (`origin: AUTO_REFRESH` o `ADMIN_REFRESH` + `triggeredBy`) **solo si cambia la tasa** (mueve los precios en bolívares): una lectura rechazada, un fallo o una lectura que deja la tasa igual no emiten. El evento va en la misma transacción que la tasa y el snapshot, como última sentencia; el proveedor se lee **antes** de abrirla (ningún I/O externo dentro). Si la auditoría falla, el refresco entero se revierte (tasa vieja, sin snapshot), se anota en `lastError` («audit log is unavailable», transacción propia, sin evento) y se loguea con `logger.error`; el ciclo siguiente (30 min) lo reintenta. |
| `VITRINA_CONFIG_CHANGED` | `AdminVitrinaService.updateAlgorithm` | solo las claves que cambian; los no enteros (`mmrLambda`, `priorM`) como string. |
| `LEGAL_DOC_PUBLISHED`, `SELLER_IDENTITY_UPDATED` | `LegalAuditService.record(tx, input, collector)` | solo `PUBLISHED` e `IDENTITY_UPDATED` delegan; el resto (`DRAFT_*`, `RESTORED`) no entra al catálogo. El evento lleva el SHA-256 del texto, nunca el texto. La identidad del vendedor es dato público (`publicFields`). |
| `CONSENT_RECORDED` | `ConsentService.recordConsents(tx, {…, audit})` | **uno por llamada** con `consentRecordIds` y `versions`; checkout (`audit.transaction`), registro y re-aceptación. |
| `LOGIN_ADMIN_OK`, `LOGOUT_ADMIN`, `LOGIN_ADMIN_FAILED`, `LOGIN_ADMIN_FAILED_SUMMARY` | `AdminAuthService`, `AdminLoginFailureSummary` | ver 17.3. |
| `PRODUCT_CREATED`, `PRODUCT_DELETED`, `PRODUCT_ACTIVE_CHANGED` | `AdminProductsService` (`POST /admin/products` manual y desde master card, `DELETE`, `PATCH { isActive }`) | misma transacción, `FOR UPDATE` en el borrado y el cambio. Solo ids y dinero (sin nombre, slug ni descripción: un título como «PSA 10 ... 1999» dispara los detectores de teléfono/cédula). `isActive` solo emite en una transición real. Un `DELETE` de un producto con historial no lo borra: lo desactiva y **eso** es el evento (`via: DELETE_FALLBACK`). Fail-closed: 503 y no cambia nada. |
| `DATA_IMPORT_RUN` | `TcgSyncRunService.finish` (cron nocturno, CLI `tcg:ingest`, ingest del admin) | **un** evento por corrida con los contadores (peticiones, cartas, productos actualizados, errores, cuota agotada, nº de variaciones grandes), nunca una fila por precio; el actor es el admin que la lanzó o `SYSTEM`. Coste: un `INSERT` más bajo el lock de la cadena por corrida (unas pocas al día), sin llamada externa. La fila de la corrida es además el **lock** de sincronización (una fila `RUNNING` bloquea otras 2 h): si la auditoría cae, la corrida se cierra igual sin evento y se loguea el error. |
| `CUSTOMER_PASSWORD_RESET` | `CustomerAuthService.resetPassword` | actor: el cliente (dueño del token). BetterAuth trabaja con su propia conexión: el evento se escribe justo **después** del cambio (si la auditoría falla, la contraseña ya cambió y sus sesiones están revocadas: se responde 200 y se loguea el error, nunca un 4xx por un token ya usado). Sin correo ni token. El cambio de contraseña con sesión (pide la contraseña actual) no entra: ver 17.6. |
| `CUSTOMER_EMAIL_VERIFIED_BY_ADMIN` | `AdminCustomersService.verifyEmail` (`POST /admin/customers/verify-email`, tras la bandera temporal) | misma transacción; solo si el correo estaba sin verificar (el idempotente no emite); el correo solo como `emailHash`. Fail-closed. |
| `REFUND_PENDING_RECORDED` | `StripePaymentsService` (`refund_pending_after_terminal` y `refund_pending_no_stock`) | Stripe cobró y la orden no se pudo pagar: hay que devolver a mano. `reason: AFTER_TERMINAL` va en la transacción del webhook; `NO_STOCK` en la segunda transacción corta que ya registraba la fila. Una redelivery (duplicado) no emite; si la auditoría falla el webhook responde 5xx y Stripe reintenta. |
| `DATA_EXPORTED` | `AuditService.recordDataExport(admin, {dataset, format, rows, filters})` | helper listo; hoy ninguna exportación lo llama (no existe ninguna). |

**Sin emisor hoy (justificado en `test/audit-coverage.spec.ts`):** `REFUND_ISSUED` (no hay ruta de reembolso: se hace a mano en el panel de Stripe; lo que sí queda anotado es `REFUND_PENDING_RECORDED`), `ADMIN_CREDENTIALS_CHANGED`, `ADMIN_ROLE_CHANGED`, `ADMIN_CREATED`, `ADMIN_DISABLED` (no existe ningún flujo: los admins salen del seed; A104). El test estático falla si se añade una acción `emittedBy: '20.5'` sin emisor ni justificación, o si un servicio del catálogo deja de emitir.

**Bug encontrado y corregido en el guard (20.1):** `toAuditPayload` no reconocía los `Decimal` reales de Prisma (su clase se llama `Decimal2` en el bundle, el guard comparaba `constructor.name === 'Decimal'`): cualquier monto sin convertir habría lanzado `AuditPayloadError` en producción y tumbado una venta. Ahora usa la etiqueta de decimal.js (`[object Decimal]`) y hay un test con un `Prisma.Decimal` real.

### 17.3 Login admin: fail-closed, best-effort y límites (R4)

- **`LOGIN_ADMIN_OK` fail-closed.** BetterAuth crea la sesión con su propia conexión (no puede compartir nuestra transacción): se crea la sesión, se escribe el evento en su propia transacción corta y, si falla, **se borra la sesión** y se responde `503 AUDIT_UNAVAILABLE` (nunca un token sin rastro).
- **`LOGOUT_ADMIN`: el logout SIEMPRE revoca la sesión.** Va en la misma transacción que el `DELETE` de la sesión, pero si la auditoría falla (cualquier causa) la sesión se revoca igual (`DELETE` simple), se registra con `logger.error` y se responde 204. Antes respondía 503 sin revocar y la sesión seguía viva hasta 8 h: cerrar sesión reduce la exposición, nunca debe depender de la auditoría. Solo emite quien borró la fila.
- **`LOGIN_ADMIN_FAILED` best-effort y fuera del camino de la respuesta.** Se programa tras el veredicto y **no se espera** (el 401 nunca espera el lock de la cadena y su tiempo no distingue usuario conocido de desconocido); un error solo se loguea. Lleva `emailHash` (HMAC salado, A103), `reason` (`UNKNOWN_USER`/`BAD_PASSWORD`) y nunca lo tecleado. La IP del evento es la **real del cliente** (9.4).
- **Frenos** (`AdminLoginLimiter`, en memoria, una instancia por entorno): (1) por IP, 20 fallos / 15 min; (2) por (IP, usuario), 5 fallos / 15 min (el par, no el usuario solo: nadie puede bloquear al admin real desde otra IP; **probado con la cadena Nginx -> Next -> Nest**, 9.4); ambos devuelven `429 ADMIN_LOGIN_RATE_LIMITED` **antes de hashear** y no escriben evento; (3) un presupuesto de la instancia de `LOGIN_ADMIN_FAILED` en la cadena (20/min, 4 escrituras en vuelo): pasado, el evento se descarta (ver el resumen), el 401 no cambia. Más el techo genérico de 60 intentos / 10 min por IP sobre la ruta. **Un solo contrato para todos los 429 de la ruta**: cuerpo `{statusCode, errorCode: ADMIN_LOGIN_RATE_LIMITED, message, details: {retryAfterSeconds}}` y cabecera `Retry-After` (el techo de 60/10 min añade `details.scope: IP_RATE`; antes devolvía el `ThrottlerException` pelado, sin `errorCode` ni cabecera). Variables en `.env.example`.
- **`LOGIN_ADMIN_FAILED_SUMMARY`: lo que el presupuesto descarta no se pierde.** Cada fallo que el presupuesto (o un error de escritura) deja sin evento se **cuenta** (`AdminLoginFailureSummary`) y, **una vez por ventana de 60 s como máximo** (la ventana se abre con el primer descarte), se escribe **un** evento `LOGIN_ADMIN_FAILED_SUMMARY` (actor `SYSTEM`) con: `dropped` (descartados), `windowStart`/`windowEnd`/`windowSeconds`, `distinctIdentifiers`, `distinctIps` (solo el número), `identifierHashes` (hasta 20 `emailHash`) e `identifiersTruncated`. Nunca lo tecleado ni una IP. Es durable (transacción de auditoría normal) y el admin lo ve en `GET /admin/audit/events?action=LOGIN_ADMIN_FAILED_SUMMARY`. Al cerrar la app (`SIGTERM`; `main.ts` activa los *shutdown hooks*) vuelca lo pendiente (acotado a 4 s, antes de cerrar la conexión a la BD); si la escritura falla, los contadores se reponen y se reintenta en la siguiente ventana; si el proceso muere antes (un crash), esos contadores se pierden (queda la línea de log por fallo). Probado: 40 fallos desde 40 IPs con presupuesto 6 dejan 6 `LOGIN_ADMIN_FAILED` y **un** resumen con los 34 descartados (`test/admin-login-summary.e2e-spec.ts`), el temporizador de ventana, y el volcado al cerrar. Variable `AUDIT_LOGIN_SUMMARY_WINDOW_MS` (60000).
- **¿Fuera de la cadena?** Se revisó: se dejan en la cadena (el FR-139 y A104 los incluyen y un registro de ataques que se puede podar no es auditoría), pero acotados: el peor caso sostenido son 20 filas/min de `LOGIN_ADMIN_FAILED` más 1 resumen/min (28 800 + 1 440 filas/día) frente a lo que antes era ilimitado.

### 17.4 Lo medido (disposable en tu Postgres de desarrollo clonado, `pnpm test:perf`, `test/audit-emission.perf.spec.ts`; "antes" = el mismo código con un `AuditService` que abre la misma transacción y no emite)

| Ruta | antes p50 / p95 | después p50 / p95 | Δ p50 |
|---|---|---|---|
| checkout Pago Móvil + 3 consentimientos (1 evento), secuencial | 10,2 / 15,0 ms | 11,0 / 15,0 ms | +0,7 ms |
| checkout igual, 8 concurrentes | 34,0 / 46,0 ms | 39,5 / 63,5 ms | +5,5 ms |
| confirmar Pago Móvil | 8,9 / 10,8 ms | 10,2 / 17,2 ms | +1,2 ms |
| webhook Stripe pagado | 6,4 / 8,5 ms | 8,6 / 12,0 ms | +2,2 ms |
| `PUT /admin/fx/settings` | 8,0 / 10,0 ms | 9,3 / 11,0 ms | +1,3 ms |
| `PUT /admin/vitrina/algorithm` | 8,6 / 11,2 ms | 10,3 / 12,9 ms | +1,8 ms |

Sin documentos de consentimiento publicados el checkout no emite nada (medido: −0,6 ms secuencial, −4,4 ms con 8 concurrentes, ruido). **Stripe a 300 ms con 8 checkouts/s durante 6 s (48 checkouts): p50 312 ms, p95 314 ms** (los 300 ms de Stripe más la base; con la llamada tras `record` el 20.1 midió p50 7,5 s). Publicar un documento legal no se midió aparte (lo domina el validador de Markdown; el evento añade un `INSERT` bajo el lock).

### 17.5 Lo que NO está verificado ni hecho

- La cadena completa no se ha probado contra el Postgres de producción ni con volumen real; las cifras son de la máquina de desarrollo, un solo proceso.
- La recomputación de la vitrina no emite eventos (no es un ajuste de un admin); el refresco del proveedor FX solo cuando cambia la tasa (17.2).
- El límite del login es por instancia (en memoria): con varias instancias detrás de un balanceador cada una cuenta aparte. Hoy hay una por entorno (A101).
- `ADMIN_*` y `REFUND_ISSUED` esperan a que existan sus flujos (17.2).
- Nginx no está instalado en esta máquina: la cadena Nginx -> Next -> Nest se probó con servidores HTTP de Node que hacen lo que dicen las plantillas (9.4), no con un Nginx real; la IP que el Nginx real ve (`$remote_addr`) depende de la red del VPS (un balanceador o un CDN delante exige `TRUSTED_PROXY_HOPS` en Next y, si no están en loopback, `TRUST_PROXY` en el backend).
- El `CUSTOMER_PASSWORD_RESET` no puede ser fail-closed (BetterAuth usa su propia conexión): si la auditoría cae en ese instante la contraseña cambia sin evento (queda un `logger.error`). **Aceptado** (17.8).
- Docker/Dokploy (Traefik -> Next -> Nest): probado con un Traefik v3.1 real y contenedores construidos con los `Dockerfile` (17.8, «Prueba de la cadena de Dokploy»); **no** contra un Dokploy real.

### 17.6 Criterio de qué acción es de riesgo (y por tanto lleva evento)

Una acción de admin o de sistema se audita si cumple **al menos uno**:

- **R1** mueve dinero o un estado de pago, o deja anotado que hay que devolver dinero (pagos, `refund_pending_*`);
- **R2** cambia lo que el comprador paga o puede comprar: precio, stock, existencia o visibilidad de un producto (alta, borrado, `isActive`), opciones de envío, tasa FX y su fuente, ranking de la vitrina, una importación masiva que reescribe precios;
- **R3** concede, revoca o acredita acceso o identidad: sesiones de admin, el reset de contraseña de un cliente, un admin dando por bueno un correo (`verify-email`);
- **R4** revela o destruye datos personales (revelar cédula, anonimizar, purga de retención);
- **R5** cambia el texto legal, la identidad del vendedor o la evidencia de consentimiento.

**No se audita aquí (revisado a propósito):** los bloques de la landing y sus imágenes (borrador/publicación propios, texto de presentación, no cambian lo que se puede comprar), la configuración del simulador de sobres (no hay dinero ni datos personales), las categorías y etiquetas (navegación; el borrado está restringido por FK y no cambia lo que se puede comprar), las imágenes de producto (visual), el carrito y la lista de deseos, y el perfil y el cambio de contraseña **con la contraseña actual** del propio cliente. El log de uso de 7 días de la 20.7 cubrirá el resto. Una acción nueva que cumpla R1-R5 debe añadirse a `AUDIT_ACTIONS` con emisor y muestra de payload, o falla `test/audit-coverage.spec.ts` (el criterio está también escrito en `src/audit/audit-actions.ts`).

**Un payload que no se puede serializar no tumba una venta (producción).** `AuditPayloadError` (y el tope de tamaño) en modo `lenient` (producción) se escribe como `{payloadError: "UNSERIALIZABLE"}` y se loguea como error: el evento existe y la acción sigue; en modo estricto (desarrollo, tests) se lanza, para que falle el test del sitio que lo emite. Los `AuditEventError` estructurales (acción o actor desconocidos, uuid mal formado) siguen siendo un 500 a propósito: son errores de código que los tests atrapan. Además, un `string` de más de 8 000 caracteres en un payload es una violación (se corta antes de escanear): los detectores de valores son cuadráticos sobre un token largo sin espacios (50 000 caracteres = 1,1 s, 150 000 = 11 s de bucle de eventos bloqueado); era la causa del timeout de 5 s de `test/audit-roundtrip.e2e-spec.ts`.

### 17.7 Verificación de la ronda de QA (cifras tal como salieron)

- Unitarias (`pnpm test`): 114 archivos, 2 124 pruebas. e2e (`pnpm test:e2e --no-file-parallelism`): 93 archivos, 1 285 pruebas, cadena de auditoría del clon verificada de génesis a cabeza. `pnpm test:perf`: 8 archivos, 46 pruebas.
- **Orden aleatorio, sin caché de vitest** (se borra `node_modules/.vite/vitest/.../results.json` antes de cada corrida): `--sequence.shuffle.files` con las semillas 20252 y 20253: 93/93 archivos y 1 285/1 285 pruebas las dos veces; también con el rol limitado (contenedor Postgres 17 desechable, `pnpm db:roles`, `DATABASE_URL` = rol de aplicación y `MIGRATE_DATABASE_URL` = propietario; semilla 20254): 93/93 y 1 285/1 285. La reproducción del QA (los seis archivos legales, caché borrada) pasa. **Los fallos con el rol limitado eran la misma causa** (la identidad del vendedor que dejaba `audit-emission`).
- `--sequence.shuffle` a secas (mezcla además los **tests dentro de cada archivo**, semilla 20251): 43 fallos en 11 archivos (`legal-consent`, `legal-admin`, `audit-admin-api`, `id-doc-reveal`, `iddoc-masking`, `audit-emission`, `epic-18-regression`, `epic-19-regression`, `landing-vitrina-modes`, `vitrina-scoring`, `legal-seed`). Todos son dependencias **dentro del mismo archivo** (escenarios escritos en secuencia: un `describe` que siembra datos y tests que continúan el anterior), no entre archivos, y cada uno de esos archivos pasa en su orden. No se reescribieron: la suite aísla entre archivos (cada e2e deja su estado) pero no pretende que los tests de un mismo archivo sean independientes entre sí.
- Plazo de la plantilla de BD: con una sesión abierta sobre la plantilla el helper abortó a los 67 s (antes 272 s) con el mensaje de parar el servidor o usar `E2E_DB_SOURCE`; con la plantilla `collectorsclub_e2e_template` tranquila (creada con el `CREATE DATABASE ... TEMPLATE` de 17.1) la corrida clona, pasa y borra su clon.


### 17.8 Docker / Dokploy: la IP real del cliente con Traefik -> Next -> Nest (hallazgo bloqueante de QA)

**El fallo.** Los dos repos traen un `Dockerfile` «for Dokploy» (commit `352f141`) que sustituye el flujo systemd/Nginx. Con Next y Nest en **contenedores distintos**, el par que Nest ve es el contenedor de Next, que no es loopback. `trust proxy` vale por omisión `loopback` (9.4), así que Nest **ignora** `X-Forwarded-For` y `req.ip` es la misma para todo el mundo. No hay ningún error: reproducido con un Next de producción cuyo `BACKEND_API_URL` apunta a una IP no loopback y el Nest real: un anónimo con 5 fallos bloquea al admin real (que entra desde otra IP) con 429, y los eventos de auditoría llevan la IP del contenedor. Con `TRUST_PROXY` apuntando a la red de contenedores funciona. **Angel aún no ha confirmado el destino de despliegue**: ambas topologías quedan funcionando y documentadas.

**Configuración por topología** (`HOST` y `TRUST_PROXY` en el backend, `TRUSTED_PROXY_HOPS` en Next):

| Topología | Backend `TRUST_PROXY` | Backend `HOST` | Next `TRUSTED_PROXY_HOPS` |
|---|---|---|---|
| **A. VPS con systemd + Nginx** (9.4, 11.3), todo en loopback | sin definir (`loopback`) | `127.0.0.1` | `1` (Nginx) |
| **B. Dokploy: Traefik -> Next -> Nest**, contenedores | **la subred estrecha de la red `cc-app`, que comparten solo Next y Nest** (abajo; `172.30.212.0/28`) | sin definir (el contenedor debe escuchar en todas las interfaces) | `1` (Traefik) |
| **C. CDN -> Nginx o Traefik -> ...** | igual que A o B | igual | `2`, **solo si** el proxy de entrada confía en el CDN y lo añade (abajo) |

**Backend (`TRUST_PROXY`, `HOST`).** `TRUST_PROXY` acepta `loopback`, un número de saltos, una lista de CIDR (`loopback,172.30.212.0/28`) o `false` (9.4). `HOST` (nuevo, opcional) es la interfaz en la que escucha: sin definir, todas (necesario en un contenedor); `127.0.0.1` en el VPS con Nginx. En el `.env.example` están los dos.

**Dokploy (topología B), paso a paso.**

1. **Una red propia y diminuta solo para Next y Nest (`cc-app`, subred fijada), y el backend TAMBIÉN en `dokploy-network` únicamente para que Traefik llegue al webhook de Stripe.** Cada servicio tiene un alias **único por red**: Next llama al backend por `cc-backend`, un nombre que **solo existe en `cc-app`**, así que el par que Nest ve es siempre una dirección de `172.30.212.0/28` (la que `TRUST_PROXY` cree) y nunca una de `dokploy-network`. Compose completo (copiable; los `${...}` son marcadores que se rellenan en la pestaña *Environment* de Dokploy, no hay ningún secreto en el archivo):

   ```yaml
   # docker-compose de Dokploy (tipo Docker Compose). Validado con `docker compose config` y ejecutado: ver «Prueba».
   name: cc

   networks:
     cc-app:                          # solo Next y Nest
       ipam:
         config:
           - subnet: 172.30.212.0/28  # 14 direcciones: Next, Nest y la pasarela
     dokploy-network:                 # la red de Traefik (la crea Dokploy)
       external: true

   services:
     backend:
       image: ${BACKEND_IMAGE:?}      # o `build:` con el Dockerfile del repo del backend
       restart: unless-stopped
       # sin `ports:`
       networks:
         cc-app:
           aliases: [cc-backend]      # el nombre que usa Next: SOLO existe en cc-app
         dokploy-network:
           aliases: [cc-api]          # el nombre por el que Traefik llega al webhook (dominio api.<DOMAIN>)
       environment:
         TRUST_PROXY: 172.30.212.0/28 # solo cc-app: Traefik NO está aquí, no se le cree (ver 2)
         DATABASE_URL: ${DATABASE_URL:?}
         COOKIE_SECRET: ${COOKIE_SECRET:?}
         ADMIN_AUTH_SECRET: ${ADMIN_AUTH_SECRET:?}
         CUSTOMER_AUTH_SECRET: ${CUSTOMER_AUTH_SECRET:?}
         STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET:?}
         IDDOC_ENC_KEYS: ${IDDOC_ENC_KEYS:?}
         IDDOC_ENC_ACTIVE_KEY: ${IDDOC_ENC_ACTIVE_KEY:?}
         IDDOC_BLIND_KEY: ${IDDOC_BLIND_KEY:?}
         SMTP_HOST: ${SMTP_HOST:?}
         SMTP_PORT: ${SMTP_PORT:?}
         SMTP_FROM: ${SMTP_FROM:?}
         ADMIN_CONTACT_EMAIL: ${ADMIN_CONTACT_EMAIL:?}

     frontend:
       image: ${FRONTEND_IMAGE:?}     # construida con los build args de abajo
       restart: unless-stopped
       networks:
         cc-app: {}
         dokploy-network:
           aliases: [cc-web]          # Traefik llega a Next por dokploy-network
       environment:
         BACKEND_URL: http://cc-backend:3000
         BACKEND_API_URL: http://cc-backend:3000/api/v1
         TRUSTED_PROXY_HOPS: '1'      # Traefik delante de Next
         NEXT_PUBLIC_BASE_URL: ${NEXT_PUBLIC_BASE_URL:?}
   ```

   - **Variables (*Environment* de Dokploy; sustituye cada marcador, nunca los guardes en el repo):** `BACKEND_IMAGE`, `FRONTEND_IMAGE`; `DATABASE_URL` (`postgresql://<usuario>:<contraseña>@<host-de-la-base>:5432/<base>?schema=public`; la base de Dokploy es alcanzable desde el backend por `dokploy-network`); `COOKIE_SECRET`, `ADMIN_AUTH_SECRET`, `CUSTOMER_AUTH_SECRET` (tres secretos **distintos**, `openssl rand -hex 24` cada uno); `STRIPE_WEBHOOK_SECRET` (`whsec_...` del panel de Stripe, sección 7.2); `IDDOC_ENC_KEYS` (`1:<openssl rand -base64 32>`), `IDDOC_ENC_ACTIVE_KEY` (`1`), `IDDOC_BLIND_KEY` (`openssl rand -base64 32`): **pierdes `IDDOC_ENC_KEYS` y las cédulas son irrecuperables** (14.2); `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `ADMIN_CONTACT_EMAIL` (OQ9, sección «Email»); `NEXT_PUBLIC_BASE_URL` (`https://<DOMAIN>`). El resto de variables del backend (`.env.example`) tiene valor por omisión; sin las de arriba el proceso se detiene con `Configuration key ... does not exist`. Con el administrador inicial (`ADMIN_SEED_*`) se ejecuta una vez `pnpm prisma:seed` dentro del contenedor.
   - **Build args del frontend** (quedan en las reescrituras de Next; los mismos valores van en `environment` arriba): `BACKEND_URL=http://cc-backend:3000`, `BACKEND_API_URL=http://cc-backend:3000/api/v1`, `NEXT_PUBLIC_BASE_URL=https://<DOMAIN>`.
   - **Dominios (pestaña *Domains*; Dokploy escribe los routers/labels de Traefik):** `<DOMAIN>` -> servicio `frontend`, puerto 3000; `api.<DOMAIN>` -> servicio `backend`, puerto 3000, **ruta `/api/v1/payments/stripe/webhook`** (el campo *Path* de Dokploy es un `PathPrefix`). Con la ruta fijada, el dominio de la API **no expone nada más** del backend (cualquier otra ruta es un 404 de Traefik): nadie puede atacar el login del admin por ese dominio. Sin dominio de API (Stripe no se usa), quita `dokploy-network` del backend y su alias.
   - (Es un ejemplo: no hay un `docker-compose` de despliegue en los repos; solo el `docker-compose.yml` de Postgres de desarrollo. Un servicio en modo Swarm/stack usa redes `overlay`: la subred se lee con `docker network inspect <red> --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'` y es esa la que va en `TRUST_PROXY`.)
2. **`TRUST_PROXY` confía solo en el segmento de `cc-app`, y por eso el backend no usa la subred de `dokploy-network`.** El backend cree el `X-Forwarded-For` de cualquier par que esté en el rango. **Riesgo de un rango privado ancho** (`172.16.0.0/12`, `10.0.0.0/8`, `192.168.0.0/16`, la subred de `dokploy-network`): cualquier otro contenedor de esa red que alcance el puerto del backend puede **falsificar la IP** que Nest ve (esquivar un límite o dirigir uno contra el admin real). `src/common/trust-proxy.spec.ts` lo demuestra. Con el compose de arriba el backend **sí** está en `dokploy-network`, pero esa red **no es de confianza**: lo que llega por ella se atiende como cualquier petición y su `X-Forwarded-For` se ignora (probado con un contenedor vecino y con Traefik, ver «Prueba»). **Lo que no puede pasar es que Next llame al backend por `dokploy-network`:** el par sería una dirección fuera de `TRUST_PROXY`, todos los clientes compartirían la IP de Next (un anónimo con 5 fallos bloquearía al admin con un 429) y los eventos llevarían la IP de Next. De ahí el alias `cc-backend`, que solo existe en `cc-app`: **nunca apuntes `BACKEND_API_URL`/`BACKEND_URL` a `backend` ni a un nombre que resuelva en `dokploy-network`** (el nombre de servicio `backend` es un alias en *todas* las redes del servicio; `getent hosts cc-backend backend cc-api` desde el contenedor de Next debe dar `172.30.212.x` para los dos primeros y `172.30.213.x` solo para `cc-api`). Alternativa descartada: una red compartida y `TRUST_PROXY` con las dos subredes; es la misma red ancha con más contenedores dentro.
3. **Qué ve el backend del tráfico de Traefik (el webhook de Stripe).** Traefik no está en `TRUST_PROXY`: el par es la dirección de Traefik en `dokploy-network` y su `X-Forwarded-For` (que Traefik reescribe con la IP de quien le llama; lo que Stripe, o un atacante, escriba en esa cabecera no llega) se **ignora**. Consecuencias, todas aceptadas: la firma sigue siendo lo que autentica el webhook (`Stripe-Signature` sobre el cuerpo en bruto: 200 con la firma buena, 400 `STRIPE_SIGNATURE_INVALID` con una mala o sin ella), el webhook no tiene límite por IP, y los eventos de auditoría que escriba llevan la dirección de Traefik (`::ffff:172.30.213.x` en la prueba) en vez de la de Stripe. Si quisieras la IP de Stripe en esos eventos, añadirías la IP **fija** de Traefik (`TRUST_PROXY=172.30.212.0/28,<ip-de-traefik>/32`); no se recomienda (la IP de Traefik cambia si se recrea) y **nunca** la subred de `dokploy-network`. El aviso de ejecución (abajo) no cuenta el webhook.
4. **Next con Traefik.** Next cuenta el `X-Forwarded-For` desde la derecha: con Traefik delante, `TRUSTED_PROXY_HOPS=1` (Traefik, por omisión, **descarta** el `X-Forwarded-For` que llega de un cliente no confiable y pone la IP del par que él ve; medido con **Traefik v3.1 real** en «Prueba»: un `X-Forwarded-For` falso de un cliente llega a Next ya reescrito con la IP del cliente).

**`TRUSTED_PROXY_HOPS` mal configurado falla en silencio.** Valor por topología: Nginx o Traefik directamente delante de Next = `1`; un CDN delante de Nginx/Traefik = `2` **solo si** ese proxy confía en el CDN y le añade su IP. Qué pasa si no cuadra:

- **Demasiado pequeño** (`1` con un CDN que el proxy sí añade): Next toma la dirección del borde del CDN. Muchos clientes comparten pocas IP: un solo cubo de límites y la IP del CDN en los eventos. Sin error.
- **El proxy no confía en el CDN** (Traefik descarta la cabecera que trae el CDN y deja solo la IP del borde): la entrada es la del CDN con `1`; con `2` solo hay una entrada, Next no reenvía nada (`at < 0`) y el backend ve el contenedor de Next. El número no lo arregla: hay que configurar el **proxy** (en Traefik, `entryPoints.<n>.forwardedHeaders.trustedIPs` con los rangos publicados del CDN).
- **Demasiado grande** (`2` sin CDN): Next toma una entrada **escrita por el cliente**; es el caso peligroso, porque el cliente elige su IP. Nunca subas el valor «por si acaso».
- **Cómo comprobarlo**: lista de verificación de 9.4, punto 4, y un `curl -H 'X-Forwarded-For: 1.2.3.4' https://<DOMAIN>/api/...` desde fuera: la IP del evento no puede ser `1.2.3.4`, ni la de Traefik, ni la del CDN.

**Next no debe exponerse sin el proxy delante.** El `Dockerfile` del frontend fija `HOSTNAME=0.0.0.0` (necesario para que el proxy lo alcance en la red de contenedores). Con `TRUSTED_PROXY_HOPS=1`, quien llegue **directo** a Next (puerto publicado por error, red compartida con un contenedor hostil) escribe el último `X-Forwarded-For`, y por tanto **elige la IP** que Next reenvía al backend, que `TRUST_PROXY` cree. Reglas: ni `ports:` en el servicio de Next ni un puerto abierto en el cortafuegos del host; solo Traefik lo alcanza. **Defensa propuesta, no implementada** (es invasiva: toca el proxy, Next y el despliegue a la vez): una cabecera secreta compartida. Traefik la añade con un middleware (`headers.customRequestHeaders.X-Edge-Secret`), Next (`lib/utils/client-ip.ts`) solo reenvía una IP si la cabecera coincide (comparación en tiempo constante, secreto en las variables de Dokploy) y, si no coincide, no reenvía nada (el backend verá la IP de Next: degrada, no se deja engañar). Alternativa: lista de pares permitidos en el propio Next, que desde una ruta de Route Handler no se ve (`request` no expone el socket), así que haría falta un servidor propio delante. Con el secreto, el CDN/Traefik debe poder fijar la cabecera; hay que valorarlo cuando Angel confirme el destino.

**Avisos que da el backend (sin PII).**

- Al arrancar, en `NODE_ENV=production`, un `WARN` si `TRUST_PROXY` no está definida y `HOST` no es loopback (`proxyStartupWarning`, `src/common/proxy-diagnostics.ts`).
- En ejecución, en producción, un `WARN` si **50 de las últimas 100 peticiones** que esperan la IP real llegan con un `req.ip` privado (RFC 1918, CGNAT, ULA, link-local) o con un `X-Forwarded-For` ignorado (el par no loopback es el propio `req.ip`). Es una **ventana, no una racha** (ronda 3: un health check o una petición buena entre las malas reiniciaba la racha y ocultaba el problema). **No cuentan** las rutas que no llevan la IP del cliente: `/fx/current` y `/legal/current-versions` (Next las llama sin reenviarla; 60 lecturas públicas disparaban «TRUST_PROXY is set but does not cover the proxy» con una configuración correcta), los health checks (`/health`, `/healthz`, `/livez`, `/readyz`, `/ping`), el webhook de Stripe (llama Stripe, no un visitante) y `/uploads/`. Como mucho **uno cada 10 minutos**; no incluye ninguna dirección, solo el tipo y el número de peticiones. Un par loopback con `X-Forwarded-For` (el operador) no cuenta. Falso positivo posible: una intranet donde los clientes reales tienen IP privada (el aviso solo orienta; no cambia nada).
- **`TRUST_PROXY` se valida al arrancar (ronda 3).** Un valor inválido ya no cae con `TypeError: invalid IP address`: el mensaje empieza por `TRUST_PROXY: "<valor>" is not valid...` y el proceso termina con código 1. Un rango que cubre direcciones **públicas** se mide: bajo 2^24 direcciones públicas (un `/8`; un CDN publica `/20` y `/13`) es un `WARN` en el arranque (`TRUST_PROXY includes public addresses (...)`); a partir de ahí es un **error** que impide arrancar (`0.0.0.0/0`, `::/0`, `8.0.0.0/8`, `2000::/3`, y también `0.0.0.0/1,128.0.0.0/1`, que juntos confían en todo Internet: cada cliente elegiría su IP). Las máscaras con formato de red (`10.0.0.0/255.0.0.0`) y los números de saltos no se miden.

**Prueba (`test/admin-login-proxy-chain-nonloopback.e2e-spec.ts`, par no loopback de verdad).** Es la prueba de cadena de 9.4 con el salto Next -> Nest por una **dirección no loopback** de la máquina (Nest escucha en `0.0.0.0` y Next lo llama por esa dirección, de modo que el par que Nest ve no es loopback). Una prueba **negativa** (`TRUST_PROXY` por omisión, el error de Dokploy): el atacante anónimo con 5 fallos deja al admin real con 429 y los 5 eventos llevan la dirección de Next. Una **positiva** (`TRUST_PROXY=loopback,<dirección>/32`): el atacante queda bloqueado, el admin real desde otra IP entra (200), los eventos llevan las IPs reales y una cabecera falsificada a la izquierda de lo que añade el proxy no se lee. Se omite (y se dice) si la máquina no tiene IPv4 no loopback. `src/common/trust-proxy.spec.ts` añade el mismo contraste con `172.30.212.0/28` y el caso del rango ancho. **Esa prueba es sin Traefik; la cadena con Traefik real está en el párrafo siguiente.**

**Prueba de la cadena de Dokploy con Traefik real (ronda 3 de QA, cifras tal como salieron).** Traefik **v3.1.7** (imagen oficial `traefik:v3.1`, configuración como la de Dokploy: sin `forwardedHeaders.trustedIPs`, así que descarta el `X-Forwarded-For` del cliente), el backend y el frontend **construidos con los `Dockerfile` de cada repo**, una base PostgreSQL 17 desechable, y el compose **exacto** de arriba (extraído de este archivo, `docker compose config` sin errores, luego `up`). Los clientes eran contenedores con una IP fija en `dokploy-network` (atacante `.6`, admin `.7`, «Stripe» `.8`, vecino `.9`); el router de la API solo exponía el webhook (`Host(api...) && PathPrefix(/api/v1/payments/stripe/webhook)`). Resultado:

| Comprobación | Resultado |
|---|---|
| Anónimo (`.6`, con `X-Forwarded-For: 1.2.3.4` falso) hace 5 logins fallidos del admin por Traefik -> Next -> Nest | 401 ×5, el 6.º **429** `ADMIN_LOGIN_RATE_LIMITED` |
| Admin real (`.7`) inmediatamente después | **200**: el anónimo no bloquea al admin |
| IP de los 5 `LOGIN_ADMIN_FAILED` y del `LOGIN_ADMIN_OK` en `Audit_Events` | `172.30.213.6` y `172.30.213.7`: **las reales**; ni `1.2.3.4`, ni la de Next, ni la de Traefik |
| Webhook firmado con el secreto real, por `api.<dominio>`, con `X-Forwarded-For` falso | **200** `{"received":true,"outcome":"unknown_order"}` |
| Webhook con firma mala / sin firma | **400** `STRIPE_SIGNATURE_INVALID` las dos |
| Otra ruta del backend por el dominio de la API (`/api/v1/admin/auth/login`) | **404** de Traefik |
| Control negativo: router que expone toda la API; 6 logins fallidos por ahí y el admin real por Next | 5 × 401 y 1 × 429 para el atacante; el admin real entra (**200**); los eventos del atacante llevan la dirección de Traefik (`::ffff:172.30.213.x`), no `1.2.3.4`: por eso la ruta fijada |
| Un contenedor vecino de `dokploy-network` llama al backend directo con `X-Forwarded-For: 1.2.3.4` | evento con `::ffff:172.30.213.9` (la suya): no se le cree |
| `getent hosts cc-backend backend cc-api` desde Next | `172.30.212.2`, `172.30.212.2`, `172.30.213.3` |
| 140 lecturas públicas sin reenvío de IP (`/api/fx/current`, `/api/legal/current-versions`) y 70 health checks, en producción | **0** avisos de `ClientIpMonitor` |
| Control: backend con `TRUST_PROXY` sin definir y 60 peticiones con `X-Forwarded-For` desde un par de `cc-app` | aviso de arranque y `ClientIpMonitor: 50 of the last 50 requests ... forwarded-for-ignored (TRUST_PROXY is not set)` |

Lo que **no** se probó: un Dokploy real (sus labels/routers los escribe la pestaña *Domains*; aquí los routers eran un archivo de Traefik equivalente), Swarm/overlay, un CDN delante, y que el panel de Dokploy conserve los alias de red del compose.

**Otras correcciones de esta ronda.**

- `DATA_IMPORT_RUN` con la auditoría caída: la corrida se cierra igual (es el candado de sincronización) pero ya no queda `SUCCEEDED` con `errorSummary: null`; `Tcg_Sync_Runs.errorSummary` lleva `AUDIT: DATA_IMPORT_RUN event NOT written (audit log unavailable); the import itself finished` (el `status` no cambia: la importación terminó).
- `LOGIN_ADMIN_FAILED_SUMMARY` guardaba en `ip` la de una petición cualquiera: el temporizador de la ventana se arma dentro de la petición que descarta el primer fallo y `AsyncLocalStorage` propaga su contexto al temporizador. Ahora el callback corre en `RequestContext.detached(...)` y el evento fija `ip` y `requestId` a `NULL` de forma explícita. Revisados los demás temporizadores de `src/`: los `setTimeout` restantes son esperas dentro del flujo de una petición (el contexto es el suyo a propósito), el del pool de Markdown solo mata un hilo y los `@Cron`/`@Interval` nacen al arrancar, sin contexto; ninguno más escribe un evento desde un temporizador sin contexto propio.
- **Topes de la guarda de payload** (`src/audit/audit-payload.ts`): una clave de más de **256** caracteres es una violación (estricto: lanza; producción: se corta), una cadena de más de **8 000**, igual; y un presupuesto de **coste de escaneo** por payload (la suma de los cuadrados de las rachas de 64+ caracteres sin espacios, tope 256e6) que sustituye la cadena por `[TRUNCATED]`. Los detectores eran cuadráticos (la expresión del correo: 8 000 caracteres 27-32 ms, 32 000 unos 0,5 s, 150 000 unos 11 s); **ahora son lineales** (ronda 3: el correo se busca a mano, `emailSpans`; el `SECRET` con un `lookahead` acotado a 256) y los topes quedan como segunda línea de defensa. Antes de ese arreglo: una clave de 150 000 dígitos 11,3 s; 500 cadenas de 8 000 dígitos 16,5 s.
- **`redactDeep` / `redactString`** (log de 20.2, corre en cada línea en el hilo principal). **Corrección de lo que decía esta sección y el commit `2a32879` ("se midió lineal"): no era lineal.** La búsqueda del nombre de campo (`idDoc`, `cedula`, `buyerId`, `recipientId`, `id_doc`) era **cúbica** con repeticiones del nombre, por debajo de los topes: `'idDoc'.repeat(n)`, 1 000 caracteres 98-239 ms, 4 000 caracteres 6,2-7,5 s, 8 000 caracteres 49 s (más de 20 s en otra máquina); `redactDeep({ err: 'idDoc'.repeat(600) })` bloqueaba 2,4-3,9 s. Reescrita en pasadas lineales (`redact.ts`): el nombre es una racha de caracteres de nombre que contiene la palabra clave (`NAME_RUN`), el valor entrecomillado o desnudo se lee con una expresión pegajosa, `Key (...)=(...)` se recorre a mano y el separador de `ci:` ya no parte los espacios de n maneras. Ahora `'idDoc'.repeat(n)` hasta 30 000 caracteres y `redactDeep({ err: 'idDoc'.repeat(600) })` cuestan menos de 1 ms; `test/guard-redact-bounds.perf.spec.ts` (`pnpm test:perf`) prueba 70 formas repetidas (`aaa…`, separadores, comillas, `Key (`, etiquetas, rachas de espacios, dígitos, puntos y `@`) sobre 60 000 caracteres y fija **150 ms** como techo (lo medido: 4-6 ms). Se conservan los topes: una cadena de más de 8 192 caracteres **con una racha de 64+ dígitos/puntos** se corta, un `redactDeep` gasta como mucho 32 768 caracteres en ese tipo de cadenas y las claves se cortan a 256.
- **Se redacta ANTES de cortar (ronda 3).** En modo indulgente (producción) la guarda cortaba la cadena a 8 000 caracteres, la clave a 256 y el `reason` a 2 000 **antes** de enmascarar, de modo que un token que caía en el corte dejaba su prefijo en claro **en una fila inmutable** (`V-123456` de una cédula cuya posición era la 7 992, `V-12345` y `V-1234` en una clave; un correo `maria@gmail`, un teléfono, un token). Y el redactor de logs hacía lo mismo con su corte de 8 192 / 256. Ahora (`src/common/redact-cut.ts`): se redacta una ventana **512 caracteres más larga** que el corte, se redacta también el texto cortado, y se conserva solo el prefijo común: un token que cruza el corte se reconoce entero en la ventana larga (se sustituye) y a medias en la corta (queda en claro), de modo que la salida se detiene justo antes. El coste es dos pasadas sobre `tope + 512` caracteres, nunca sobre la entrada completa. Pruebas de barrido: cédula (con punto, RIF), teléfono (`+58`, `04xx`), correo, token `sk_live_`, `Bearer`, cédula con etiqueta, en **cada posición** alrededor del corte, para el valor, la clave y el motivo (`src/audit/audit-payload-cut.spec.ts`, `src/common/redact-cut.spec.ts`); con el código anterior 27 de 57 posiciones dejaban un prefijo en el valor de la guarda, y 4 de 27 en el redactor de logs. Límite conocido: un token que **solo** se reconoce con más de 512 caracteres de contexto (la parte local de un correo de más de 512 caracteres) no está cubierto.
- **Falso positivo de la guarda con un UUID (ronda 3).** El detector de teléfonos venezolanos (`58 2dd ddd-dddd`) aceptaba el primer segmento de un UUID: `58228257-2520-466c-...` se enmascaraba como teléfono (aprox. 1 UUID de cada 300 000, medido; hacía fallar a veces el fuzz de `audit-catalog-payloads.spec.ts`). El patrón ya no acaba justo antes de `-<letra o dígito>`; los teléfonos reales (`04141234567`, `0414-123-4567`, `+58 414 123 4567`) siguen enmascarados.
- **`errorSummary` de `Tcg_Sync_Runs`, lista para la Story 20.9 (sin tocar el frontend).** `GET /api/v1/admin/tcg-master-cards/runs/:id` y la respuesta de `POST /admin/tcg-master-cards/ingest` ya devuelven `errorSummary: string | null` (junto a `status`, `startedAt`, `finishedAt`, `requestsUsed`, `quotaRemaining`, `summary`). Es `null` si la corrida terminó sin nota. Textos que puede traer: el error de la corrida (primeros 500 caracteres), `Marked FAILED: RUNNING for more than 2 hours`, y `AUDIT: DATA_IMPORT_RUN event NOT written (audit log unavailable); the import itself finished` (el `status` no cambia: la importación terminó, pero **no hay evento de auditoría**). La pantalla de 20.9 debe mostrar el campo tal cual (texto plano, sin interpretarlo) y destacar el prefijo `AUDIT:`: es el único rastro visible de que el evento falta. El frontend actual no lo muestra.
- **`CUSTOMER_PASSWORD_RESET` se pierde si la auditoría cae: aceptado.** BetterAuth cambia la contraseña con su propia conexión, no puede compartir nuestra transacción, y no se revierte un cambio de contraseña ya hecho por un fallo de auditoría (el cliente se quedaría sin acceso con un token ya gastado). Consecuencia: en esa ventana la contraseña cambia **sin evento** y queda solo un `logger.error`. Limitación documentada en 17.5.

## 18. Epic 20, Story 20.6: borrado (anonimización) de cuentas desde el admin, búsqueda de clientes y dominio reservado

Pedido de Angel: una opción de borrado de cuentas en el admin, con aviso de que **no es recomendable** y de que solo debe hacerse cuando el titular lo pide de forma explícita, **sin borrar los registros** de la cuenta que la ley obliga a conservar. «Eliminar cuenta» es una **anonimización**: la fila de `Customers` se conserva (los pedidos, los consentimientos y el historial siguen apuntando a ella) y lo que es solo de la persona se borra de verdad.

### 18.1 Qué cambia y cómo se despliega (migrar ANTES de reiniciar)

- Migración `20261108100000_customer_anonymization` (aditiva y atómica, `BEGIN`/`COMMIT` en el propio archivo, sin `lock_timeout` propio: lo acota `deploy.sh`): `Customers.anonymizedAt timestamptz(3)` y `Customers.anonymizedById uuid` (FK a `Admin_Users`, `ON DELETE SET NULL`), un `CHECK` (no hay admin sin fecha) y un trigger `customers_anonymized_at_is_final` (con `SET search_path = pg_catalog, public, pg_temp`) que impide **cambiar o borrar** `anonymizedAt` una vez puesto: la anonimización es irreversible también en la base de datos. Ninguna columna ni FK de `Orders` o `Consent_Records` cambia (comprobado con el hash de las dos tablas antes y después).
- **El sondeo de existencia de la columna de la 20.4 se retiró.** Era un parche para que el `FOR SHARE` del checkout no fallara antes de que existiera la columna (caché «ausente» 10 s, «presente» de por vida, con una ventana en la que un proceso podía vender sin el bloqueo). Como la columna llega con esta misma versión ya no hay nada que sondear y **no hay ventana**: con sesión, la primera sentencia de la transacción del checkout es siempre `SELECT "anonymizedAt" FROM "Customers" WHERE id = $1 FOR SHARE`. A cambio hay un **orden de despliegue**: `deploy/deploy.sh` ya hace `prisma migrate deploy` y **luego** reinicia. Si alguien arranca este build contra una base sin migrar, el checkout **con sesión** falla (la sentencia da error: falla cerrado, nunca abierto; el invitado no se ve afectado) hasta aplicar la migración. El error `CHECKOUT_UNAVAILABLE` (503) ya no existe. Con varias instancias: migra, reinicia todas; no queda nada que habilitar después.
- **Segunda migración, `20261109100000_customer_anonymized_pii_is_final`** (ronda 2 de QA; `BEGIN`/`COMMIT`, solo metadatos: reemplaza el cuerpo de la función y la definición del trigger, no lee ni reescribe filas, `SET search_path = pg_catalog, public, pg_temp`): el trigger `customers_anonymized_at_is_final` ahora impide también **cambiar** `email`, `name`, `phone`, `image` y `emailVerified` de una fila ya anonimizada (con el rol de la aplicación, por SQL directo o por un bug: `ERRCODE 23514`). Escribir el mismo valor sí se permite (`IS DISTINCT FROM`); `updatedAt` y `anonymizedById` no se protegen a propósito (BetterAuth puede tocar `updatedAt`, y el `ON DELETE SET NULL` de `anonymizedById` es un `UPDATE` de la fila; ambos probados). La propia anonimización no se ve afectada: corre mientras `anonymizedAt` aún es NULL. Se aplica con `deploy.sh` como cualquier otra, **antes de reiniciar**.
- **Qué pasa con un build nuevo contra una base SIN migrar (comprobado con `node dist/main` contra una copia a la que se le quitaron las columnas, con una sesión creada antes):** `GET /auth/me` y cualquier ruta con cookie dan **401** aunque la sesión sea válida (BetterAuth pide `anonymizedAt` junto con la sesión, la consulta falla y el guard lo trata como sesión inválida: falla cerrado); **`POST /auth/login` y `POST /auth/register` dan 500** (BetterAuth lee y escribe la fila del cliente con una columna que no existe); el **checkout de invitado sigue vendiendo** (201: no toma el `FOR SHARE`) y un checkout con la cookie de una sesión se trata como invitado (la sesión no se resuelve, así que ni siquiera llega al `FOR SHARE`: con carrito de cuenta daría `EMPTY_CART`). Es decir: la tienda solo vende a invitados y nadie puede entrar ni registrarse hasta migrar. Por eso el orden es **migrar y luego reiniciar**; si por error se arrancó antes, aplica `prisma migrate deploy` (no se verificó si hace falta reiniciar después: hazlo).
- Rollback del código sin quitar las columnas: el build anterior las ignora; mientras no se anonimice nada con el build nuevo no hay diferencia. Una cuenta ya anonimizada con el build antiguo en marcha seguiría sin poder iniciar sesión (no tiene credenciales), pero el checkout antiguo no la rechazaría (fail-open solo en ese caso): no vuelvas a un build anterior a la 20.4 tras anonimizar cuentas.

### 18.2 Tabla por tabla: qué se borra, qué se conserva y por qué (para los textos legales)

Inventario hecho con `grep` de `customerId`, `userId` y `email` en `prisma/schema.prisma` (más las tablas sin FK que guardan un identificador del cliente).

| Tabla | Qué pasa | Por qué |
|---|---|---|
| `Customers` | **Se conserva la fila**, con `email` → `deleted+<uuid>@anonymized.invalid`, `name` → «Cuenta eliminada», `phone`/`image` → NULL, `emailVerified` → false, `anonymizedAt` y `anonymizedById` | El `customerId` de los pedidos y de los consentimientos sigue válido (integridad fiscal y probatoria, A82). BetterAuth necesita la fila |
| `Customer_Accounts` (credenciales, hash Argon2id) | **Se borra** | Sin credencial no hay login |
| `Customer_Sessions` (token, IP, agente de usuario) | **Se borra** (todas) | Cierra la sesión de **todos los dispositivos** al instante; la IP y el agente residuales desaparecen con la fila. **Ojo:** no es la única copia de una IP de cliente: ver la fila de `Audit_Events` |
| `Customer_Verifications` (enlaces de verificación de correo y de recuperación de contraseña) | **Se borra** `WHERE identifier = <email viejo> OR value = <id>` | No tiene FK: por eso es explícito. Los tokens de reset de BetterAuth se guardan con el hash en `identifier` y el id en `value`: los cubre el segundo criterio |
| `Customer_Addresses` (libreta de direcciones: nombre, teléfono, dirección, cédula cifrada `Enc`/`Blind`) | **Se borra** | Es solo de la persona. **La copia que tiene cada pedido no se toca** (los pedidos no tienen FK a la libreta) |
| `Carts` + `Cart_Items`, `Wishlists` + `Wishlist_Items` (del cliente) | **Se borra** (los `…Item` caen por `CASCADE`) | Solo de la persona. Los carritos y listas **anónimos** por cookie no son del cliente y no se tocan |
| `Contact_Inquiries` (nombre, email, mensaje) | **Se CONSERVA** (no se borra al anonimizar) | Decisión de Angel en la ronda 2 de QA: no borrar registros. Un «RECLAMO formal: pedido X llegó dañado, exijo reembolso» escrito con el email de la cuenta es evidencia de una disputa y de una orden que se conserva; además el formulario no tiene vínculo verificado con la cuenta (cualquiera escribe un email), así que borrar «por coincidencia de email» era a la vez demasiado y demasiado poco. Lo cubre la **retención de 12 meses de la Story 20.8**. El detalle del cliente cuenta cuántos hay (`willKeep.contactInquiries`) y avisa con `CONTACT_MESSAGES_KEPT_UNTIL_RETENTION`. Si Angel decide otra cosa más tarde, se añade una sentencia a `CustomerAnonymizationService` |
| `Orders` (+ `Order_Lines`, `Order_Status_History`, `Order_Tracking_Events`) | **Intactas**: `recipientName`, teléfono, dirección, **cédula cifrada recuperable** (`recipientIdDocEnc`, `buyerIdDocEnc`, sus `Blind`), RIF y razón social del comprador | Obligación fiscal: la cédula es obligatoria en la factura (A86). Nunca se enmascara ni se purga |
| `Proof_Of_Payments` y **los archivos** de `uploads/private/proof-of-payment/` | **Intactos** | Soporte contable del pago. La anonimización **no toca el disco** (no hay efectos en archivos ni red dentro de la transacción) |
| Imágenes del cliente en disco | **No existen**: no hay ninguna subida de avatar (`Customers.image` es solo una URL que BetterAuth podría rellenar y se pone a NULL); `uploads/` solo tiene `private/proof-of-payment`, `public/landing` y `public/products` | — |
| `Consent_Records` | **Se conservan**, su FK no se toca | Prueba de qué aceptó y cuándo (append-only por triggers). No contiene email ni nombre: solo `customerId`, versión y contexto |
| `Stripe_Webhook_Events` | **Intacta** | Solo `eventId`, tipo, `orderId` y resultado; sin datos personales |
| `Audit_Events` | **Inmutable** | **No es cierto que no lleve PII (corregido en la ronda 2):** guarda **la IP** de quien origina la acción (columna `ip`, tomada de `req.ip`, ver 17.8) en todo evento emitido desde una petición. Los de **clientes y visitantes** son: `CONSENT_RECORDED` (registro: `actorType = CUSTOMER`, `actorId = customerId`, `ip` no nulo; re-aceptación `POST /me/consent`; y el checkout, también de invitado: `actorType = ANON`, `actorId` nulo), `CUSTOMER_PASSWORD_RESET` (la IP de quien usó el enlace) y, de la parte admin, `LOGIN_ADMIN_*` (la IP de un visitante que falla el login). La IP es un dato personal; el correo, el teléfono y la cédula **no** están (el guard los rechaza). **Plazo: para siempre**, por decisión de Angel («log pleno e inmutable», coherente con FR-122): la anonimización **no** la toca ni puede tocarla (triggers y `REVOKE`; no se hace `UPDATE` ni `DELETE`). `CUSTOMER_ANONYMIZED` guarda el id del admin, el `customerId`, la `reason` (sin email, teléfono ni cédula: el servidor la rechaza, y el guard del log la enmascara además) y `emailHash`, un HMAC con clave del email (`hashEmail`, `IDDOC_BLIND_KEY`): permite atender una disputa pero no recuperar el correo. **`[[CONFIRMAR_CON_ABOGADO_CONSERVACION_IP_EN_AUDITORIA_PARA_SIEMPRE]]`**: un abogado debe validar la base legal y el plazo de conservar indefinidamente la IP de los eventos del cliente (y, si no la acepta, la alternativa es truncarla o cifrarla al escribir el evento, un cambio de la 20.1/20.5, no de esta story). El texto de `privacidad.md` (§2, §7, §9) lo declara con la misma marca |
| `Usage_Logs` (Story 20.7: `actorId` + IP + agente de usuario de **cada petición**, 7 días) | **Se borra** `WHERE "actorType" = 'CUSTOMER' AND "actorId" = <id>` en la **misma transacción**, y otra vez tras el commit (barrido) con el búfer en memoria vaciado de esa cuenta; la escritura se niega a insertar filas de una cuenta ya anonimizada | La IP y el id son datos personales; el log de uso no es prueba legal (A95). La purga de 7 días recoge lo que un fallo del barrido dejara. `willDelete.usageLogs` cuenta las filas que hay; el evento lleva `usageLogsDeleted`. Detalle y pruebas: 19.5 |
| Logs del proceso (journald/stdout) | **No se pueden editar desde la app** | La app no escribe el email del cliente en los logs de negocio (excepto el log temporal `MANUAL_EMAIL_VERIFY` de la 13.1); rota los logs del sistema |
| Copias de seguridad de la base de datos | **Conservan los datos hasta que rotan** (A94) | Fuera de alcance de la app; dilo en la política de privacidad con el plazo real de rotación |
| Stripe, proveedor de correo, agencias de envío | **Fuera de nuestro control** | Tienen sus propias copias (pedidos pagados, correos enviados) |
| **Navegador del comprador** (`localStorage`: libreta de direcciones del frontend con la cédula del destinatario **sin cifrar**, productos guardados, miniaturas del carrito) | **El servidor no puede borrarlo** | Vive en el dispositivo de la persona. Se lo dice la API (`notices: BROWSER_LOCAL_STORAGE_NOT_ERASED`), la plantilla `privacidad.md` y el diálogo de la 20.9 debe decirlo: «pídele que borre los datos del sitio en su navegador» |

### 18.3 La sesión de otro dispositivo, el email libre y el dominio reservado

- **Sesiones:** se borran todas las filas de `Customer_Sessions` en la misma transacción: el siguiente `GET /auth/me` (o cualquier ruta con cookie) de cualquier dispositivo es `401 INVALID_CUSTOMER_TOKEN`. Probado con dos dispositivos. Además, `CustomerAuthGuard` rechaza una sesión cuya cuenta tenga `anonymizedAt` (BetterAuth lo devuelve con la sesión, sin una consulta más): cubre un login que leyó la credencial justo antes del commit y creó su sesión después. El propio login revoca lo que creó en ese caso y responde el 401 genérico; el reset de contraseña, igual (BetterAuth crea una credencial si no hay).
- **Email original libre:** `deleted+<uuid>@anonymized.invalid` es único e inválido; el email original queda libre y un registro nuevo crea **otra** cuenta sin relación: sin pedidos, lista, carrito, libreta ni consentimientos de la anterior (probado).
- **Dominio `anonymized.invalid` bloqueado** (también subdominios, mayúsculas, punto final, Unicode compatible): el registro es `400` (validación del DTO y regla repetida en el servicio, `EMAIL_DOMAIN_NOT_ALLOWED`); el login con ese dominio paga **un hash Argon2id** y da el mismo `401` genérico que un email desconocido; `forgot-password` y `resend-verification` no hacen nada (misma respuesta). Ninguna depende de que la cuenta exista: no hay oráculo.
- **Anti-enumeración medida** (`test/customer-anonymize.e2e-spec.ts`, 20 muestras intercaladas, medianas): login con el email anonimizado 41,7 ms frente a 42,4 ms de un email desconocido (con contraseña incorrecta de la cuenta viva, antes: 46,7 ms); `forgot-password` 1,5 ms frente a 1,4 ms (antes, con la cuenta viva: 3,8 ms: ese diferencial ya existía y **desaparece**: tras anonimizar es indistinguible de un email desconocido).

### 18.4 Contrato para la pantalla de la Story 20.9

Todas bajo `AdminAuthGuard` (`Authorization: Bearer <token del admin>`), `Cache-Control: no-store`.

- **`GET /admin/customers/:id`** — lo que el aviso necesita con **datos reales**:
  `{ id, email, name, phone, emailVerified, createdAt, updatedAt, anonymizedAt|null, anonymizedById|null, addresses[] (cédula SIEMPRE enmascarada, V-****5678), recentOrders[10] {id,status,paymentRail,totalUsd,createdAt}, anonymization }` con
  `anonymization = { canAnonymize, activeOrders: {count, items[≤20] {id,status,createdAt}}, willDelete: {addresses, sessions, credentials, verificationTokens, carts, wishlists, usageLogs}, willKeep: {orders, consentRecords, contactInquiries, ordersWithRefundPending}, notices[] }`. **Cambio de la ronda 2:** `contactInquiries` salió de `willDelete` y pasó a `willKeep` (los mensajes de contacto ya no se borran, 18.2); `ordersWithRefundPending` cuenta las órdenes de la cuenta (cualquier estado, también `PAYMENT_FAILED`) con un `refund_pending_*` de Stripe: el dinero se debe aunque la cuenta se anonimice.
  `canAnonymize` es false si ya está anonimizada o tiene órdenes activas. `activeOrders.count` es el número real (la lista se corta en 20). `willKeep.orders` es «cuántas órdenes conserva». `notices` son **códigos** para los textos fijos del modal, que se muestran **antes** de cualquier campo: `NOT_RECOMMENDED_ONLY_ON_EXPLICIT_REQUEST_OF_THE_OWNER`, `IRREVERSIBLE`, `ORDERS_AND_FISCAL_ID_KEPT`, `BROWSER_LOCAL_STORAGE_NOT_ERASED`, `BACKUPS_KEEP_DATA_UNTIL_ROTATION`, y dos **condicionales**: `REFUND_PENDING_ON_KEPT_ORDERS` (si `willKeep.ordersWithRefundPending > 0`: «hay un reembolso pendiente; anonimizar no lo cancela, hay que devolverlo a mano en Stripe») y `CONTACT_MESSAGES_KEPT_UNTIL_RETENTION` (si `willKeep.contactInquiries > 0`).
- **`POST /admin/customers/:id/anonymize` `{confirmEmail, reason}`** → `200 {customerId, anonymizedAt, alreadyAnonymized, notices[]}` (`notices` vacío si `alreadyAnonymized`: segunda llamada o doble clic, sin efecto ni evento). El botón se habilita al teclear el email exacto (el servidor lo revalida: sin distinguir mayúsculas ni espacios) y un `reason` de **10 a 500 caracteres** (quién lo pidió, canal, fecha o referencia; **sin datos personales**). Errores: `400 ANONYMIZE_CONFIRMATION_MISMATCH` (la respuesta **nunca** contiene el email real, ni cuánto se parece), `400 ANONYMIZE_REASON_REQUIRED` (`details {min,max}`), `400 REASON_CONTAINS_ID_DOC`, `400 REASON_CONTAINS_PERSONAL_DATA` (email, teléfono, secreto, o un número suelto de 7 o más dígitos: escribe las fechas como `2026-11-04`), `404 CUSTOMER_NOT_FOUND`, `409 ACCOUNT_HAS_ACTIVE_ORDERS` (`details {total, orders[≤20 {id,status,createdAt}]}`: no se cancela ni completa nada solo), `409 ANONYMIZE_BUSY` (otra operación sostiene la cuenta; nada cambió, reintentar), `503 AUDIT_UNAVAILABLE` (no se pudo escribir el evento: no se hizo nada).
- **`POST /admin/customers/search` `{q?, idDoc?, cursor?}`** → `{data[50] {id,email,name,emailVerified,createdAt,anonymizedAt|null,ordersCount,activeOrdersCount}, meta {limit:50, hasNextPage, nextCursor|null}}`, nuevos primero. `q`: parcial sobre email o nombre (2-100 caracteres); es **texto literal**, no un patrón (`%`, `_` y `\` se buscan tal cual: `%%` ya no devuelve a todos); un NUL es `400`. `idDoc`: **exacta** por índice ciego (órdenes como destinatario o comprador, y libreta); `400 ID_DOC_FILTER_INVALID` si no es una cédula completa (nunca se devuelve). `400 CURSOR_INVALID`. Sin coincidencias: `200` con página vacía. Una cuenta anonimizada se sigue encontrando por la cédula de sus órdenes conservadas.
- **`GET /admin/customers?cursor=`** — misma respuesta, sin filtros; **cualquier otro parámetro** es `400 QUERY_PARAM_NOT_ALLOWED` (un fragmento de email en una URL también acaba en los logs del proxy).
- Todas las rutas con una cédula en la URL: ver 18.5.

### 18.5 La cédula nunca va en una URL (huecos cerrados)

`assertNoIdDocInQuery` (`src/common/id-doc-not-in-url.ts`) detectaba solo claves que contenían `iddoc` o `cedula`. Ahora mira **claves y valores** de todo el query ya parseado (incluidos `a[]=`, `a[b]=` y claves repetidas), sin devolver ni consultar nada:
- **Claves** (por palabras: camelCase, `_`, `-`, `.`, espacios, corchetes, sin acentos): contiene `iddoc` (así también `id-doc`, `id.doc`, `id_document`, `buyerIdDoc`), `cedula`, `documento`, `identificacion`, `pasaporte`, `nationalid`, o una palabra entera `ci`, `rif`, `dni`, `passport`. `orderId`, `customerId`, `cursor`, `circuit`, `rifle`, `docs`, `document` pasan.
- **Valores** con la forma de una cédula: letra de tipo V/E/J/G/P y 6-9 dígitos (`V12345678`, `v-12.345.678`, `V 12 345 678`, RIF con dígito), `12.345.678` suelto, o un número tras `cedula`/`C.I.`/`RIF`/`DNI`/`pasaporte`. Un valor con `@` es un email y se ignora (`v12345678@gmail.com` es una búsqueda legítima); el primer segmento de un UUID, las fechas y los importes no coinciden; `cursor` (opaco) no se escanea. **No se marca** un número desnudo de 8 dígitos (podría ser un teléfono o un número de pedido): un valor sin letra ni palabra clave no es identificable como cédula.
- Se aplica a `GET /admin/orders`, **`POST /admin/orders/search`** (antes no miraba el query: `?idDoc=` en la URL de un POST pasaba), `GET /admin/customers`, `POST /admin/customers/search` y `GET /admin/customers/:id`.

### 18.6 Concurrencia (probada con bloqueos reales de PostgreSQL)

- La anonimización toma `SELECT … FROM "Customers" WHERE id = $1 FOR UPDATE` (acotado por `lock_timeout`/`statement_timeout` de la base, 10 s), y el checkout con sesión toma `… FOR SHARE` como primera sentencia. Conflictan: un checkout que ya tiene su `FOR SHARE` hace esperar a la anonimización, que después **ve la orden nueva** y responde 409; una anonimización en curso hace esperar al checkout, que después ve `anonymizedAt` y responde 401 sin crear nada. **Nunca queda una orden activa de una cuenta anonimizada.** Sin deadlock: el checkout toma el lock de `Customers` **antes** que cualquier otro y no espera nada que la anonimización tenga antes de eso; el lock de la cadena de auditoría se toma al final (regla AD-99). Tras el `FOR UPDATE`, cada espera de la transacción queda acotada por `lock_timeout = 5 s`; un tiempo agotado o un deadlock responde `409 ANONYMIZE_BUSY`, nunca 500. (Story 20.6a: el deadlock del checkout contra la fusión del carrito SÍ se provocó y se corrigió; ver 18.11. Lo que sigue sin provocarse es uno con la anonimización.)
- Dos anonimizaciones simultáneas de la misma cuenta: las dos 200, un solo `alreadyAnonymized: false`, **un solo** evento. Sin `upsert`.
- La prueba determinista retiene el bloqueo con una conexión aparte; **mutaciones comprobadas**: quitar el `FOR SHARE` del checkout rompe la prueba de «checkout esperando → 401»; quitar el `FOR UPDATE` de la anonimización rompe tres.

#### 18.6.1 Todas las escrituras de una cuenta toman el mismo punto de serialización (ronda 2 de QA, D1)

**Fallo encontrado.** Una petición ya autenticada (sesión leída antes del commit) que llegaba mientras la anonimización esperaba un bloqueo escribía **después** de ella: `PATCH /auth/me` devolvía `name` y `phone` reales a la fila anonimizada, y `POST /auth/addresses`, `POST /cart/items` o `POST /wishlist/items` dejaban `Customer_Addresses=1`, `Carts=1`, `Wishlists=1`. Reproducción determinista: una segunda conexión retiene un `FOR UPDATE` sobre una fila de `Customer_Addresses` de la cuenta; la anonimización toma el `FOR UPDATE` del cliente y se **bloquea** al borrar direcciones; se lanza la petición con la cookie; se suelta; anonimizar da 200 y la petición 200/201. Sin bloqueo, 5 operaciones aleatorias en paralelo con anonimizar dejaron datos en 8 de 30 rondas (QA).

**Arreglo.** `src/common/customer-write-lock.ts` (`lockLiveCustomer` / `tryLockLiveCustomer`): **primera sentencia** de toda transacción que escribe una tabla de la cuenta, `SELECT "anonymizedAt" FROM "Customers" WHERE id = $1 FOR SHARE` (o `FOR UPDATE` si esa transacción actualiza la fila del cliente o necesita serializar a sus iguales); si la cuenta no existe o está anonimizada, **401 `INVALID_CUSTOMER_TOKEN`** sin escribir nada. Es el mismo bloqueo del checkout (que ahora lo importa de ahí: `lockCustomerForCheckout` es un alias). Orden de bloqueos, sin deadlock: **fila de `Customers` primero**, luego lo demás (advisory de carrito, lista o verificación, filas de direcciones), y el bloqueo de la cadena de auditoría siempre al final (AD-99); la anonimización toma el mismo orden. Los carritos y listas de **invitado** (sin `customerId`) no llaman al helper y no se ven afectados (probado: se responden mientras la anonimización está bloqueada, y la fusión de una cuenta anonimizada no se lleva su carrito de invitado).

**Enumeración de las rutas que escriben tablas de la cuenta** (inventario con `grep` de delegados Prisma y SQL sobre `Customers`, `Customer_Addresses`, `Customer_Sessions`, `Customer_Accounts`, `Customer_Verifications`, `Carts`, `Cart_Items`, `Wishlists`, `Wishlist_Items`, `Consent_Records`):

| Ruta / operación | Tablas | Cómo quedó |
|---|---|---|
| `PATCH /auth/me` | `Customers` | transacción con `FOR UPDATE` primero; 401 si anonimizada. Además el trigger (18.1) impide el cambio aunque se olvidara |
| `POST/PATCH/PATCH set-default/DELETE /auth/addresses…` | `Customer_Addresses` | `runLocked` (ya tomaba `FOR UPDATE` de `Customers`) ahora lee `anonymizedAt` y da 401 |
| `POST/PATCH/DELETE /cart/items…` con sesión | `Carts`, `Cart_Items` | `FOR SHARE` primero, luego el advisory del carrito |
| `POST/DELETE /wishlist/items…` con sesión | `Wishlists`, `Wishlist_Items` | **una sola transacción** (antes crear la lista y añadir el ítem eran dos pasos sueltos) con `FOR SHARE` primero |
| Fusión del carrito y de la lista anónimos al hacer login (`AccountMergeService`) | `Carts`, `Cart_Items`, `Wishlists`, `Wishlist_Items` | `FOR SHARE` primero; una cuenta anonimizada no se lleva el carrito de invitado (el fallo se registra y la cookie queda) |
| `POST /me/consent` (re-aceptación) | `Consent_Records` | `FOR SHARE` primero (tras el `lock_timeout` de 3 s ya existente), 401 |
| Registro (`recordConsents` de la cuenta nueva) | `Consent_Records` | `FOR SHARE` primero en la misma transacción de auditoría |
| Token de verificación de correo (registro, `resend-verification`) | `Customer_Verifications` | `tryLockLiveCustomer` primero; una cuenta anonimizada no recibe token ni correo (en segundo plano, sin cambiar la respuesta) |
| `POST /auth/verify-email` | `Customers` | ya era atómica: `UPDATE … WHERE anonymizedAt IS NULL` (re-evalúa tras esperar el bloqueo de fila) |
| `POST /admin/customers/verify-email` | `Customers` | `FOR UPDATE` primero; una cuenta anonimizada (incluido su correo placeholder) es **404** sin efecto ni evento |
| Checkout con sesión | `Orders`, `Carts`, `Consent_Records` | sin cambios (20.4): `FOR SHARE` primero |
| `POST /auth/login` (la sesión la crea BetterAuth con su propia conexión) | `Customer_Sessions` | no puede compartir la transacción: tras el login se comprueba `anonymizedAt` y se borran sesión y credenciales (18.3); el guard rechaza además cualquier sesión de una cuenta anonimizada |
| `POST /auth/reset-password` (BetterAuth, conexión propia; puede **crear** la credencial) | `Customer_Accounts`, `Customer_Sessions`, `Customer_Verifications` | Story 20.6a: se ejecuta con `FOR KEY SHARE` sobre `Customers` retenido (18.11): una cuenta anonimizada responde **igual que un token inválido** (400 `INVALID_RESET_TOKEN`), sin contraseña, sin sesión y sin evento, y el token se borra |
| `POST /auth/forgot-password` (BetterAuth crea el token en segundo plano) | `Customer_Verifications` | Story 20.6a: el token se escribe con `FOR KEY SHARE` sobre `Customers` retenido; la anonimización o ya hizo commit (no se escribe ningún token) o espera a que el token exista y lo borra. **Ya no hay ventana** (antes sobrevivía un token escrito entre el `DELETE` de tokens y el commit) |
| Deslizamiento de la sesión (BetterAuth actualiza `expiresAt` de **su** fila de sesión, lo más parecido a un `lastSeen`; no existe una columna `lastSeen`) | `Customer_Sessions` | solo actualiza una fila que la anonimización ya borra; no puede crear datos |
| Logout | `Customer_Sessions` | borra su propia sesión; inocuo |

**Que no se pueda olvidar.** `src/common/customer-write-lock.static.spec.ts` escanea todo `src/` buscando escrituras (delegados Prisma y SQL `INSERT/UPDATE/DELETE`) sobre esas diez tablas y falla si un archivo nuevo las escribe sin estar registrado, o si un archivo registrado llama al helper menos veces de las fijadas (hoy: auth 3, direcciones 1, carrito 4, lista 3, consentimiento 1, admin-clientes 1, checkout 1; la anonimización es la excepción y se comprueba que contiene su `FOR UPDATE`). Un test unitario cubre el helper (`customer-write-lock.spec.ts`).

**Pruebas.** `test/customer-account-write-lock.e2e-spec.ts`: un test determinista por ruta (11 rutas, la reproducción de arriba: la anonimización bloqueada **comprobada en `pg_stat_activity`**, no con `sleep`; la petición también bloqueada; al soltar: anonimizar 200, la petición 401 y la cuenta sin nada de la persona), más fusión de carrito y lista, invitados no afectados, `resend-verification`, `verify-email` del admin y 10 rondas aleatorias (5 operaciones en paralelo con anonimizar). `test/customer-account-write-lock.perf.spec.ts` (en `pnpm test:perf`): 60 rondas aleatorias. **Mutación comprobada:** con `lockLiveCustomer` sin mirar `anonymizedAt`, 12 de los tests del e2e fallan (11 rutas más la fusión) (cada ruta con 200/201 y datos), y la ronda 0 de la prueba aleatoria ya falla.

#### 18.6.2 Qué más cambió en la ronda 2

- **`Contact_Inquiries` ya no se borra** (18.2): fuera de `willDelete`, en `willKeep.contactInquiries`; el evento `CUSTOMER_ANONYMIZED` ya no lleva `contactInquiriesDeleted`.
- **`reason`** (18.4): se aplica NFKC, todos los guiones Unicode (U+2010-2015, U+2212…) como `-`, se quitan los caracteres de formato (ancho cero) y los espacios se colapsan antes de revisar; así `V  12345678`, `CI 12345678`, `C.I. 12345678`, `Ｖ12345678`, `V‐ 12345678` y `V\u200B12345678` dan `REASON_CONTAINS_ID_DOC`, y un móvil sin 0 (`4121234567`, `412-123-4567`) o un número suelto de 7+ dígitos da `REASON_CONTAINS_PERSONAL_DATA` (mensaje y alcance exactos en 18.11) (se reutilizan `looksLikeIdDocInText` y `newIdDocInTextRegex`). Un NUL es `400 ANONYMIZE_REASON_REQUIRED`. Las fechas se escriben `2026-11-04`.
- **Búsqueda `q`**: se escapan `%`, `_` y `\` (Prisma no lo hace en `contains`); un NUL es 400.
- **`POST /auth/register` con un carácter invisible, de control o espacio en el correo** (U+200B, U+FEFF…): 400 (antes pasaba el `IsEmail` y BetterAuth lo rechazaba: 500).
- **Vista previa**: `refund_pending_after_terminal` (y `refund_pending_no_stock`) sobre una orden `PAYMENT_FAILED` u otra final avisa con `REFUND_PENDING_ON_KEPT_ORDERS` y `willKeep.ordersWithRefundPending`.

### 18.7 Observaciones (sin implementar)

- **Tope por admin:** la anonimización es irreversible y la story no pide un límite; no se implementó. Si preocupa un admin con la sesión robada, el criterio sería un contador por admin y hora dentro de la cadena de auditoría (como el de `reveal-id-doc`, AD-97: `ID_DOC_REVEAL_MAX_PER_HOUR`); hoy el freno es que hay que teclear el email exacto de cada cuenta y que cada acción queda en el log inmutable.
- `reason` es texto libre que acaba en un log inmutable: el servidor rechaza cédula, email, teléfono y secretos (400), pero **no puede detectar un nombre propio**. El texto de ayuda de la pantalla debe pedir «canal y referencia», no «quién».
- Una cuenta con órdenes activas no se anonimiza hasta resolverlas a mano (A85); un cron de «cuentas pendientes de anonimizar» queda fuera.

### 18.8 Lo medido (cifras tal como salieron; contenedor Postgres 17 desechable con un clon de la base de desarrollo, un proceso, máquina de desarrollo)

- **Coste de anonimizar** (`pnpm test:perf`, `test/customer-anonymize.perf.spec.ts`, HTTP completo, 12 muestras intercaladas; cada cuenta con credencial, 3 sesiones, 5 direcciones, 2 tokens): cliente **sin órdenes** p50 15,9 ms, p95 41,2 ms; cliente con **500 órdenes** p50 16,0 ms, p95 18,4 ms. Las 500 órdenes solo cuestan dos `COUNT`/`LIMIT` por el índice `(customerId, createdAt)`: nada es por orden. (En una corrida anterior: 20,6/50,3 ms y 22,2/32,1 ms; el ruido de la máquina es del orden de ±10 ms.) Repetir la llamada sobre una cuenta ya anonimizada (idempotente): p50 5,3 ms.
- **Detalle** con 500 órdenes: p50 8,8 ms, p95 24,4 ms. **Búsqueda** sobre 20 001 clientes: por cédula p50 5,6 ms (p95 8,3; usa `Orders_recipientIdDocBlind_idx`, `Orders_buyerIdDocBlind_idx` y `Customer_Addresses_recipientIdDocBlind_idx`; una primera versión con `EXISTS … OR EXISTS` sobre `Customers` leía la tabla entera: 23 ms), por email/nombre p50 20,7 ms (recorre la tabla: es un `ILIKE '%…%'`; sin índice trigram porque la tabla es de clientes, no de productos), primera página p50 9,6 ms.
- **Suites:** `pnpm test`: 117 archivos, 2 227 pruebas (antes 114 / 2 124). `pnpm test:e2e --no-file-parallelism`: 94 archivos, 1 316 pruebas, la cadena de auditoría del clon verificada de génesis a cabeza (1 225 filas). Con `--sequence.shuffle.files`: semilla 20607, 94/94; semilla 20606, 1 fallo ajeno a esta story (`id-doc-reveal`: la expresión `/9\d{8}/` del test casó con una parte de un UUID aleatorio, `…c907549981f5`; falso positivo de la 20.4: el JSON del evento lleva tres UUID aleatorios y la probabilidad de que alguno contenga un `9` seguido de ocho dígitos decimales es de ~10 % por corrida, con o sin mezcla de archivos; el arreglo sería comparar contra la cédula sintética concreta, no contra un patrón). Con el **rol limitado** (`collectorsclub_d206_app`, no propietario, `MIGRATE_DATABASE_URL` = propietario, contenedor desechable, `pnpm db:roles` ejecutado): 94/94, 1 316 pruebas. `pnpm test:perf`: 9 archivos, 49 pruebas.
- **Servidor real sobre un clon** (`node dist/main`, puerto aparte, claves de cédula sintéticas): cuenta con 3 pedidos hechos por el checkout real (cédula `V-93456781`), libreta, lista de deseos y mensaje de contacto; dos dispositivos con sesión. Con un pedido activo → `409 ACCOUNT_HAS_ACTIVE_ORDERS` con el pedido. Con los tres finales → `200` en 22 ms. Hash md5 de **toda** la tabla `Orders` y de `Consent_Records` antes y después: **idénticos** (`4040ed0c…`, 5 filas; `89fb2daa…`, 1 fila), y las columnas cifradas de la cédula byte a byte; el revelado admin de la orden conservada sigue devolviendo la cédula, y la vista de la orden la muestra enmascarada (`V-****6781`). Ambas sesiones, `401 INVALID_CUSTOMER_TOKEN` al instante; login con el email original, el mismo `401` y el mismo cuerpo que un desconocido; `forgot-password`, misma respuesta y **ningún correo** nuevo en MailHog; el registro con `deleted+x@anonymized.invalid`, 400; registro con el email liberado: cuenta nueva, con 0 pedidos, 0 listas, 0 direcciones y solo su propio consentimiento; `POST /admin/audit/verify` OK. **Factura:** no existe todavía un generador de facturas; la cédula conservada se comprobó con el revelado y con la vista de la orden.
- **Mutaciones** (para saber que las pruebas de concurrencia pueden fallar): sin el `FOR SHARE` del checkout falla «checkout esperando → 401»; sin el `FOR UPDATE` de la anonimización fallan tres.
- **Carreras aleatorias** (13 desfases entre un checkout y una anonimización, en cada corrida completa): resultados `checkout 422/anonymize 200` (la anonimización ganó antes de que la sesión se leyera: el checkout es de invitado y no hay carrito), `checkout 401/anonymize 200` (el checkout esperó el `FOR SHARE` y vio la cuenta anonimizada) y `checkout 201/anonymize 409` (el checkout ganó y la anonimización vio la orden): ninguna orden activa de una cuenta anonimizada, ningún 5xx, ningún `ANONYMIZE_BUSY`.

#### 18.8.1 Ronda 2 de QA (cifras tal como salieron; contenedor Postgres 17 desechable propio con un volcado de la base de desarrollo, un proceso)

- `pnpm lint`, `pnpm build`, `pnpm exec tsc --noEmit`: limpios. `pnpm test`: **120 archivos, 2 294 pruebas** (antes 118 / 2 251). `pnpm test:perf`: **11 archivos, 54 pruebas**. `pnpm test:e2e --no-file-parallelism`: **96 archivos, 1 337 pruebas**, cadena de auditoría del clon verificada de génesis a cabeza (1 294 filas). Con `--sequence.shuffle.files --sequence.seed=20608`: 96/96, 1 337/1 337 (una primera corrida con esa misma semilla falló una vez en `admin-login-proxy-chain`: el quinto `LOGIN_ADMIN_FAILED` de la prueba CONTROL se escribe **después** de enviar el 401 y podía caer dentro de la ventana `since` de la prueba siguiente; falso positivo ajeno a esta story, ya corregido esperando a que lleguen los cinco eventos al final de la prueba CONTROL). Con el **rol limitado** (`collectorsclub_d206b_app`, no propietario, `MIGRATE_DATABASE_URL` = propietario, `pnpm db:roles` ejecutado en el contenedor desechable): 96/96, 1 337/1 337.
- Búsqueda sobre 20 001 clientes (`pnpm test:perf`): cédula p50 11,0 ms (p95 24,7), `q` p50 34,6 ms (p95 59,6), primera página p50 17,7 ms (p95 37,0). Anonimizar por HTTP: sin órdenes p50 31,7 ms (p95 70,7); con 500 órdenes p50 27,5 ms (p95 47,0). Detalle con 500 órdenes p50 15,7 ms (p95 41,9); repetición idempotente p50 10,2 ms (p95 22,0). (La máquina estaba ocupada con otras corridas: son más lentas que las de 18.8, el orden de magnitud es el mismo.) Aleatoria de escritura vs anonimizar: 60 rondas de 5 operaciones, 0 datos residuales, 0 5xx; respuestas de las operaciones: 137 × 200, 42 × 201, 121 × 401.
- **La prueba de rendimiento de la búsqueda ya no aserta un plan frágil** (en un clon con una sola fila en `Customer_Addresses` el planificador elige un Seq Scan, con razón): comprueba que existen los tres índices ciegos y que, con los barridos secuenciales prohibidos, la misma sentencia se planifica sobre `Orders_recipientIdDocBlind_idx`, `Orders_buyerIdDocBlind_idx` y `Customer_Addresses_recipientIdDocBlind_idx`, más los presupuestos de tiempo.
- La migración `20261109100000_customer_anonymized_pii_is_final` se probó en el contenedor desechable (`prisma migrate deploy` sobre el volcado) antes de aplicarla a la base de desarrollo.

### 18.9 Lo que NO está verificado ni hecho

- **El frontend (Story 20.9)**: el diálogo, el aviso, el detalle y el aviso del `localStorage` no existen todavía; el contrato de 18.4 es lo que necesitan.
- Nada se probó en un VPS real ni con tablas de producción; el cliente de prueba solo envió correo a MailHog (no hay SMTP real). Quedaron unos pocos mensajes sintéticos (verificación de correo) en MailHog, que es compartido y no se vacía.
- **Un deadlock de la anonimización con otra operación no se ha provocado**: se razona (todas toman `Customers` primero) y no aparece en las carreras aleatorias ni deterministas; si ocurriera, la respuesta es `409 ANONYMIZE_BUSY`. (El deadlock **checkout contra fusión de carrito** sí se provocó, con dos conexiones y un ciclo real `40P01`, y se corrigió en la 20.6a: 18.11.)
- Las carreras de BetterAuth (un login o un reset que terminan **después** del commit) se **simulan** insertando la sesión tras anonimizar, no con un login realmente concurrente; el código que las cubre es el guard y la revocación del login/reset (18.3).
- La medida anti-enumeración son medianas de 15-20 muestras en una máquina con ruido (±10 ms): descarta una diferencia como la de un hash Argon2id (~40 ms), no una de 1 ms.
- No hay generador de facturas; los backups y los logs del sistema no se tocan (18.2).
- Con un build anterior a la 20.4 en marcha, una cuenta anonimizada no se rechaza en el checkout (18.1).
- **Ronda 2:** las carreras de BetterAuth (login, reset, forgot-password) siguen sin poder compartir transacción con la anonimización (18.6.1): se corrigen después con `scrubIfAnonymized`, no se serializan. ~~Un token de reinicio que BetterAuth escribe entre el `DELETE` de tokens y el commit puede sobrevivir~~: corregido en la 20.6a (18.11); `login` sigue corrigiéndose después con `scrubIfAnonymized`. La prueba de `resend-verification` y la del `verify-email` del admin son deterministas; las de BetterAuth no se pueden forzar con un bloqueo.
- **Ronda 2:** el `[[CONFIRMAR_CONSERVACION_IP_EN_AUDITORIA_PARA_SIEMPRE]]` de `privacidad.md` y de 18.2 espera a un abogado; no se decidió qué IPs entran (todo evento emitido desde una petición lleva `req.ip`).
- **Ronda 2:** el motivo (`reason`) rechaza cualquier número suelto de 7 o más dígitos; es deliberado, el registro es inmutable. Qué escribir en su lugar: 18.11.

### 18.10 Volver atrás

Revertir el código es seguro mientras no se haya anonimizado ninguna cuenta (las columnas nuevas se ignoran). **Una cuenta anonimizada no se puede restaurar** (ni siquiera por SQL: el trigger lo impide; solo una copia de seguridad previa conserva sus datos, hasta que rote). Para quitar las columnas hay que `DROP TRIGGER customers_anonymized_at_is_final ON "Customers"`, `DROP FUNCTION customers_anonymized_at_is_final()` y las dos columnas, con el mismo cuidado de 12.3.

### 18.11 Story 20.6a: esperas acotadas en las rutas de la cuenta, orden de locks del carrito, tokens y motivo

1. **Esperas acotadas (regresión de la 20.6).** Con un `FOR UPDATE` externo retenido sobre la fila de `Customers`, el carrito, la lista de deseos y `PATCH /auth/me` esperaban hasta que Prisma cancelaba la transacción (5 s) y respondían **500** al liberarse. Ahora `lockLiveCustomer` / `tryLockLiveCustomer` (y con ellos **todas** las rutas de `customer-write-lock`, el checkout con sesión y la fusión del login) fijan `lock_timeout = 2500 ms` con `set_config(..., true)` (local a la transacción) solo para ese `SELECT … FOR SHARE/UPDATE`, y después **devuelven el valor anterior** (un `LockBudget` del llamador sobrevive). Una espera agotada es **`409 ACCOUNT_BUSY`** (`Your account is being used by another operation. Nothing was changed: try again in a few seconds.`), el mismo código en todas las rutas, sin escribir nada y reintentable; nunca 500. Medido: la petición responde entre 2,0 y 4,5 s (las pruebas fijan ese rango) y, con el lock retenido 12 s, ya estaba respondida 409 cuando se libera. 409 y no 503 porque es la convención de todo el repo para esperas agotadas (`*_BUSY`). Coste: dos sentencias `set_config` más por escritura de cuenta; microprueba (3 000 transacciones `BEGIN`, lock, `COMMIT`, contenedor local, dos pasadas por variante): mediana 0,88 / 0,81 ms sin ellas contra 1,09 / 1,32 ms con ellas (+0,2 a +0,5 ms), p95 1,76 / 1,52 ms contra 1,80 / 2,13 ms. `test/account-bounded-waits.e2e-spec.ts`: una prueba por ruta (11), el escenario de 12 s, fusión y checkout a nivel de servicio, y que `lock_timeout` se restaura.
2. **Deadlock fusión de carrito contra checkout.** Era real y se reprodujo con dos conexiones (`test/account-bounded-waits.e2e-spec.ts`, «control»): la fusión actualiza una línea de `Cart_Items` y después hace `UPDATE "Carts" SET "expiresAt"`; el checkout hace `DELETE FROM "Carts"` (toma la fila y su cascada espera a la línea) → ciclo `40P01`. Corrección: el checkout con sesión toma, justo después del lock de `Customers`, el **mismo advisory lock del carrito de la cuenta** (`cart:<customerId>`) que ya tomaban la fusión y `addItem` (orden: `Customers`, lock del carrito, filas, cadena de auditoría al final); el helper `lockAccountCart` es único y también está acotado (`ACCOUNT_BUSY`). Además, red de seguridad: si Postgres aún elige al checkout como víctima de un deadlock, la transacción entera (ya revertida: no existe orden ni retención) se **reintenta hasta 3 veces** (`retryOnDeadlock`, `common/lock-timeout.ts`), nunca 500. Probado: el checkout espera de verdad a una fusión que retiene el lock (mutación comprobada: quitar la línea rompe la prueba), 30 rondas con `Promise.all` sin 5xx ni órdenes duplicadas. Lo que sigue sin probarse: la tasa original (1 de 25) no se puede reproducir a voluntad; la prueba aleatoria solo dice que no apareció.
3. **Token de reinicio superviviente.** `forgot-password` y `reset-password` ejecutan la escritura de BetterAuth (que va por **su** conexión) mientras una transacción propia retiene `SELECT … FROM "Customers" WHERE id = $1 FOR KEY SHARE`. Ese lock choca con el `FOR UPDATE` de la anonimización pero **no** con el `UPDATE` de columnas no clave que BetterAuth pudiera hacer sobre la misma fila (no hay auto-espera). Resultado: la anonimización o commitea antes (el token no se escribe; el reset ve `anonymizedAt` y responde **400 `INVALID_RESET_TOKEN`, igual que un token inválido**, sin contraseña, sin sesión, sin evento `CUSTOMER_PASSWORD_RESET`, y el token se borra) o espera al token y lo borra. §18.6.1 y §18.9 ya no dicen «inservible»: ya no sobrevive. `login` no cambia (`scrubIfAnonymized` después). Una espera agotada de este lock es `ACCOUNT_BUSY`. El único `FOR KEY SHARE` de `Customers` permitido por el test estático es el de `customer-auth.service.ts`.
4. **Motivo (`reason`).** Un número de 7 o más dígitos seguidos que no esté pegado a letras da `400 REASON_CONTAINS_PERSONAL_DATA` con el mensaje: *«The reason must not contain a number of 7 or more digits on its own (it could be an ID document or a phone number). Put letters right before the reference (TKT1234567) or split it with hyphens in groups of up to 6 digits (ZD-123-4567), and write dates as 2026-11-04.»* Probado: `ZD-1234567` se rechaza; `TKT1234567`, `ZD-123-4567` y `123-4567` pasan. **Un UUID de orden no se rechaza** (se quita del texto antes de las comprobaciones: un UUID aleatorio puede traer 12 dígitos seguidos o parecer un teléfono). Se cubren además los dígitos de otros alfabetos (árabe-índicos `١٢٣٤٥٦٧٨`, persas `۱۲۳۴۵۶۷`, devanagari…, que NFKC no pasa a ASCII) y los números agrupados como se imprimen las cédulas (`12 345 678`; `1.234.567` ya era `REASON_CONTAINS_ID_DOC`): el patrón agrupado exige un grupo inicial de 1 a 3 dígitos y al menos dos grupos de 3, así que `2026 11 04` y `10 20` no se rechazan. Falso positivo posible y aceptado: `ref 100 200 300` se rechaza (parece una cédula agrupada).
5. **Falso positivo del guard.** El patrón `58 2xx xxx-xxxx` ya estaba cerrado en el guard de auditoría (1e31b41; barrido de 2,4 millones de UUID en 8 contextos sin una sola marca). Sí quedaba un hueco en el **redactor de logs**: `LABEL_VALUE` marcaba `582d20f6-ced6-4771-…` (`ced` + 5 dígitos a través del guion; 40 de 2,4 millones). Corregido con un lookbehind (`(?<![0-9a-f]{4}-)`); `src/common/uuid-false-positive.spec.ts` fija los UUID exactos y barre 40 000 sembrados contra los tres detectores. No se encontró otro camino con UUID; el 500 de `legal-consent` que vio QA no se pudo reproducir con ningún UUID ni hash: **no verificado** que fuera este patrón.
6. **Test estático.** `customer-write-lock.static.spec.ts` ahora usa el AST de TypeScript: ve `tx["customer"]`, la cadena partida en dos líneas, SQL en minúsculas o con espacios y saltos, `public."Customers"`, `$executeRawUnsafe`/`$queryRawUnsafe`, SQL concatenado y las escrituras anidadas (`order.update({ data: { customer: { update } } })`, `items: { create }`, `addresses: { deleteMany }`); 13 casos de bypass y 5 de no-detección se prueban sobre fuentes de ejemplo. Límite: no ve un nombre de tabla construido en tiempo de ejecución ni SQL en archivos `.sql` o triggers.
7. **Test `admin-login-proxy-chain`:** la espera de los 5 eventos va antes de leer el último.

### 18.12 Story 20.6a, segunda ronda: ningún correo ni llamada a BetterAuth con la transacción abierta

**Qué pasaba (reproducido con `test/account-hung-smtp.e2e-spec.ts`: un listener TCP que acepta la conexión SMTP y no responde nunca).** `whileAccountLive` mantenía una transacción (`FOR KEY SHARE` sobre `Customers`) mientras BetterAuth escribía el token **en su propia conexión**. Cada `forgot-password` necesitaba, por tanto, **dos** conexiones del pool de 10 (la de su transacción y la de BetterAuth); con 30 concurrentes las 10 quedaban `idle in transaction` esperando una segunda conexión que solo otra podía liberar. El SMTP colgado no era la causa directa (el envío ya iba sin `await`), sino lo que hacía lenta la cola; la causa es el patrón «transacción abierta + llamada que usa otra conexión del mismo pool».
Antes (cifras tal como salieron, 30 `forgot` concurrentes, 15 de un email existente y 15 de uno desconocido): pared 20 024 ms, media «desconocido» 14 696 ms, media «existente» 50 ms, máximo de conexiones `idle in transaction` = 9. Después: pared 78 ms, existente 60 ms, desconocido 72 ms, máximo `idle in transaction` = 0, `GET /categories` 4 ms.

Corrección (ninguna E/S externa dentro de una transacción):

- **BetterAuth ligado a la transacción.** `CUSTOMER_AUTH_IN_TX` (`src/auth-core`) construye una instancia de BetterAuth cuyo adaptador es el cliente de la transacción (≈0,4 ms por instancia). `forgot-password` y `reset-password` escriben el token / la contraseña **en la conexión de la propia transacción**, bajo el `FOR KEY SHARE`: la protección frente a la carrera con la anonimización es la misma (o se escribe antes y la anonimización lo borra, o ve `anonymizedAt` y no escribe nada).
- **El correo va después del `COMMIT`.** BetterAuth no lo envía: lo entrega a `onResetMail` (se recoge) y `requestReset` lo manda cuando la transacción terminó. Un correo no sale nunca de un token que se revirtió ni de una cuenta anonimizada, y un SMTP colgado ya no retiene nada de la base. `MailerService` ahora corta una conexión SMTP muda (`connectionTimeout` y `greetingTimeout` 10 s, `socketTimeout` 30 s; antes 2 y 10 minutos), lo que también acota `POST /contact` (que sí espera el envío).
- **El hash de Argon2id se calcula antes de la transacción** (reset: la contraseña nueva; login: la verificación), así que la transacción retiene la conexión solo por sentencias.
- **Trabajos en segundo plano acotados** (`src/common/background-queue.ts`): `forgot-password`, `resend-verification` y el token del registro pasan por una cola de 3 trabajos simultáneos y 200 en espera; `forgot-password` además no encola dos veces el trabajo de la misma cuenta mientras el primero sigue pendiente (un reinicio por cuenta a la vez). Las reenvíos de verificación **no** se deduplican: cada petición sigue enviando su correo (lo exige `customer-resend-verification.e2e-spec.ts`). Antes 30 `resend-verification` de una cuenta eran 30 transacciones esperando el mismo advisory lock con una conexión cada una (`GET /categories` 1 348 ms en la primera medición). Un desbordamiento se descarta con un WARN (la persona puede pedirlo otra vez; la respuesta nunca prometió el envío).
- **Anti-enumeración por tiempo intacta:** las ramas siguen devolviendo tras la misma consulta; todo lo demás es en segundo plano. Medido arriba (60 ms frente a 72 ms con el SMTP colgado).
- **Registro y `resend-verification`:** su transacción ya no contenía E/S externa (el correo iba después); solo se les añadió la cola. `POST /contact` envía el correo sin transacción (persistir primero). No hay otra llamada de correo o de red dentro de una transacción en `src/` (`fx`, `tcg` y la descarga de imágenes llaman fuera de ella, comprobado).

**`POST /auth/login` con la fila de `Customers` retenida.** El `INSERT` de `Customer_Sessions` de BetterAuth necesita un lock compartido sobre esa fila (clave foránea) y no tiene `lock_timeout`: esperaba mientras durara el `FOR UPDATE` (medido por QA: más de 8 s, hasta 4 min). Ahora el login se parte en dos: (1) la comprobación de la credencial (un Argon2id en todos los casos: verificar si hay contraseña, hashear si no) **sin conexión retenida**; (2) el `signInEmail` de BetterAuth ligado a una transacción corta con `lock_timeout` de 2,5 s (`withAccountLockWait`) y con el veredicto del paso 1. Si el lock vence: **409 `ACCOUNT_BUSY`**, sin sesión, reintentable; no hay `Promise.race` ni sonda: el límite lo pone la base. Como mucho 3 logins de la misma cuenta (credenciales correctas) esperan los 2,5 s completos; los demás esperan solo 150 ms y reciben el 409 (sin lock retenido pasan todos, como pasaban seis logins simultáneos), así que una cuenta retenida no agota el pool (con 12 logins simultáneos `GET /categories` respondió normalmente).
*Sin oráculo:* solo llega al lock una petición con credenciales **correctas**; la contraseña errónea y el email desconocido siguen siendo el mismo 401 con el mismo coste y sin lock, con la cuenta retenida o no (probado), y quien tiene la contraseña correcta ya sabe que existe (le bastaría el 200). Lo que revela el 409 es «tu cuenta está ocupada», no si una cuenta existe.
`reset-password` con la fila retenida: 409 `ACCOUNT_BUSY` en 2,5 s sin consumir el token (probado); `forgot-password`: 200 al instante y sin conexión retenida.

**Mensaje del `reason`.** Decía «7 o más dígitos seguidos / on its own»; ahora dice «whether written together (1234567) or in groups separated by spaces or dots (12 345 678, 100.200.300)», que cubre los grupos con espacios.
**Test estático.** Ahora también ve los alias: `const c = tx.customer; c.update(...)`, `const { customer } = tx`, `const { cart: basket } = this.prisma` y `w = tx.wishlistItem`; y no marca lecturas por alias ni un local ajeno llamado `update`.

**Lo no verificado.** El SMTP colgado se simula con un listener local; un proveedor real que responde despacio por trozos no se probó. Los valores 3 (`LOGIN_TX_PER_ACCOUNT`) y 150 ms (`LOGIN_EXTRA_WAIT_MS`) son una decisión, no medida con tráfico real: con la fila retenida, del cuarto login correcto simultáneo en adelante el 409 llega a los 150 ms.

## 19. Epic 20, Story 20.7: log de uso de 7 días (`Usage_Logs`), búfer no bloqueante y consulta admin

Angel pidió **una auditoría de uso: logs de todo, con 7 días de duración; a los 7 días se borran.** Esto es lo que se hizo, lo que se registra y lo que no, y lo que se midió.

### 19.1 Qué se registra exactamente (y qué nunca)

Una fila por petición HTTP que **termina** (`res.on('finish')`; una conexión que se corta antes de responder no tiene estado que registrar y no deja fila), en este orden de columnas:

| Columna | Qué es | De dónde sale |
|---|---|---|
| `id` (bigserial) | orden de inserción y cursor de la consulta | la base |
| `ts` (timestamptz 3) | cuándo terminó la respuesta | `Date.now()` |
| `method` (≤ 10) | `GET`, `POST`… (otro valor ⇒ `OTHER`) | `req.method` validado `^[A-Z]{1,10}$` |
| `route` (≤ 200) | la **plantilla** de la ruta que casó (`/api/v1/orders/:orderId`), o `__unmatched__` (404, estáticos, rutas que no son de Express) | `req.route.path` si es una cadena que empieza por `/`; **nunca** `originalUrl`, `url`, `query` ni el valor de un parámetro |
| `status` (smallint) | código HTTP | `res.statusCode` (fuera de 100..599 ⇒ 0) |
| `durationMs` (int) | de la llegada a `finish` | `process.hrtime.bigint()` |
| `actorType` | `ADMIN` (`req.user.id` uuid, `AdminAuthGuard`), `CUSTOMER` (`req.customer.id` uuid, `CustomerAuthGuard`) o `ANON` | solo ids con forma de uuid; un id raro ⇒ `ANON` |
| `actorId` (uuid) | el id del admin o del cliente | idem |
| `ip` (inet) | `req.ip`: la dirección real del cliente según `TRUST_PROXY` (17.8: `X-Forwarded-For` contado desde la derecha por los proxies de confianza, la parte izquierda forjada se ignora) | solo si `net.isIP` la acepta (sin zona `%eth0`); si no, `NULL` |
| `userAgent` (≤ 200) | cabecera `User-Agent` sin caracteres de control, cortada a **200 puntos de código** (nunca a mitad de un par sustituto) y **con el redactor aplicado** (`redactText` del guard de auditoría + `redactString`: un correo de contacto, una cédula, un teléfono, una tarjeta o un secreto dentro del agente se enmascara) | cabecera |
| `requestId` (uuid) | el mismo valor que el cliente vio en `X-Request-Id` (lo genera el middleware de 20.1; se ignora el que envíe el cliente) | `res.getHeader` |

**Nunca:** cuerpos (ni de formularios ni el del webhook de Stripe: el middleware no lee `req.body` ni `rawBody`), `Authorization`, `Cookie`, tokens (`?token=`, `?next=`, enlaces de verificación o de reinicio), contraseñas, correos, teléfonos, **cédulas** (`?idDoc=` y similares, que además dan `400 ID_DOC_IN_URL_NOT_ALLOWED` antes de llegar a la base), el valor de ningún parámetro de ruta (un id de pedido o de producto) ni la query string. Como la query nunca se mira, no hay nada que redactar en ella.

**Exclusiones** (decididas sobre la plantilla si la hay y, si no, sobre la ruta en minúsculas sin query ni barras repetidas, porque Express enruta sin distinguir mayúsculas): `/api/v1/health`, `/uploads/…`, `/api/docs…` y `/api/v1/admin/audit/usage…` (la propia consulta: sin esto la vista se alimentaría a sí misma en bucle).

**Los fallos de login de clientes solo aparecen aquí** (A95): `POST /auth/login` 401 con `actorType = ANON`, la IP y el agente; ni el email ni la contraseña (no se mira el cuerpo). No son prueba legal.

### 19.2 La IP y su plazo: lo que la story pide y dónde está dicho

La story pide `ip` y `userAgent` por **7 días** con finalidad de seguridad y diagnóstico (A95). Es un dato personal: se declaró en **`prisma/seed-data/legal/privacidad.md`** §2 (viñeta «Registro de uso (7 días)»), §3 (la base «Interés legítimo» de seguridad ahora dice «incluye el registro de uso»), §7 (plazo: 7 días y se borra al cerrar la cuenta) y §9 (se borra con la cuenta), cada afirmación **con su marca**: `[[CONFIRMAR_REGISTRO_DE_USO_7_DIAS_IMPLEMENTADO]]` (a confirmar cuando el despliegue tenga la migración **y** la purga activa, 19.6) y `[[CONFIRMAR_CON_ABOGADO_BASE_LEGAL_DEL_REGISTRO_DE_USO]]` (si el interés legítimo basta y si 7 días es el plazo; lo decide un abogado). `legal-seed.templates.spec.ts` falla si una línea que afirma esto pierde su marca. Hay que tocar el borrador de `privacidad` en el admin si ya se había publicado una versión sin esto (el seed solo crea borradores): 12.5.

### 19.3 Migración y despliegue (migrar ANTES de reiniciar)

- Migración **nueva** `20261110100000_add_usage_logs_retention` (la story decía `20261102130000…`, una fecha anterior a las ya aplicadas; Prisma no debe recibir una migración «en el pasado»). `BEGIN;` en la primera línea, `COMMIT;`, **sin `lock_timeout` propio** (lo acota `deploy.sh`), solo `CREATE TABLE`/`CREATE INDEX` (no toca ninguna tabla existente; el FK de `Retention_Runs` a `Admin_Users` toma un bloqueo compartido momentáneo), sin funciones. Crea `Usage_Logs` (columnas y los seis índices de la story, con `CHECK` en `actorType`, `status` y `durationMs`) y `Retention_Runs` (para 20.8: `id, trigger SCHEDULED|MANUAL, triggeredById, startedAt, finishedAt, status RUNNING|OK|PARTIAL|FAILED, tasks jsonb`; tabla de operación, A105). Probada sobre un clon y aplicada con `prisma migrate deploy`; `prisma migrate diff` solo marca el índice `varchar_pattern_ops` (Prisma no lo introspecciona) y `ip inet` (`Unsupported`, igual que `Audit_Events`).
- **Rol limitado:** `Usage_Logs` es **mutable a propósito** (la purga y la anonimización la borran) y separada de `Audit_Events`; el rol de la aplicación solo necesita `SELECT`, `INSERT` y `DELETE`. La migración **revoca `UPDATE`, `TRUNCATE`, `REFERENCES` y `TRIGGER`** a los roles `collectorsclub_*_app` que ya existan, y `scripts/db-roles.sql` hace lo mismo para los que se creen después (`pnpm db:roles` es idempotente: **vuélvelo a ejecutar tras desplegar**, 13.3). Comprobado con un rol real: `UPDATE` y `TRUNCATE` ⇒ `permission denied`, `INSERT`/`DELETE`/`SELECT` ⇒ bien. Nunca se hace `UPDATE` sobre una fila de uso.
- Variables (`.env.example`, todas opcionales): `USAGE_LOG_ENABLED` (por defecto `true`; `false` no monta el middleware ni los temporizadores: es también la forma de medir el coste), `USAGE_LOG_BUFFER_MAX=10000` (100..1 000 000), `USAGE_LOG_FLUSH_MS=1000` (50..60 000), `USAGE_LOG_FLUSH_BATCH=200` (1..5 000, no mayor que el búfer), `PURGE_USAGE_LOG_DAYS=7` (1..30), `USAGE_LOG_PURGE_CRON` (por defecto `0 15 4 * * *` UTC; `off` cuando la 20.8 haga la purga). Un valor inválido **detiene el arranque** nombrando la variable.
- `main.ts` monta el middleware **justo después del `requestId` y antes de `cookie-parser`** y llama a `app.enableShutdownHooks()` (ya estaba, 20.5).

### 19.4 Por qué no puede frenar ni romper una petición

- **El middleware** es Express, no un interceptor (no vería un 404 ni un rechazo de guard). En `finish` arma la fila y llama a `buffer.push`: síncrono, sin E/S, dentro de un `try/catch` que se traga cualquier error (la respuesta ya salió). Microprueba (20 000 peticiones sintéticas, `test/usage-log.e2e-spec.ts`): ver 19.9.
- **El búfer** (`UsageLogBuffer`, singleton): cola en memoria con tope `USAGE_LOG_BUFFER_MAX`; al llenarse **se descarta la más antigua** y `droppedSinceBoot` crece (`push` nunca lanza: si ni eso pudo, cuenta como descarte). Cada fila está acotada (ruta ≤ 200, agente ≤ 200, sin cuerpo): el peor caso del tope por defecto son unos 10 MB aunque la base lleve horas caída (50 000 filas empujadas con la base caída: el búfer se queda en el tope, ver 19.9).
- **Una sola escritura a la vez** (un solo vuelo), por temporizador (todo lo pendiente) o al juntar un lote (solo lotes completos, para que un servidor ocupado vacíe más rápido de lo que llena), **fuera de la pila de la petición** (`setImmediate`) y dentro de `RequestContext.detached()`: `AsyncLocalStorage` habría dado a la escritura el `requestId` y la IP de la petición que la armó. Una escritura es **un** `INSERT … SELECT FROM unnest(…)` en una transacción de milisegundos con `statement_timeout` 4 s y `lock_timeout` 1 s (`set_config(..., true)`); no retiene ninguna conexión del pool entre escrituras y las rutas calientes no tocan la base por el log.
- **Fallo de la base:** las filas vuelven al **frente**, la siguiente escritura espera 1 s, 2 s, 4 s… (máx. 30 s: no se martillea una base caída), el error queda en `lastFlushError` (una línea, redactada) y, si lo pendiente excede el tope, se descartan las más antiguas. Una escritura que **nunca** podrá funcionar (error `22xxx` de datos o `23xxx` de restricción) se descarta de una vez y se cuenta, en lugar de reintentarse sin fin delante de todas las demás. Una escritura que no contesta en 8 s se da por fallida.
- **Cierre normal:** `onModuleDestroy` (no `onApplicationShutdown` como decía la story: Nest llama a `onModuleDestroy` de `PrismaService`, que cierra la conexión, **antes** de `onApplicationShutdown`; una escritura final ahí fallaría) vacía lo pendiente con un tope de 2 s y, si no cabe, lo dice con `logger.error` y el número de filas perdidas. Probado con `app.close()` y con `SIGTERM` a un servidor real (19.9). Un `kill -9` o un corte de luz **sí** pierde lo que había en memoria (hasta 1 s de tráfico): no se puede evitar con un búfer en memoria.
- **Dato personal y varias instancias:** el contador de descartes y el búfer son **por instancia** (hay una por entorno, A101).

### 19.5 La anonimización de una cuenta y el búfer en memoria

`CustomerAnonymizationService` borra el log de uso de la cuenta en **tres pasos** que, juntos, no dejan ninguna fila aunque el búfer esté en memoria y la escritura sea asíncrona (`src/usage/usage-erasure.service.ts`):

1. **En la misma transacción**, bajo el bloqueo de `Customers` y antes del evento de auditoría: `DELETE FROM "Usage_Logs" WHERE "actorType" = 'CUSTOMER' AND "actorId" = $1` (usa `(actorId, ts)`; el número va en el evento como `usageLogsDeleted`).
2. **Tras el commit** (`afterCommit`, nunca lanza): el búfer descarta las filas pendientes de esa cuenta y **rechaza las que lleguen después** (una petición con la sesión antigua que termina tras el commit) durante 10 minutos; se **espera la escritura en vuelo** (puede llevar filas tomadas antes del commit) y se vuelve a borrar una vez más. Un fallo se registra y lo recoge la purga de 7 días.
3. **La propia escritura se niega a insertar** una fila de un cliente cuya fila de `Customers` ya tenga `anonymizedAt` (`NOT EXISTS …` dentro del `INSERT … SELECT`): desde el commit no puede volver ninguna fila, ni siquiera desde el búfer de **otra** instancia.

Probado (`test/usage-log.e2e-spec.ts`): filas ya escritas + filas en memoria + una fila que llega tras el commit ⇒ 0 al final y las de otro cliente intactas; una escritura **en vuelo** retenida con una compuerta durante la anonimización ⇒ 0; el `INSERT` directo con una cuenta anonimizada y otra viva en el mismo lote guarda solo la viva. **§18.2** (`Usage_Logs`) y `willDelete.usageLogs` (cuántas filas hay ahora; no cuenta lo que aún esté en memoria) quedan actualizados.

### 19.6 La purga de 7 días (la 20.8 la absorbe, pero no se queda sin hacer entre una y otra)

La story deja la purga a la 20.8; una tabla que solo crece entre las dos stories no es aceptable, así que **`UsageLogPurgeService`** (`src/usage/usage-purge.service.ts`) ya borra a diario (`0 15 4 * * *` UTC, antes de las 04:30 que reserva la 20.8): lotes de 1 000 por `ts` (`DELETE … WHERE id IN (SELECT id … ORDER BY ts LIMIT n)`; cada lote es su propia transacción corta, así que **no hay bloqueos largos** ni un `INSERT` espera. **Sin `FOR UPDATE SKIP LOCKED`**: una cláusula de bloqueo de filas exige el privilegio `UPDATE`, que el rol limitado no tiene sobre esta tabla (lo encontró la corrida completa de los e2e con el rol limitado: `permission denied for table Usage_Logs`); un lote que encuentra una fila que la anonimización está borrando en ese instante espera 2 s como máximo y termina la corrida con `truncated`, y el resto cae en la siguiente), pausa de 100 ms, tope de 5 minutos por corrida (`truncated`, sigue al día siguiente), bloqueo advisory de transacción `2120003` por lote (dos instancias no purgan a la vez; el de la cadena de auditoría es 2120001 y el de la 20.8, 2120002) e idempotente. `purgeExpired()` es el método que la `RetentionService` de la 20.8 llamará como su tarea `usage_logs`; ese día se pone `USAGE_LOG_PURGE_CRON=off`. **Coordinación:** la 20.8 no necesita otra migración (`Retention_Runs` ya existe) ni reimplementar el borrado; el evento `RETENTION_PURGE_RUN` y el registro en `Retention_Runs` siguen siendo de la 20.8 (hoy la purga solo deja una línea de log). Medido: 19.9.

**Story 20.8:** esa purga ya la ejecuta el job de retención como su tarea `usage_logs` (con el reloj, el margen y la condición de parada de la corrida), y `UsageLogPurgeService` solo corre por su cuenta si `USAGE_LOG_PURGE_CRON` es una expresión cron y el job no está activo; ver §20.1.

### 19.7 Consulta admin (contrato para la 20.9)

- `GET /admin/audit/usage?from=&to=&actorType=&actorId=&route=&status=|statusClass=&ip=&requestId=&cursor=` (`AdminAuthGuard`). `{items[{id, ts, method, route, status, durationMs, actorType, actorId, ip, userAgent, requestId}], nextCursor}`; 50 por página, **cursor por `id` descendente** (`id` sigue el orden de inserción, que sigue a `ts` de cerca: un cursor por fecha repetiría o saltaría filas del mismo milisegundo); `id` es una cadena (bigint). `from`/`to` ISO 8601 (una fecha sola cubre el día UTC), `route` es un **prefijo** de plantilla que empieza por `/` (`%`, `_` y `\` son literales), `ip` una dirección o un CIDR (`10.7.0.0/16`), `statusClass` `2xx|3xx|4xx|5xx`. Errores: `400 USAGE_FILTER_INVALID`, `400 ID_DOC_IN_URL_NOT_ALLOWED` (`assertNoIdDocInQuery`: ningún filtro admite cédula y Nginx escribiría la línea completa en su `error_log`; el valor no se devuelve), `401 INVALID_ADMIN_TOKEN`, `503 USAGE_QUERY_TIMEOUT` (la consulta se corta a los 5 s con `statement_timeout`; acota el rango o añade un filtro). Solo lectura; no hay exportación; la propia consulta no se registra.
- `GET /admin/audit/usage/stats` ⇒ `{buffered, droppedSinceBoot, lastFlushAt, lastFlushError, writtenSinceBoot}` (por instancia). El banner de la pantalla: «Los registros de uso se conservan 7 días»; `droppedSinceBoot > 0` o `lastFlushError` no nulo merece un aviso visible.
- Swagger: `@ApiOperation`, un `@ApiQuery` por filtro y `@ApiResponse` con 200/400/401/503; verificado en el e2e contra el documento generado.

### 19.8 Rendimiento: índices, particionado y volumen

- Los seis índices de la story (`(ts)`, `(actorId, ts)`, `(route varchar_pattern_ops, ts)`, `(status, ts)`, `(ip, ts)`, `(requestId)`) se crearon tal cual; `EXPLAIN` sobre la tabla grande muestra `requestId`, `actorId`, `ip`, ruta y rango de tiempo por índice (19.9). La paginación por cursor (`id < $`) cuesta lo mismo en la página 30 que en la primera.
- **Sin particionado** (A102): Prisma no modela tablas particionadas y el borrado por lotes de 1 000 aguanta el volumen de una tienda (19.9: ver el ritmo). Se revisa si la tabla pasa de ~5 M filas por día; entonces la partición diaria con `DROP PARTITION` sustituye al `DELETE`.
- Cada petición escribe una fila con siete índices: a 100 peticiones por segundo son 8,6 M filas al día... pero con 7 días de retención la tabla se mantiene en unos 60 M como máximo a ese ritmo; el volumen real de una tienda es órdenes de magnitud menor. Si crece, el muestreo de rutas públicas (A96) es la palanca, no el particionado.

### 19.9 Lo medido (cifras tal como salieron)

Máquina de desarrollo (WSL2, una sola máquina para el servidor, el generador de carga y el Postgres; **ruidosa**: comparte CPU con otros contenedores de QA, y la misma configuración varía entre pasadas más que entre «con log» y «sin log»). Servidor real (`node dist/main`, un proceso, `USAGE_LOG_ENABLED=true|false` para el antes y el después) sobre un clon de la base de desarrollo en un contenedor Postgres 17 desechable, **con el rol limitado** (`collectorsclub_d207_app`), claves de cédula sintéticas, datos sintéticos, generador de carga en Node con conexiones persistentes (`keep-alive`), tres pasadas intercaladas `off, on, off, on…` de 20 s por prueba, 3 s de calentamiento:

| Prueba | Pasada | sin log: p50 / p95 / p99 (ms) y req/s | con log: p50 / p95 / p99 (ms) y req/s |
|---|---|---|---|
| Catálogo (`GET /products`, `/categories`, `/catalog/facets`, 32 conexiones) | 1 | 17,77 / 24,70 / 27,95 · 1 699 | 15,83 / 21,62 / 23,55 · 1 920 |
| | 2 | 14,36 / 19,86 / 21,72 · 2 283 | 18,15 / 28,93 / 36,06 · 1 531 |
| | 3 | 17,62 / 25,04 / 28,28 · 1 848 | 16,22 / 22,07 / 24,26 · 1 888 |
| Checkout invitado (carrito + `POST /checkout` Pago Móvil, 8 conexiones; la latencia es la del checkout) | 1 | 25,90 / 49,71 / 67,19 · 202 | 24,14 / 46,12 / 59,88 · 206 |
| | 2 | 23,94 / 45,28 / 59,34 · 205 | 30,58 / 58,16 / 75,67 · 171 |
| | 3 | 24,93 / 48,91 / 67,65 · 195 | 24,39 / 45,42 / 60,09 · 217 |

Medianas de las tres pasadas: catálogo p50 17,62 → 16,22 ms y p95 24,70 → 22,07 ms; checkout p50 24,93 → 24,39 ms y p95 48,91 → 46,12 ms. **No hay diferencia medible a esta carga** (la pasada 2 «con log» es peor y la 1 y la 3 son mejores: es ruido de la máquina). Todas las respuestas fueron 200/201.

El peor caso del coste (la petición más barata posible, un 404, a saturación de CPU, 32 conexiones, 15 s): sin log 2,90 / 4,16 / 6,21 ms y 9 395 req/s; con log 3,58 / 4,84 / 7,04 ms y 8 506 req/s: **+0,7 ms y −9 % de rendimiento a 9 000 req/s**, que es el coste de escribir 8 500 filas por segundo desde el mismo hilo (armar los arrays y serializar el `INSERT`), no el del middleware.

- **Microprueba del middleware** (20 000 peticiones sintéticas dentro del e2e, armar la fila y encolarla): p50 0,005 ms, p95 0,009 ms, p99 0,019 ms. El umbral del test es 2 ms (NFR-20.3, más de 200 veces la cifra real, para que un CI lento no falle).
- **Sin pérdida en un cierre normal:** servidor real, 2 000 peticiones (20 conexiones) y `SIGTERM` justo después: 2 000 filas en la tabla, 2 000 `requestId` distintos. Con el temporizador a 60 s (solo el cierre puede escribir) el e2e con `app.close()` guarda 25 de 25. Sin carga extrema nada se descarta: catálogo a 1 517 req/s, 32 590 peticiones ⇒ **32 590 filas**; checkout a 159 req/s, 2 629 checkouts ⇒ 2 629 filas de `/checkout` y 2 629 de `/cart/items`.
- **Con la base caída** (`docker pause` del Postgres, 60 s, 32 conexiones a rutas que no usan la base, 404): **574 600 peticiones respondidas, todas 404, p50 3,11 / p95 4,48 / p99 6,65 ms** frente a p95 5,15 ms con la base arriba (misma ráfaga); ninguna se retrasó ni falló. El búfer se quedó en su tope de 10 000 filas; el RSS del servidor pasó de 432 MB (tras 85 000 peticiones de calentamiento) a 457 MB tras 574 600 más con la base caída (+25 MB, incluye el montón de las propias peticiones); el aviso del log dice cuántas filas se descartaron. Al volver la base el búfer vació las 10 000 filas que guardaba. **Pérdida honesta:** en el tramo de 8 500 req/s con la base arriba se descartó un 15 % (12 791 de 85 191): a ese ritmo (30 veces el del catálogo) una escritura de 200 filas no vacía tan deprisa como llegan. Si alguna vez pasa, `droppedSinceBoot` lo cuenta y `USAGE_LOG_FLUSH_BATCH` más alto lo corrige.
- **Chaos en el e2e:** con el escritor de la base de logs lanzando error, 300 peticiones en `Promise.all` ⇒ 300 respuestas 200, el búfer ≤ 100 (tope de ese test), `droppedSinceBoot` ≥ 150, `lastFlushError` = `connection refused` también en `GET /admin/audit/usage/stats`; con una base que **no contesta nunca**, 40 peticiones ⇒ 40 respuestas 200 y el cierre termina en menos de 10 s (el vaciado final se rinde a los 2 s).
- **Volumen** (`pnpm test:perf test/usage-log.perf.spec.ts`; por defecto 400 000 filas, aquí 3 000 000 en 9 días, 667 000 de ellas con más de 7 días, tabla sembrada en 43 s): consultas del admin con la tabla entera (mediana de 8 ejecuciones): por `actorId` 2,5 ms, por IP 1,5 ms, CIDR `/16` 17,2 ms, una hora de rango 8,5 ms, `status=500` 135 ms, `statusClass=4xx` 188 ms, `actorType=ADMIN` 180 ms, solo prefijo de ruta (coincide con todas las filas: el peor caso) 427 ms; la página 30 del cursor cuesta 1,6 ms (la primera, 427 ms: el cursor es por `id`, no por `OFFSET`). Con 400 000 filas: 65, 20, 32, 2, 31, 1,5, 3,9 y 2,5 ms. `EXPLAIN`: `requestId`, `actorId`, IP y ruta+tiempo usan sus índices.
- **Purga** con el ritmo real (lotes de 1 000, pausa de 100 ms): 667 168 filas en 668 lotes en 70,4 s (**9 481 filas/s: 1 M de filas = 105 s**, la meta de NFR-20.3 es < 5 min); con 400 000 filas, 88 897 en 9,2 s (9 653/s). Mientras tanto un escritor insertaba lotes de 200 filas cada 20 ms: **2 755 inserciones, p50 5,2 ms, p95 6,5 ms, máximo 63,8 ms** (con 400 000 filas: máximo 8,7 ms): la purga no hace esperar ningún `INSERT`. Segunda corrida: 0 filas.

### 19.10 Lo que NO está verificado ni hecho

- **No hay pantalla** (`/admin/auditoria/uso` es la 20.9) ni el evento `RETENTION_PURGE_RUN` ni el registro en `Retention_Runs` de la purga (20.8).
- **Nada se probó en un VPS real**, con Nginx ni con Traefik por delante: la IP se prueba con el `trust proxy` de los e2e (`X-Forwarded-For` desde la derecha, una cadena forjada se ignora); que la IP del log sea la real en Dokploy depende de `TRUST_PROXY` (17.8).
- **Varias instancias:** el búfer, el contador de descartes y las «lápidas» de cuentas anonimizadas son por instancia. Lo que cubre otra instancia es la propia escritura (`NOT EXISTS … anonymizedAt`) y la purga.
- **Una escritura que expira a medias** (la base la ejecuta pero el acuse se pierde) puede duplicar filas del lote al reintentarse: no hay clave natural que lo impida (`id` es una secuencia). Es un caso de red partida; el efecto es una fila repetida durante 7 días.
- **`kill -9` o corte de luz** pierden lo que haya en memoria (hasta ~1 s de tráfico).
- Las conexiones que se cortan antes de que termine la respuesta (`close` sin `finish`) **no se registran**.
- A 8 500 peticiones por segundo sostenidas el escritor descarta (15 % medido, arriba): no es la carga de esta tienda, pero no es «sin pérdida a cualquier ritmo».
- El 500 que `legal-consent` dio una vez a QA y el falso positivo del guard no se reprodujeron (18.11 punto 5).
- La **misma máquina** sirvió de servidor, de generador de carga y de base: las cifras de latencia absolutas no valen como capacidad de producción; solo la comparación con/sin log, intercalada.

### 19.11 Volver atrás

`USAGE_LOG_ENABLED=false` y reiniciar apaga el log sin tocar la base. Para quitarlo del todo: desplegar la versión anterior (el código nuevo no se ejecuta) y, si se quiere, `DROP TABLE "Usage_Logs", "Retention_Runs"` con el mismo cuidado de 12.3 (son tablas nuevas: no hay nada que restaurar; **`Retention_Runs` la necesita la 20.8**). Si el log ya tenía filas y se quiere vaciarlo antes de apagar: `DELETE FROM "Usage_Logs"` (el rol de la aplicación puede; `TRUNCATE` es del propietario).

## 20. Epic 20, Story 20.8: el job de retención (purgas programadas)

Qué se borra, cuándo, con qué garantías y qué **no** se borra nunca. Es para Angel; §20.8 es la lista de decisiones que son tuyas.

### 20.1 Dónde corre (leer antes de desplegar)

- **Solo en producción, o si lo pides.** El job (el cron de las 04:30 UTC **y** `POST /admin/retention/run`) funciona únicamente con `NODE_ENV=production` o con `RETENTION_PURGE_ENABLED=true`. Con `RETENTION_PURGE_ENABLED=false` se apaga hasta en producción (para un incidente). Un servidor de desarrollo comparte la base con tus datos de prueba: por omisión **no purga nada**; el POST manual responde `409 RETENTION_DISABLED` y `GET /admin/retention/config` dice `enabled:false`. Un entorno `staging` con `NODE_ENV=staging` tampoco purga hasta que lo actives a propósito.
- **Los tests nunca pueden purgar la base de desarrollo.** Bajo `NODE_ENV=test` el servicio comprueba `current_database()` y se niega (`RetentionGuardError`) si no es un clon desechable `<nombre>_e2e_<epoch>_<hex8>`; además el cron viene desactivado en test y los e2e ya se niegan a arrancar fuera de un clon.
- **El log de uso (20.7)** ya no tiene horario propio: `UsageLogPurgeService` solo corre por su cuenta si `USAGE_LOG_PURGE_CRON` es una expresión cron, y aun así no corre mientras el job de retención esté activo. `.env.example` trae `USAGE_LOG_PURGE_CRON=off`. Efecto en un servidor de desarrollo: `Usage_Logs` no se poda sola (se acumula; el job la poda donde esté activo).
- **El cron de `Product_Daily_Stats` de las 03:30 (Epic 18) sigue existiendo** y es idempotente: el job lo invoca (no lo reimplementa) y la segunda ejecución no encuentra nada. Es el único cron anterior que sigue activo en desarrollo.
- **Migración** `20261111100000_retention_job` (nueva, empieza con `BEGIN;`, sin `lock_timeout`, sin funciones ni triggers): tres columnas nullable en `Retention_Runs` (`effectiveNow`, `auditedAt`, `errorSummary`), un índice único parcial (una sola fila `RUNNING` posible) y siete índices sobre columnas de caducidad (`expiresAt`, `createdAt`). Migrar **antes** de reiniciar (`deploy.sh` lo hace). El `CREATE INDEX` no es `CONCURRENTLY` (una transacción no puede): bloquea escrituras de esa tabla solo mientras se construye y esas tablas tienen miles de filas, no millones.

### 20.2 Tabla por tarea

Orden de ejecución (las tablas pequeñas primero, la grande al final: un atraso en `Usage_Logs` no deja sin tiempo a las demás). Todas se miden desde el reloj de la corrida (§20.5) menos 1 hora de margen.

| Tarea | Tabla | Plazo | Variable | Por omisión | Base |
|---|---|---|---|---|---|
| `sessions_expired` | `Customer_Sessions`, `Admin_Sessions` | `expiresAt` + 7 días | (constante) | 7 días | PRD FR-131; la Política de Privacidad lo promete literal |
| `session_pii` | las mismas | IP y agente → `NULL` a los N días de **creada**, solo si ya venció | `PURGE_SESSION_PII_DAYS` | 90 (rango **30..90**) | FR-131; el texto dice 90, un valor mayor lo haría falso |
| `revoked_tokens` | `Revoked_Tokens` (denylist en desuso desde 12.2) | `expiresAt` + 7 días | (constante) | 7 días | FR-131 |
| `verification_tokens` | `Customer_Verifications` (verificación y reset) | `expiresAt` + N días | `PURGE_EXPIRED_TOKENS_DAYS` | 1 (1..30) | decisión del Dev: el enlace dura 1 h y `identifier` guarda un correo |
| `contact_inquiries` | `Contact_Inquiries` | N meses de calendario | `PURGE_CONTACT_MONTHS` | 12 (3..60) | FR-131; auditoría §5.4 (12-24 meses): decisión tuya, §20.8 |
| `anon_carts` | `Carts` con `customerId IS NULL` (+ `Cart_Items` por cascada) | al vencer (`expiresAt`) | (la cookie ya es de 30 d con renovación) | al vencer | FR-131 |
| `anon_wishlists` | `Wishlists` con `customerId IS NULL` (+ `Wishlist_Items`) | al vencer | idem | al vencer | FR-131 |
| `product_daily_stats` | `Product_Daily_Stats` | 180 días | (Epic 18, `STATS_RETENTION_DAYS`) | 180 | se **invoca** `ProductSignalsService.purgeOldStatsBounded`, que es el único código que la borra |
| `retention_runs` | `Retention_Runs` (la historia del propio job) | N días, solo filas terminadas y nunca la de la corrida en curso | `PURGE_RETENTION_RUNS_DAYS` | 400 (90..3650) | decisión del Dev; el registro inmutable es `RETENTION_PURGE_RUN` en `Audit_Events` |
| `usage_logs` | `Usage_Logs` | N días | `PURGE_USAGE_LOG_DAYS` | 7 (1..30, de 20.7) | FR-131/134; se **invoca** `UsageLogPurgeService.purgeExpired` |

Otras variables: `RETENTION_PURGE_ENABLED`, `RETENTION_PURGE_CRON` (`30 4 * * *` UTC; `off` = sin horario), `RETENTION_BATCH_SIZE` (1000; 10..1000), `RETENTION_BATCH_PAUSE_MS` (100), `RETENTION_MAX_RUN_MS` (600000: al agotarse la tarea en curso queda `truncated:true` y el resto sigue en la próxima corrida), `RETENTION_MAX_CLOCK_ADVANCE_HOURS` (72; §20.5). Un valor fuera de rango **impide arrancar** y el mensaje nombra la variable. La expresión del cron se lee de `process.env` al cargar la clase (igual que el cron de FX): expórtala al proceso, no solo en el `.env`.

Aclaraciones que importan para los textos legales:
- «IP y agente a los 90 días de creada la sesión (una sesión todavía activa no se toca)» es **cierto tal como está escrito**, pero rara vez hay algo que anular: una sesión de cliente dura 7 días (renovable, 1 día) y la de admin 8 horas, y la vencida se **elimina** 7 días después, así que `session_pii` solo encuentra una sesión que vivió más de lo normal (una sesión deslizante larga que venció en la última semana, o un barrido retrasado).
- `anon_carts`/`anon_wishlists` no esperan después del vencimiento (más el margen de 1 hora): el texto dice «los registros vencidos se eliminan».

### 20.3 Lo que nunca se borra, y cómo se demuestra

Nunca, ni directa ni por cascada: `Orders` (y la cédula cifrada de la factura, `recipientIdDocEnc`/`buyerIdDocEnc`), `Order_Lines`, `Order_Status_History`, `Order_Tracking_Events`, `Stock_Holds`, `Proof_Of_Payments` (filas **y** archivos en disco), `Consent_Records`, `Audit_Events`, `Audit_Verifications`, `Legal_*`, `Stripe_Webhook_Events`, `Customers`, `Customer_Addresses`, `Customer_Accounts`, `Products`. Cuatro pruebas independientes:

1. **Test estático** (`src/retention/retention-static.spec.ts`): el SQL de todo `src/retention/**`, de `usage-purge.service.ts` y de `purgeOldStatsBounded` solo puede hacer `DELETE FROM` sobre las 10 tablas de la lista, `UPDATE` sobre sesiones y `Retention_Runs`, ningún `INSERT`, ningún `TRUNCATE`/`DROP`/`ALTER`/`DISABLE TRIGGER`/`CASCADE`, ningún delegado de Prisma de una tabla protegida y ninguna escritura por ORM salvo el `create` de la fila de la corrida. (Probado con una mutación: un archivo con `DELETE FROM "Orders"` falla en los dos primeros casos.)
2. **Cierre de claves foráneas y triggers leído del catálogo real** (e2e): partiendo de las 10 tablas purgadas, lo único alcanzable por claves foráneas es `Cart_Items` y `Wishlist_Items` (ambas `ON DELETE CASCADE`), ninguna tabla protegida está en el cierre, y ninguna de ellas tiene triggers. Hoy ninguna otra tabla referencia `Carts`, `Wishlists`, las sesiones, los tokens, `Contact_Inquiries` ni `Usage_Logs`.
3. **Hash por tabla antes y después de una corrida con datos viejos sembrados** (e2e): cuenta y `md5` de todas las filas de 17 tablas protegidas más las filas previas de `Audit_Events`, con un pedido de 800 días, su cédula cifrada, su comprobante y un consentimiento: idénticos. `Audit_Events` solo gana exactamente su evento `RETENTION_PURGE_RUN`.
4. **El rol limitado de la app no puede** `UPDATE`/`DELETE`/`TRUNCATE` `Audit_Events` (20.1) ni `UPDATE` `Usage_Logs` (20.7); el job corre con ese rol en todos los e2e.

**Comprobantes y plazo fiscal:** el job **no toca** `Proof_Of_Payments` ni sus archivos (Out of Scope de la story). No hay variable: no existe tarea que la use. Cuando el contador confirme el plazo (A86: ~10 años), borrar comprobantes vencidos es **una story aparte** que debe tratar filas y archivos juntos; ver §20.8.

### 20.4 Concurrencia, lotes y por qué no compite con un checkout

- **Una sola corrida a la vez:** `pg_try_advisory_lock(2120002)` de **sesión** sobre un `pg.Client` dedicado (nunca el pool de Prisma: un lock de sesión sobre una conexión del pool se filtraría). Si el proceso muere o la conexión cae, Postgres lo suelta; el cliente avisa (`lost()`) y la corrida se detiene en el siguiente lote. Segunda pared: índice único parcial `Retention_Runs_one_running_key`: una segunda fila `RUNNING` es imposible aunque se pierda el lock. Con el lock en la mano, toda fila `RUNNING` es de un proceso muerto y pasa a `FAILED` (`INTERRUPTED`; la story pide 30 min: tener el lock es una prueba mejor que el reloj). Un cron que dispara mientras la corrida anterior sigue **se omite** con un `WARN` (visto en la prueba real: el disparo de las 23:03 se omitió mientras corría el de las 23:02). Dos instancias (dos aplicaciones, dos conexiones) en `Promise.all`: una corre, la otra recibe «busy» sin 5xx (e2e).
- **Lotes:** cada lote es **una sentencia acotada por `LIMIT` en su propia transacción corta**, con `lock_timeout=2s` y `statement_timeout=20s` locales a la transacción (no se filtran al pool), pausa entre lotes y tope de tiempo por corrida (`truncated`). Un fallo de una tarea se registra (clase y código, **nunca el mensaje**) y las demás siguen. Un evento de apagado de la app detiene la corrida en el siguiente lote.
- **Cada tarea, una por una, frente al rol limitado:** las de sesiones, tokens, contactos, carritos, listas y `Retention_Runs` eligen filas con `WITH picked AS (SELECT … LIMIT n FOR UPDATE SKIP LOCKED) DELETE … USING picked`: una fila que otra transacción tiene bloqueada (el borrado de cuenta, un login) **se salta, nunca se espera**, así que no hay cola ni ciclo de espera con un checkout, una fusión o la anonimización. El rol de la app tiene `UPDATE` sobre esas tablas (`db-roles.sql`); si un despliegue lo quitara, la tarea falla visible con `42501`. **`usage_logs` no puede usar `SKIP LOCKED`** (el rol no tiene `UPDATE` sobre `Usage_Logs`; ya lo descubrió la 20.7): borra por `id` y, si una fila está bloqueada por la anonimización, la tarea termina `truncated` tras 2 s.
- **Carritos y la carrera con checkout / fusión al login (revisado contra el código, no supuesto):** todo lo que *usa* un carrito anónimo exige `expiresAt > now` (`addItem` lo renueva solo si no venció; el checkout hace `findFirst … expiresAt > now`; la fusión hace `UPDATE … WHERE customerId IS NULL AND expiresAt > now()`), de modo que un carrito vencido es inalcanzable para los tres; el corte lleva 1 hora de margen (la aplicación decide con su reloj); el carrito de una **cuenta** (`customerId` no nulo) nunca se selecciona, y uno reclamado por un login a mitad de corrida deja de cumplir el `WHERE` (probado con una transacción real que lo reclama). El job no toma el lock de cuenta ni la fila de `Customers`, así que el orden de 20.6a (cliente → advisory del carrito) no interviene, y como no espera filas no puede cerrar un ciclo con él. **No libera stock**: el stock lo retienen los `Stock_Holds` de una orden, que el job no toca (los holds vencidos los libera el cron de 5 minutos de la 5.2).
- **No bloquea el event loop:** todo es asíncrono (`await` por lote), no hay trabajo de CPU; medido abajo.

### 20.5 El reloj

El corte usa el reloj de la **base de datos**, pero una corrida no confía en él a ciegas. `asOf = min(now() de la BD, effectiveNow de la corrida anterior + RETENTION_MAX_CLOCK_ADVANCE_HOURS)` (72 h por omisión). Un salto del reloj hacia delante (WSL2 tras suspender, un paso de NTP erróneo, una máquina restaurada) **no puede adelantar la purga más de 72 horas respecto a la corrida anterior**; un salto hacia atrás solo la hace más cauta. Cada corte lleva además un margen fijo de 1 hora (`SAFETY_MARGIN_MS`, no es un parámetro). Si la BD y la aplicación discrepan más de 5 minutos, la corrida **no purga nada** (`FAILED`, `CLOCK_SKEW`). Costo: tras una caída de más de 72 h la purga se pone al día a 72 h por corrida (sobre-retención unos días, nunca borrado anticipado); la corrida lo anota (`clockClamped` en el evento y `effectiveNow` en la fila). **No está cubierto:** un salto antes de la **primera** corrida (no hay corrida anterior con la que comparar) ni un reloj que ya estuviera adelantado cuando se escribió la fila anterior.

### 20.6 Auditoría: ¿se purga si no se puede auditar? (decisión y por qué)

`AD-99` pide fail-closed para una **acción de negocio**; esto es la caducidad de datos que la Política de Privacidad promete borrar, y lo que cambia son contadores de filas de baja criticidad (nunca pedidos, comprobantes, consentimientos ni la auditoría). **Decisión: se purga igual.** Frenar una caducidad porque la cadena de auditoría esté caída convertiría un incidente de auditoría en un incumplimiento de privacidad, y los lotes ya confirmados no se pueden deshacer de todos modos (AC6). Para que ninguna purga quede sin auditar:

- La corrida cierra su fila y escribe **un** evento `RETENTION_PURGE_RUN` (solo contadores: `runId`, `trigger`, `status`, `startedAt`, `finishedAt`, `clockClamped`, `lateAudit`, y por tarea `name`, `rows`, `durationMs`, `truncated`, `error` como clase+código) en **una** transacción corta (`audit.transaction`/`add`, `UPDATE` de la fila primero, `INSERT` de auditoría al final bajo el lock de cabeza de cadena). Actor: el admin que pulsó, o `SYSTEM` para el cron. Sin PII.
- Si no se puede escribir, la fila se cierra igual (`status` `PARTIAL`, `auditedAt` nulo, `errorSummary` `AUDIT_NOT_WRITTEN…`), se registra el error y **la próxima corrida escribe el evento que falta** (`lateAudit:true`) antes de purgar nada (como máximo 5 por corrida, de los últimos 30 días; en una sola transacción cada uno, `auditedAt` se marca junto con el `INSERT`: nunca dos eventos).
- `Retention_Runs` es una tabla de operación (A105): admite `UPDATE` y `DELETE`. El job poda su propia historia (`retention_runs`, 400 días) con tres condiciones inamovibles en la sentencia: nunca una fila `RUNNING`, nunca una sin terminar, nunca la de la corrida en curso (es el ancla del reloj de la siguiente).
- El POST manual **no acepta ningún parámetro**: un cuerpo con cualquier propiedad (`days`, `olderThan`, `now`, `dryRun`…) es `400` y no pasa nada (`strictBody`); una query string se ignora y no mueve ningún plazo. Los plazos son la configuración del arranque.
- **Dry-run:** la story no lo pide y no se implementó. Nada de lo que se decide en una corrida depende de la entrada de un admin, así que un dry-run solo ahorraría mirar la fila resultante.

### 20.7 Contrato para la Story 20.9 (panel «Retención»)

Todo tras `AdminAuthGuard` (`401 INVALID_ADMIN_TOKEN`). Swagger verificado en `/api/docs-json` (`test/retention.e2e-spec.ts`).

- `POST /admin/retention/run` (sin cuerpo) → `202 {runId}` cuando ya tiene el lock y la fila `RUNNING`; la corrida continúa en segundo plano. `409 RETENTION_ALREADY_RUNNING` (otra corrida, de esta u otra instancia) · `409 RETENTION_DISABLED` (el job está apagado en este entorno) · `400` con cualquier propiedad en el cuerpo.
- `GET /admin/retention/runs?limit=` (1..100, 20 por omisión; otro valor `400`) → `{items:[{id, trigger, triggeredById, startedAt, finishedAt, status, tasks:[{name, rows, durationMs, truncated, error?}], effectiveNow, auditedAt, errorSummary}], limit, running}`; la fila `RUNNING` ya muestra las tareas terminadas.
- `GET /admin/retention/config` → `{enabled, cron, nextRunAt, batchSize, batchPauseMs, maxRunMs, safetyMarginMinutes, maxClockAdvanceHours, periods:{sessionPiiDays, expiredSessionDays, expiredTokenDays, contactMonths, anonymousBasketsAtExpiry, usageLogDays, productDailyStatsDays, retentionRunsDays}, tasks:[…], neverPurged:[…]}`; solo lectura, `nextRunAt` nulo si el cron está apagado.

### 20.8 Decisiones que son de Angel (cada una con su valor por omisión)

1. **Plazo fiscal y comprobantes de Pago Móvil** (`Proof_Of_Payments`, filas y archivos en `uploads/private/`): **no se borra nada** y no hay variable. Hace falta que el contador confirme el plazo (hoy se asume ~10 años, A86, Código de Comercio). Cuando lo haga, una story aparte debe borrar fila y archivo juntos y decidir qué pasa con un archivo huérfano. Mientras tanto la carpeta crece sin límite.
2. **Cédula y datos de facturación** (`Orders`, direcciones de pedido): se conservan cifrados mientras dure el plazo fiscal; anonimizar pedidos antiguos (12-24 meses tras la entrega, auditoría §5.4) queda **fuera** y es decisión tuya y del contador. No hay variable.
3. **Mensajes de contacto:** `PURGE_CONTACT_MONTHS=12` (como quedó en 20.6). La auditoría legal dice 12-24 meses según el contador; si quieres 24, pon la variable y escribe el mismo plazo en `[[PLAZO_CONSERVACION_CONTACTO]]` de `privacidad` §7. El texto y la variable deben decir lo mismo: el sistema no lo comprueba.
4. **`Stripe_Webhook_Events`:** no se purga (puede ser la evidencia de un reembolso o una disputa). Si algún día crece demasiado, define cuánto tiempo hace falta para una disputa (el plazo máximo lo fija Stripe: compruébalo con ellos, no lo sé de memoria) y se hace otra tarea.
5. **Log de uso:** `PURGE_USAGE_LOG_DAYS` admite 1..30 (de 20.7) pero la Política de Privacidad dice **7**: un valor mayor haría falso el texto. Decide si lo acotas a 7 en el código o cambias el texto.
6. **Sesiones:** `PURGE_SESSION_PII_DAYS` está acotada a 30..90 (la story solo pedía el mínimo; el máximo lo añadí para que «90 días» no pueda falsearse). Dime si prefieres el rango abierto.
7. **Reloj:** `RETENTION_MAX_CLOCK_ADVANCE_HOURS=72`. Más alto = pone al día antes tras una caída larga pero un salto de reloj puede adelantar más la purga; más bajo, al revés.
8. **`RETENTION_PURGE_ENABLED`:** por omisión solo en `NODE_ENV=production`. En staging, actívalo a propósito y sobre una base que no sea la tuya de pruebas.
9. **Enlaces de verificación y de reset vencidos:** se borran 1 día después de vencer (`PURGE_EXPIRED_TOKENS_DAYS`). No estaba en el PRD; la story pedía «tokens vencidos» en la petición.
10. **Historia del job:** `PURGE_RETENTION_RUNS_DAYS=400`.
11. **Copias de seguridad:** el job no promete nada sobre ellas (A94): conservan lo borrado hasta su rotación y no se purgan retroactivamente. Si tus copias duran más de lo que dice la Política de Privacidad, el texto debe decirlo.
12. **Otras purgas ya existentes** que no se unificaron: `Fx_Rate_Snapshots` (400 días, cron de FX), corridas de vitrina y `Product_Daily_Stats` a las 03:30, `Tcg_Sync_Runs`. No contienen datos personales.

### 20.9 Lo medido (cifras tal como salieron)

Contenedor `postgres:17-alpine` desechable, rol limitado `collectorsclub_<env>_app`, una sola máquina de desarrollo (WSL2), configuración real del job (lote 1 000, pausa 100 ms).

**`pnpm test:perf test/retention.perf.spec.ts`** (400 000 filas de log, 60 000 sesiones vencidas, 40 000 carritos con 2 líneas, 10 000 contactos): corrida `OK` en 21,6 s (`sessions_expired` 60 000 en 6,5 s; `contact_inquiries` 10 000 en 2,9 s; `anon_carts` 40 000 en 4,9 s; `usage_logs` 87 044 en 9,1 s ⇒ 1 M de filas de log ≈ 104 s). Una transacción de visitante (leer producto + crear carrito + línea + borrar) con el job parado: p50 3,8 ms, p95 5,0 ms, máx. 42,4 ms (n=207); **durante el job**: p50 3,4 ms, p95 4,7 ms, p99 5,3 ms, máx. 10,0 ms (n=1 157). Retraso del event loop durante el job (resolución del histograma 10 ms): media 10,1 ms, p99 10,9 ms, máx. 11,8 ms. Segunda corrida: 0 filas (salvo las 12 que cruzaron el límite de 7 días mientras corría la primera).

**Servidor real** (`node dist/main`, clon de la base de desarrollo con 2,1 millones de filas de log, 300 000 sesiones vencidas, 200 000 carritos vencidos con 400 000 líneas y 50 000 contactos), con 8 visitantes concurrentes que hacen carrito + checkout Pago Móvil sin parar y una sonda `GET /categories`:
- Sin purga (20 s): 2 152 checkouts; carrito p50 8,8 / p95 15,3 / máx. 121,6 ms; checkout p50 13,4 / p95 22,6 / p99 32,9 / máx. 116,9 ms; sonda p99 7,8 ms.
- **Corrida manual** (`POST /admin/retention/run`, 120,3 s, 1 007 428 filas: `sessions_expired` 300 000 en 34,2 s, `contact_inquiries` 50 000 en 5,3 s, `anon_carts` 200 000 en 27,5 s, `usage_logs` 457 428 en 53,2 s ⇒ 1 M de filas de log ≈ 116 s, **muy por debajo de los 5 minutos**; 150 s de carga): 16 358 checkouts, **todos 201**; carrito p50 8,6 / p95 14,7 / máx. 70,5 ms; checkout p50 12,9 / p95 21,5 / p99 28,8 / máx. 261,7 ms; sonda p99 7,5 ms, máx. 261,7 ms. Un segundo `POST` durante la corrida: `409 RETENTION_ALREADY_RUNNING`.
- **Por cron** (cada minuto, 130 s de carga, 100 000 sesiones + 100 000 carritos + 400 000 filas de log viejos): corrida de 71,7 s con 600 801 filas; el disparo del minuto siguiente se **omitió** (el lock estaba tomado); el tercero encontró 325 filas. 12 656 checkouts, **todos 201**; checkout p50 17,5 / p95 32,5 / p99 42,2 / máx. 489,3 ms (+10 ms en p95 frente al reposo con el disco ocupado por los borrados); sonda p99 9,3 ms, máx. 80,1 ms.
- Eventos: 1 `RETENTION_PURGE_RUN` de actor `ADMIN` y 2 de `SYSTEM`; en cada uno `auditedAt` no nulo.

### 20.10 Lo que NO está verificado ni hecho

- **Una purga contra una base con volumen en producción real** (misma topología Nginx/VPS): lo medido es una sola máquina con la base en un contenedor.
- **El salto real del reloj de WSL2:** no pude mover el reloj del sistema; el tope se prueba con filas sembradas (`effectiveNow` 10 días atrás) y con el reloj de la base, no con un salto físico.
- **`pg_try_advisory_lock` a través de un pooler** (pgbouncer en modo transacción) **no funciona** y no se probó: el job necesita una conexión directa (`DATABASE_URL` directa, como ya la usa el resto).
- **Las tablas de pedidos con millones de filas** no se tocan; solo se probaron los hashes con un pedido sembrado, no con el histórico real.
- **Borrado de archivos de comprobantes huérfanos:** no existe.
- **No hay `dry-run`** (la story no lo pide).
- Los textos de la Política de Privacidad con los marcadores `CONFIRMAR_*` de 20.8 **no se editaron** (siguen siendo los de la plantilla): se confirman con la lista de §B de este documento, solo cuando hayas visto una corrida real.

### 20.11 Volver atrás

`RETENTION_PURGE_ENABLED=false` y reiniciar apaga todo (cron y POST manual) sin tocar la base. Lo que se borró no vuelve (las copias de seguridad lo conservan hasta rotar). Para quitar del todo el código: desplegar la versión anterior; la migración es aditiva (columnas nullable, un índice único parcial y siete índices): no hay nada que restaurar, y un `DROP INDEX`/`ALTER TABLE … DROP COLUMN` con el cuidado de 12.3 la deshace si hiciera falta.
