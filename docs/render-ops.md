# Render Deploy — ops note (PriceWatch Service A)

## What runs on Render

**Service A** — the thin HTTP API (`src/service-a.js`).
One web service named `pricewatch-api`.

Workers (Service B, Service C), the daily cron, and the mailer are
**out of scope** for this deploy. The daily cron stays closed.

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

Render's free tier spins down web services after ~15 minutes of
inactivity. The first request after sleep takes 30–60 seconds while the
service cold-starts. This is expected for a development/staging deploy.
Upgrade to a paid instance type for always-on production use.

---

## Blueprint

`render.yaml` at repo root defines the service for Render Blueprints
(Infrastructure as Code). It declares the service name, runtime, build
command, start command, health check path, and environment variable names
(without values — values live in the Render dashboard).

`autoDeploy: false` ensures pushes do not bypass CI.

---

## Security reminders

- **Never** commit secrets (connection strings, API keys, passwords) to git.
- **Never** paste connection strings or secret values into PRs, docs, or chat.
- All secret values belong in the Render dashboard (env vars) or GitHub
  Actions secrets — nowhere else.
- See `docs/neon-ops.md` for Neon credential handling.
