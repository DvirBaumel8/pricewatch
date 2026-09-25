# Render Deploy — ops note (PriceWatch)

## What runs on Render

| Service | Type | In `render.yaml`? | Status |
|---|---|---|---|
| **Service A** — HTTP API | `web` | **Yes** — `pricewatch-api`, `plan: free` | Live Blueprint; safe to apply |
| **Daily cron** — monitor + mailer | `cron` | **No** — snippet in docs only | **Phase B only** — do NOT add to Blueprint until Mark tips Phase B |

Workers (Service B) are **out of scope** for Render at this time.

> **Why is the cron not in `render.yaml`?** Render cron jobs have **no
> free tier** (minimum `plan: starter`, ~$7/month). Including it in the
> Blueprint would create a paid service on every Blueprint apply. The
> YAML snippet lives in this doc (see § "Daily cron service — Phase B")
> and is added to `render.yaml` only when Mark tips Phase B.

---

## Environment variables (Render Dashboard)

Set these in **Render Dashboard → Service → Environment**.
**Never** put secret values in `render.yaml`, in git, or in chat/PRs.

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (from Neon Console → Connection Details) |
| `NODE_ENV` | Set to `production` |

### Recommended

| Variable | Notes |
|---|---|
| `DATABASE_URL_NODE` | Neon URL for migrations if pooler/`channel_binding` causes issues with `node-pg-migrate`. The start script prefers this for `migrate:up` when set. |
| `SERVICE_A_HOST` | The start script sets `0.0.0.0` automatically — only override if needed. |
| `PRICEWATCH_KILL` | Set to `1` to disable enqueue, Service C, and `send-outbox` (mailer). For a Service A-only deploy this does not change behavior since those workers are not running on Render, but setting it documents intent and future-proofs against accidental worker starts. |
| `JWT_SECRET` | HMAC key for session JWTs. **Required** when `AUTH_STUB` is not `1`. |

### Future / optional (not needed for health to pass)

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client id — needed when real OAuth is enabled |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret — **never commit** |
| `GOOGLE_REDIRECT_URI` | OAuth redirect URI (defaults to `postmessage`) |
| `AUTH_STUB` | Set to `1` for stub auth (test only — do not use in production) |
| `RESEND_API_KEY` | Resend mail transport — only when mailer is enabled |
| `PRICEWATCH_SMTP_PASS` | Gmail SMTP app password — only when SMTP mailer is enabled |

### Automatic (set by Render or the start script)

| Variable | Notes |
|---|---|
| `PORT` | Render injects this automatically. The start script maps it to `SERVICE_A_PORT`. |

---

## Start command

Render runs `scripts/render-start.sh`, which:

1. Exports `SERVICE_A_HOST=0.0.0.0` (Render requires binding to all interfaces).
2. Maps Render's `PORT` → `SERVICE_A_PORT` (falls back to `3850`).
3. Runs `node-pg-migrate up` using `DATABASE_URL_NODE` if set, else `DATABASE_URL`.
4. Starts `node src/service-a.js`.

If `DATABASE_URL` (or `DATABASE_URL_NODE`) is missing in production
(`NODE_ENV=production`), the script exits non-zero before starting the
server — fail closed.

### Migrate-on-deploy

Migrations run automatically on every deploy via the start script.
`node-pg-migrate` is idempotent — re-running against an already-migrated
database is a no-op.

If the Neon connection pooler causes `channel_binding` errors with
`node-pg-migrate`, set `DATABASE_URL_NODE` to a URL that works
(e.g. the unpooled/direct Neon endpoint). The start script uses
`DATABASE_URL_NODE` when available, falling back to `DATABASE_URL`.

---

## CD policy — deploy only after green CI

Deploys are triggered by a GitHub Actions workflow
(`.github/workflows/deploy-render.yml`) that runs **only after** the CI
workflow (Test + Lint) succeeds on `main`.

The deploy workflow calls a Render deploy hook URL stored as the GitHub
Actions secret `RENDER_DEPLOY_HOOK`. If the secret is not set, the
deploy step is skipped gracefully — no spam, no failure.

### Setup (one-time, by repo admin)

