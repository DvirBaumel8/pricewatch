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

### Seeded allowlisted Resend proof (dispatch-only)

To force one live Resend delivery through the armed pipeline:

1. Go to **GitHub → Actions → Daily Cron → Run workflow**.
2. Check the **"Seed one allowlisted outbox entry for live Resend proof"**
   checkbox (`seed_allowlisted_proof`).
3. Click **Run workflow**.

This seeds exactly one outbox entry addressed to the pilot recipient
(`PRICEWATCH_TEST_EMAIL` secret) and then the normal pipeline drains it
through the allowlist gate and Resend transport.

**Requirements:**
- `PRICEWATCH_CRON_ARMED` must be `1` (the pipeline must be armed).
- `PRICEWATCH_TEST_EMAIL` must be set (hard-fail if missing).
- `RESEND_API_KEY` and `PRICEWATCH_MAIL_FROM` must be configured.

**Safety:**
- Scheduled runs **never** seed — the seed step only runs on
  `workflow_dispatch` with the input explicitly set to true.
- The default for `seed_allowlisted_proof` is **false** — a plain
  `workflow_dispatch` without checking the box does not seed.
- The seeded entry goes through the normal allowlist gate; if the
  recipient is not allowlisted, `send-outbox.js` blocks it.
- `PRICEWATCH_M1B_UNLOCK` is **not** required and should stay unset.

---

## How cron finds Neon watches (Wave 4 / Hosted watch state)

On the **cloud** path (GitHub Actions), the daily job does **not** read
`data/customers.json`. That file is lab/local fallback only.

### Flow

1. Workflow `.github/workflows/daily-cron.yml` (schedule `0 3 * * *` UTC,
   or `workflow_dispatch`) injects `DATABASE_URL` / `DATABASE_URL_NODE`
   from Actions **secrets** into `bash scripts/render-cron-daily.sh`.
2. Wrapper runs, in order:
   - `node scripts/enqueue-daily-ticks.js`
   - `node scripts/run-monitor-worker.js`
   - `node scripts/send-outbox.js`
3. With a DB URL set, enqueue takes the **Neon path**:
   - `SELECT` from `watch_targets` where `surface = 'b2b'` and
     `status = 'skill_ready'`
   - Claims each watch for the current **Asia/Jerusalem** calendar day
     via `src/neon-ledger.js` into table `daily_ledger`
   - Idempotent: one row per `(watch_target_id, jerusalem_day)`
     (`ON CONFLICT DO NOTHING`)
4. Monitor + mailer drain claimed work and allowlisted outbox as usual.

### Migrations

- Render web start (`scripts/render-start.sh`) runs `node-pg-migrate up`
  (includes `migrations/5_daily_ledger.js`).
- The GHA daily job **does not** run migrations. `daily_ledger` must
  already exist (from a Render start or a manual `npm run migrate:up`).
- Paid Render `type: cron` remains **CANCELLED** — do not create it.

### Arm / unlock (names only)

- Live runs require Actions **variable** `PRICEWATCH_CRON_ARMED=1`.
  Until then the job logs `disarmed — skip` and exits green.
- Keep `PRICEWATCH_M1B_UNLOCK` **unset** until the M1b milestone.
  Do not flip ARM or unlock from docs alone — founder / Mark only.

### Lab fallback

If neither `DATABASE_URL` nor `DATABASE_URL_NODE` is set, enqueue falls
back to scanning `data/customers.json` (local pilot only). Cloud GHA
always injects a DB URL and must stay on the Neon path.

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
