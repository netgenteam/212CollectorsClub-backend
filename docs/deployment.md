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

### 9.4 Deployment requirement: `X-Forwarded-For` (rate limit by IP)

The simulator limit is per client IP. `main.ts` sets `trust proxy 1`, so Express takes the **right-most** entry of `X-Forwarded-For`. This is only correct if:

- **Only Nginx can reach the backend and the Next server** (both bound to 127.0.0.1 / blocked by the firewall; never expose 3000/3001).
- Nginx sets the header with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` on every `location` proxying to Next **and** to the backend (already so in the two backend templates `deploy/nginx/api.conf.template` and `staging-api.conf.template`; the Next server block has no template, see 11.3; do not replace it with `$remote_addr` alone, nor pass a client-supplied value through).
- The Next proxy route forwards the incoming `X-Forwarded-For` to the backend (it appends nothing). The backend then sees the entry Nginx added.

Checklist: (1) `curl -s -H 'X-Forwarded-For: 1.2.3.4' https://<DOMAIN>/api/...` from outside must not let you choose your own throttle key (the right-most entry is the real address Nginx appended); (2) 31 requests/min to `POST /simulator/packs` from one address get a 429, a second address is unaffected; (3) the backend log/throttle never shows the Next server's IP for every client.

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

- **Nginx must be the only access** to the backend and to the Next server (both on loopback, ports 3000/3001 closed in the firewall; section 1.8). `main.ts` sets `trust proxy 1`, so Express uses the right-most `X-Forwarded-For` entry, i.e. the one Nginx appended.
- Nginx must set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` on every `location` that proxies to Next and to the backend (already in both backend templates, `deploy/nginx/api.conf.template` and `staging-api.conf.template`, which only proxy the **backend**; there is **no template for the Next server**, so the operator must write that server block/`location` for the storefront and set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and a `proxy_read_timeout` there). Never replace it with `$remote_addr` alone and never pass a client-supplied header through. Same rule as 9.4.
- The frontend (`212CollectorsClub-frontend`) must have `BACKEND_API_URL` pointing at the backend on **loopback** (e.g. `http://127.0.0.1:3000/api/v1` for production). If it points at the public URL (`https://api.<domain>/...`) the Next server calls the backend through Nginx and every view arrives with the IP of the Next server: all visits collapse into one IP, the dedupe and the rate limit swallow almost everything and the "interest" signal is under-counted without any error. The frontend proxy forwards the visitor's `X-Forwarded-For`.
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

- **Solo una migración depende de esa línea:** `20261103100000_add_consent_records` (`grep -rn lock_timeout prisma/migrations`). Ya está aplicada en desarrollo y su checksum no puede cambiar, así que se dejó como está: en una base donde siga pendiente, **no** acota la espera.
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
- **Migraciones nuevas:** empieza cualquier DDL sobre una tabla caliente (`Orders`, `Products`, `Order_Items`...) con `SET lock_timeout = '10s';` de sesión (no `SET LOCAL`).
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
- [ ] `CONFIRMAR_BORRADO_DE_SESIONES_VENCIDAS_IMPLEMENTADO` y `CONFIRMAR_BORRADO_DE_CARRITOS_Y_LISTAS_ANONIMOS_VENCIDOS_IMPLEMENTADO` (20.8): el job de retención de 20.8 todavía no existe; `privacidad` §7 debe alinearse con 20.8 (sesión vencida se elimina a los 7 días; IP y agente se anulan a los 90 días).

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

### 13.2 Migraciones (dos, aditivas)

`20261104100000_add_audit_events` (tablas nuevas, no toca ninguna tabla existente) y `20261104200000_legal_revision_never_decreases` (dos triggers sobre `Legal_Drafts` y `Legal_Documents`). Cada una empieza con `BEGIN;` y termina con `COMMIT;`: si una sentencia falla no queda nada a medias (regla de 12.3). La segunda toma un lock sobre dos tablas existentes y empieza con `SET LOCAL lock_timeout = '10s'` **dentro** del `BEGIN`.

Verificado sobre un clon (Postgres 17): con otra sesión reteniendo un lock sobre `Legal_Drafts`, `prisma migrate deploy` falló a los 11 s; la primera migración quedó aplicada, de la segunda **no quedó ninguna función ni trigger**, Prisma dijo `current transaction is aborted` (el texto que `deploy.sh` ya reconoce, 12.3), y bastó `pnpm prisma migrate resolve --rolled-back 20261104200000_legal_revision_never_decreases` + volver a desplegar. Esta vez, a diferencia de la línea de 12.2, **el `SET LOCAL` sí funciona** porque está dentro de un `BEGIN`/`COMMIT` escrito en el propio archivo.

Una rareza inofensiva: `prisma migrate diff` propone `ALTER COLUMN "ip" SET DATA TYPE inet` para `Audit_Events` en cada ejecución (limitación de Prisma con columnas `Unsupported`; no cambia nada). No generes una migración a partir de eso.

Si en la BD ya hay roles que no son superusuario (p. ej. `qa_app`), la migración les quita `UPDATE/DELETE/TRUNCATE` sobre `Audit_Events` (tabla nueva): no modifica los roles.

### 13.3 El paso que tienes que hacer tú: el rol de BD limitado (A90)

