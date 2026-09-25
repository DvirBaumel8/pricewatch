# Cron setup for PriceWatch

**Owner:** Boris (ops)

## Cloud path: GitHub Actions schedule

The production daily cron runs as a **GitHub Actions** scheduled workflow
(`.github/workflows/daily-cron.yml`), not a Render cron service.

> **CANCELLED — Render cron (paid Starter ~$7/mo): do not create.**
> `render.yaml` is Free API-only. No `type: cron` entry exists or should
> be added. The founder locked the free path; GitHub Actions provides $0
> scheduled runs for public repos.

### Schedule

```
cron: 0 3 * * *   (UTC)
```

- **Summer (IDT, UTC+3):** fires at 06:00 Asia/Jerusalem
- **Winter (IST, UTC+2):** fires at 05:00 Asia/Jerusalem

Israel switches to daylight saving in late March (clocks forward) and
back in late October (clocks back). The UTC cron stays fixed — only the
local wall-clock time shifts by one hour. GitHub may delay scheduled
runs by a few minutes; this is acceptable.

### Disarm / arm

The workflow is **disarmed by default**. When `PRICEWATCH_CRON_ARMED` is
not set to `1`, the job logs `"disarmed — skip"` and exits with a green
check. No enqueue, no monitor, no mail.

**How to arm (founder / Mark):**

1. Go to **GitHub → repo Settings → Secrets and variables → Actions →
   Variables** tab.
2. Click **New repository variable**.
3. Name: `PRICEWATCH_CRON_ARMED` — Value: `1`.
4. Save.

The next scheduled run (or a manual `workflow_dispatch`) will execute the
full pipeline. To disarm again, delete the variable or set it to any
value other than `1`.

### Secrets (GitHub Actions)

Set these in **GitHub → repo Settings → Secrets and variables → Actions →
Secrets** tab. Never put values in git, PRs, or chat.

| Secret | Notes |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (required — fail-closed) |
| `DATABASE_URL_NODE` | Optional node-side Neon URL |
| `PRICEWATCH_KILL` | `1` to kill the pipeline |
| `RESEND_API_KEY` | Resend mail API key |
| `PRICEWATCH_MAIL_FROM` | Resend verified sender |
| `PRICEWATCH_MAIL_REPLY_TO` | Reply-to address |
| `PRICEWATCH_SMTP_PASS` | Gmail SMTP app password |
| `PRICEWATCH_SMTP_HOST` | SMTP host |
| `PRICEWATCH_SMTP_PORT` | SMTP port |
| `PRICEWATCH_SMTP_USER` | SMTP username |
| `PRICEWATCH_SMTP_SECURE` | `1` for implicit TLS |
| `PRICEWATCH_MAIL_TRANSPORT` | Force `resend` or `smtp` |
| `PRICEWATCH_TEST_EMAIL` | Internal test recipient |
| `PRICEWATCH_OPS_EMAIL` | Ops alert recipient |
| `PRICEWATCH_MAIL_ALLOWLIST` | Comma-separated allowlisted recipients (M1b gate) |
| `PRICEWATCH_M1B_UNLOCK` | `1` to bypass allowlist (after M1b milestone) |

### Manual trigger

Use **Actions → Daily Cron → Run workflow** (the `workflow_dispatch`
button) for a one-shot proof run after arming.

---

## Local pilot paths (Boris box — not cloud)

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

## Mail allowlist (M1b gate)

Until M1b unlock, the mailer only sends to recipients on an internal/test
allowlist. Non-allowlisted recipients are skipped (logged, outbox preserved).

| Variable | Notes |
|---|---|
| `PRICEWATCH_MAIL_ALLOWLIST` | Comma-separated extra addresses |
| `PRICEWATCH_M1B_UNLOCK` | Set to `1` after M1b to allow all recipients |

`PRICEWATCH_TEST_EMAIL` and `PRICEWATCH_OPS_EMAIL` are auto-included in the
allowlist — no need to duplicate them.

See `docs/mail-policy.md` for full details and shame-test coverage.

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