1. In **Render Dashboard → Service → Settings**, copy the **Deploy Hook** URL.
2. In **GitHub → repo Settings → Secrets and variables → Actions**, create
   a secret named `RENDER_DEPLOY_HOOK` and paste the deploy hook URL.
3. `render.yaml` has `autoDeploy: false` — pushes to `main` do **not**
   trigger Render directly. Deploys happen only through the GitHub Action
   after CI passes.

Until `RENDER_DEPLOY_HOOK` is configured, the CD workflow is present but
inactive. The first deploy can be triggered manually from the Render
dashboard.

---

## Health check

After deploy, verify:

```bash
curl https://<service-name>.onrender.com/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "pricewatch-api",
  "neon": "connected",
  "auth_mode": "google"
}
```

`neon` will show `"connected"` when `DATABASE_URL` is set and reachable,
`"unavailable"` otherwise. `auth_mode` will show `"stub"` when
`AUTH_STUB=1`, `"google"` otherwise.

The Render Blueprint sets `healthCheckPath: /health` so Render will
monitor this endpoint automatically.

---

## Kill switch

Set `PRICEWATCH_KILL=1` in the Render environment to disable:

- `enqueue-daily` (daily tick enqueueing)
- Service C (monitor worker)
- `send-outbox` (mailer)

For a Service A-only Render deploy, these workers are not running on
Render anyway — the kill switch is a safety net that prevents accidental
execution if worker scripts are ever added to the Render service.

---

## Free-tier sleep caveat

`pricewatch-api` is pinned to the **Free** plan (`plan: free` in
`render.yaml`) — 0.1 CPU / 512 MB, $0/mo. Free web services spin down
after ~15 minutes of inactivity; the first request after sleep takes
30–60 seconds while the service cold-starts. This is expected for a
development/staging deploy. Upgrade to a paid instance type for
always-on production use.

### Cron jobs — no Free tier

The daily cron service is **not** in `render.yaml` — Render cron jobs
have no free tier (minimum `plan: starter`, ~$7/month). The cron YAML
snippet is in this doc under § "Daily cron service — Phase B" and must
not be added to the Blueprint until Mark tips Phase B.

---

## Blueprint

`render.yaml` at repo root defines Render services via Blueprints
(Infrastructure as Code). Currently it contains **only** `pricewatch-api`
(`plan: free`). Applying this Blueprint is safe — it creates one free
web service and nothing else.

The daily cron service is intentionally **excluded** from `render.yaml`
to prevent accidental paid-service creation. See § "Daily cron service
— Phase B" below for the ready-to-paste snippet.

`autoDeploy: false` ensures pushes do not bypass CI.

---

## Daily cron service — Phase B

> **⚠ DO NOT add this to `render.yaml` or create this service on Render
> until Mark tips Phase B.** Render cron has **no free tier** — the
> minimum plan is `starter` (~$7/month). Creating it prematurely bills
> the account immediately.

### Overview

`pricewatch-daily-cron` will be a Render **cron** service (`type: cron`)
that runs the daily monitor pipeline: enqueue ticks → Service C →
send-outbox (mailer). It replaces the localhost crontab described in
`docs/cron-pilot.md` for cloud operation.

The wrapper script is `scripts/render-cron-daily.sh`. It is a thin
shell script that:

1. Checks the kill switch (`PRICEWATCH_KILL=1` or `data/KILL`).
2. Fails closed if `DATABASE_URL` / `DATABASE_URL_NODE` is missing.
3. Runs `enqueue-daily-ticks.js`, `run-monitor-worker.js`, and
   `send-outbox.js` in sequence — the same pipeline as the pilot
   cron (`scripts/cron-daily-monitor.sh`), but without sourcing `.env`
   (Render injects env vars via the dashboard).

**0 LLM on this path** — no AI calls in enqueue, Service C, or mailer.

### Schedule (UTC ↔ Jerusalem DST)

The cron expression is `0 3 * * *` — **03:00 UTC every day**.

| Season | Jerusalem offset | Local wall-clock time |
|---|---|---|
| Summer (IDT) | UTC+3 | 06:00 |
| Winter (IST) | UTC+2 | 05:00 |

The UTC cron is fixed; the local time shifts ±1 hour with DST.
Israel DST transitions happen in late March and late October.

