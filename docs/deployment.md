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

Set ownership/permissions so only the matching service user (and root) can
read them: `chown cc212-staging:cc212-staging /opt/212cc/staging/shared/.env && chmod 600 ...` (same pattern for production).

As later stories add PayPal keys, SMTP credentials, etc., they get appended
to these same two files — never committed, never templated into the repo.

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
