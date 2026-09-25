# Cron setup for PriceWatch

**Owner:** Boris (ops)

## Cloud vs pilot — which path?

| Path | Where | Script | Env source | Status |
|---|---|---|---|---|
| **Cloud (Render cron)** | Render platform | `scripts/render-cron-daily.sh` | Render Dashboard env vars | **Phase B only** — not in `render.yaml`; see `docs/render-ops.md` |
| **Pilot (localhost)** | Boris's box | `scripts/cron-daily-monitor.sh` | `.env` file (sourced by script) | Active for local testing |

Both paths run the same pipeline: `enqueue-daily-ticks.js` →
`run-monitor-worker.js` → `send-outbox.js`. The cloud wrapper does
**not** source `.env` (Render injects vars); the pilot wrapper does.

> **⚠ The cloud cron is NOT in `render.yaml`.** Render cron has no free
> tier (minimum `plan: starter`, ~$7/month). The YAML snippet is kept in
> `docs/render-ops.md` § "Daily cron service — Phase B" and must only be
> added to `render.yaml` when Mark tips Phase B and `pricewatch-api`
> passes health checks.

---

## Pilot path (localhost)

### Prerequisites

1. Node.js 18+ on the pilot box
2. Repo cloned / pulled to latest
3. `.env` populated from `.env.example` (see below)

### Environment

Copy `.env.example` to `.env` and fill in credentials:

```bash
cp .env.example .env
# edit .env — set RESEND_API_KEY (preferred) or PRICEWATCH_SMTP_PASS
```

Key vars the cron scripts source from `.env`:

| Variable | Required | Default | Notes |
|---|---|---|---|
| **Transport selection** | | | |
| `RESEND_API_KEY` | **yes** (or `SMTP_PASS`) | — | Preferred transport; never commit |
| `PRICEWATCH_MAIL_TRANSPORT` | no | auto (Resend if key set) | Force `resend` or `smtp` when both configured |
| **Resend sender** | | | |
| `PRICEWATCH_MAIL_FROM` | no | `PriceWatch <onboarding@resend.dev>` | Must be Resend-verified sender |
| `PRICEWATCH_MAIL_REPLY_TO` | no | `price.watcher.service@gmail.com` | Boris alias: `PRICEWATCH_REPLY_TO` also accepted |
| **SMTP fallback** | | | |
| `PRICEWATCH_SMTP_PASS` | alt | — | Gmail app password; never commit |
| `PRICEWATCH_SMTP_HOST` | no | `smtp.gmail.com` | |
| `PRICEWATCH_SMTP_PORT` | no | `587` | STARTTLS; use 465 + `SMTP_SECURE=1` for implicit TLS |
| `PRICEWATCH_SMTP_SECURE` | no | unset (STARTTLS) | Set `1` only if using port 465 |
| `PRICEWATCH_SMTP_USER` | no | `price.watcher.service@gmail.com` | |

### Option A: crontab (preferred)

```bash
# 06:00 Asia/Jerusalem ≈ 03:00 UTC
crontab -e
# add:
0 3 * * * cd /path/to/pricewatch && bash scripts/cron-daily-monitor.sh >> logs/cron-daily.log 2>&1
```

The cron script:
1. Sources `.env`
2. Runs `enqueue-daily-ticks.js` (idempotent per Jerusalem calendar day)
3. Runs `run-monitor-worker.js` (Service C — processes ticks)
4. Runs `send-outbox.js` (drains outbox → real email; no-op if no creds)

### Option B: nohup loop (no cron)

```bash
mkdir -p logs
nohup bash scripts/pilot-daily-loop.sh >> logs/pilot-daily.log 2>&1 &
echo $! > logs/pilot-daily.pid
```

Stop: `kill $(cat logs/pilot-daily.pid)` or `touch data/KILL`.

## Kill switch

- `touch data/KILL` — stops enqueue, Service C, and mailer
- `export PRICEWATCH_KILL=1` — same effect via env
- Remove file / unset var to resume

## Logs

- `logs/cron-daily.log` — cron output
- `logs/pilot-daily.log` — nohup loop output
- `outbox/*.json` — audit trail (kept after send)
- `outbox/*.json.sent` — send receipts (idempotency markers)

## Mailer exit codes

| Code | Meaning |
|---|---|
| 0 | Success (or nothing to send) |
| 1 | Send error (some emails failed) |
| 7 | No mail credentials configured |