### Phase B checklist — before adding cron to Blueprint

1. `pricewatch-api` (Service A) passes health checks on Render.
2. Neon database is reachable from Render.
3. **Mark tips Phase B** explicitly.
4. Paste the YAML snippet below into `render.yaml` under `services:`.
5. Set cron env vars in Render Dashboard (see table below).
6. Blueprint apply or manual create in Render Dashboard.

### Ready-to-paste YAML snippet (Phase B only)

```yaml
  # ── Daily cron: monitor + mailer ─────────────────────────────────
  #
  # Schedule: "0 3 * * *" = every day at 03:00 UTC.
  #   - Summer (IDT, UTC+3): 03:00 UTC = 06:00 local Jerusalem
  #   - Winter (IST, UTC+2): 03:00 UTC = 05:00 local Jerusalem
  # One stable UTC cron; the local wall-clock shifts by ±1 h with DST.
  #
  - type: cron
    name: pricewatch-daily-cron
    runtime: node
    plan: starter
    schedule: "0 3 * * *"
    buildCommand: npm ci
    startCommand: bash scripts/render-cron-daily.sh
    autoDeploy: false
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        sync: false
      - key: DATABASE_URL_NODE
        sync: false
      - key: PRICEWATCH_KILL
        sync: false
      - key: RESEND_API_KEY
        sync: false
      - key: PRICEWATCH_MAIL_TRANSPORT
        sync: false
      - key: PRICEWATCH_MAIL_FROM
        sync: false
      - key: PRICEWATCH_MAIL_REPLY_TO
        sync: false
      - key: PRICEWATCH_SMTP_HOST
        sync: false
      - key: PRICEWATCH_SMTP_PORT
        sync: false
      - key: PRICEWATCH_SMTP_USER
        sync: false
      - key: PRICEWATCH_SMTP_PASS
        sync: false
      - key: PRICEWATCH_MAIL_ALLOWLIST
        sync: false
      - key: PRICEWATCH_OPS_EMAIL
        sync: false
```

### Cron environment variables (Render Dashboard — Phase B)

Set these in **Render Dashboard → Service (`pricewatch-daily-cron`) →
Environment** after creating the service. Never put secret values in
`render.yaml`, git, or chat.

#### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `NODE_ENV` | `production` |

#### Mail transport (at least one credential required for sending)

| Variable | Notes |
|---|---|
| `RESEND_API_KEY` | Resend API key — preferred transport |
| `PRICEWATCH_SMTP_PASS` | Gmail app password — SMTP fallback |
| `PRICEWATCH_MAIL_TRANSPORT` | Force `resend` or `smtp` when both set |
| `PRICEWATCH_MAIL_FROM` | Sender address / display name |
| `PRICEWATCH_MAIL_REPLY_TO` | Reply-To header |
| `PRICEWATCH_SMTP_HOST` | Default `smtp.gmail.com` |
| `PRICEWATCH_SMTP_PORT` | Default `587` (STARTTLS) |
| `PRICEWATCH_SMTP_USER` | Default `price.watcher.service@gmail.com` |

#### Mail policy (Rob — Phase A; code not yet merged)

| Variable | Notes |
|---|---|
| `PRICEWATCH_MAIL_ALLOWLIST` | Comma-separated recipient addresses allowed to receive mail. When set, `send-outbox` skips any recipient not on the list. **Default: locked closed** (no mail sent to non-allowlisted addresses). Rob owns this gate — see assignment. |
| `PRICEWATCH_OPS_EMAIL` | Ops alert recipient (defaults to `MAIL_FROM`) |

#### Kill switch

| Variable | Notes |
|---|---|
| `PRICEWATCH_KILL` | `1` = stop enqueue + Service C + mailer. The cron wrapper exits 0 immediately. |

#### Optional

| Variable | Notes |
|---|---|
| `DATABASE_URL_NODE` | Neon URL for migrations if pooler causes issues |

---

## Security reminders

- **Never** commit secrets (connection strings, API keys, passwords) to git.
- **Never** paste connection strings or secret values into PRs, docs, or chat.
- All secret values belong in the Render dashboard (env vars) or GitHub
  Actions secrets — nowhere else.
- See `docs/neon-ops.md` for Neon credential handling.