**Por qué.** Hoy la app corre como `collectorsclub`, que es superusuario y propietario: con ese rol cualquier fallo de la app (o una inyección SQL) podría hacer `ALTER TABLE ... DISABLE TRIGGER` y reescribir el log. Con un rol que no es propietario ni superusuario eso es imposible: no puede ejecutar DDL, ni desactivar triggers, ni `UPDATE/DELETE/TRUNCATE` sobre `Audit_Events`. Las migraciones y `deploy.sh` siguen con el propietario.

**Qué hace `pnpm db:roles`.** Crea (o actualiza, es idempotente) `collectorsclub_<entorno>_app`: `LOGIN`, sin `SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS`, no propietario de nada. Le da `CONNECT`, `USAGE` sobre `public`, `SELECT/INSERT/UPDATE/DELETE` sobre todas las tablas y `USAGE/SELECT` sobre las secuencias, **y `ALTER DEFAULT PRIVILEGES` para que las tablas que creen las migraciones futuras (las ejecuta el propietario) queden accesibles sin ningún `GRANT` manual**. Después le quita `UPDATE/DELETE/TRUNCATE` sobre `Audit_Events` y todo sobre `_prisma_migrations`. Si creas la tabla de otra manera que no sea una migración del propietario, vuelve a ejecutarlo.

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
6. Vuelve a ejecutar `pnpm db:roles` (sin contraseña, para no rotarla) tras restaurar una copia de seguridad o si alguna vez creas tablas sin pasar por una migración del propietario.

Limitaciones que conviene saber: (a) las migraciones deben ejecutarlas **siempre el mismo propietario** que ejecutó `pnpm db:roles` (los privilegios por defecto son «para las tablas de ese rol»); (b) en PostgreSQL anterior al 15 el esquema `public` deja crear objetos a cualquiera: si tu servidor es antiguo, valora `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; (c) el propietario o un superusuario **sí pueden** desactivar los triggers y reescribir la cadena entera: la defensa es el anclaje externo (13.5).

### 13.4 Variables de entorno (todas opcionales; ver `.env.example`)

| Variable | Por defecto | Para qué |
|---|---|---|
| `MIGRATE_DATABASE_URL` | = `DATABASE_URL` | URL del propietario para `prisma migrate`, `deploy.sh` y `pnpm db:roles`. |
| `AUDIT_VERIFY_CRON` | `0 5 * * 0` (UTC) | Verificación semanal. Como la del FX, se lee del entorno del proceso al arrancar: expórtala (systemd `EnvironmentFile`), no basta con el `.env` de dev. |
| `AUDIT_VERIFY_CRON_MODE` | `full` | `full` recalcula toda la cadena cada vez; `incremental` solo lo posterior a la última verificación OK. **Deja `full`**: un incremental confía en las filas anteriores a su ancla y no vería que alguien cambió el contenido de una fila vieja sin tocar su hash. Solo si la cadena llega a millones de filas. |
| `AUDIT_VERIFY_ENABLED` | `true` (`false` con `NODE_ENV=test`) | Apaga el job. |
| `AUDIT_ANCHOR_EMAIL` | sin definir | Tras cada ejecución semanal se envía `seq` + `hash` de la cabeza por el `Mailer`. Un fallo de correo solo queda en el log. |
| `DB_ROLES_ENV`, `APP_DB_PASSWORD` | sin definir | Solo para `pnpm db:roles`; no los dejes en el `.env` del servicio. |

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
- **Con el rol limitado, sobre un clon:** servidor real arrancado con `collectorsclub_d201_app` (`node dist/main`): login admin, `GET head`, `POST verify` (cadena sana: `ok`; tras alterar una fila como propietario: `ok: false`, `brokenAt {seq, reason: HASH_MISMATCH, expected, found}`; tras restaurarla: `ok` otra vez), `GET verifications` (`chainBroken: true` mientras la última verificación esté rota), un registro (201) y un checkout con Pago Móvil (201). La suite e2e completa pasó con ese rol salvo `related-products` (preexistente) y los ajustes de test descritos en 13.3.

### 13.7 Lo que NO está verificado

- Nada de esto se ha ejecutado en un VPS real (ni `deploy.sh` con `MIGRATE_DATABASE_URL`, ni `pnpm db:roles` contra el Postgres del servidor, ni el correo de anclaje con un SMTP real). Se probó sobre una instancia desechable de Postgres 17 con una copia de la base de desarrollo.
- `docker-compose.yml` con `deploy/db/init-roles.sql` se probó solo en un contenedor desechable nuevo; el volumen de Angel ya existe y no ejecuta ese script.
- Medidas hechas en `localhost` con cliente y servidor en la misma máquina: en una red real el lock se mantiene unos milisegundos más por viaje (unos 5 viajes a la BD dentro de la sección serializada).
- La Story 20.1 no emite eventos de negocio: lo que pasaría con el lock en un checkout real se midió con transacciones sintéticas con la misma forma.
- El rol con `DB_ROLES_ENV=dev` en el volumen real de Angel no se ha creado (se hizo en la instancia desechable); el paso 1 de 13.3 es suyo.

### 13.8 Volver atrás

Las tablas y triggers nuevos son inertes para la versión anterior del código: despliega la anterior y deja las migraciones aplicadas. `Audit_Events` no se puede vaciar por diseño (solo el propietario puede `DROP TABLE`, y no se debe). Para volver al rol único, quita `MIGRATE_DATABASE_URL` y pon en `DATABASE_URL` la del propietario; el rol limitado puede quedarse sin efecto, o eliminarse con `DROP OWNED BY collectorsclub_<entorno>_app; DROP ROLE collectorsclub_<entorno>_app;`.
