# T4 — Service C: Daily Monitor + Emails

How to run Service C, the daily cron pipeline, kill switch, and acceptance tests.

## Architecture

```
Cron / Manual
    │
    ├─ scripts/enqueue-daily-ticks.js   (npm run enqueue-daily)
    │    → scans data/customers.json for skill_ready competitors
    │    → enqueues pending ticks into data/monitor-ticks.json
    │    → idempotent: one tick per (customer, skill, Jerusalem calendar day)
    │
    └─ scripts/run-monitor-worker.js    (npm run service-c)
         → consumes pending ticks from data/monitor-ticks.json
         → loads skill, fetches pricing URL, extracts price
         → compares with last snapshot (data/snapshots/)
         → unchanged: no email, updates snapshot
         → changed:   writes price_change to outbox/ (customer-facing)
         → failure:   writes ops_alert to outbox/ (ops-facing, not customer)
         → 0 LLM tokens on lab happy path
```

## Prerequisites

- Node.js 18+
- Lab server running (`node lab/server.js`)
- Service A running (`node src/service-a.js`) for onboarding
- At least one customer with a `skill_ready` competitor (via A + B pipeline)

## Quick Start

### 1. Start lab + Service A (if not already running)

```bash
node lab/server.js &          # http://127.0.0.1:3847/
node src/service-a.js &       # http://127.0.0.1:3850/
```

### 2. Onboard a customer (A → B pipeline)

```bash
# Create customer
curl -s -X POST http://127.0.0.1:3850/customers \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Company", "email": "me@example.com"}'

# Add competitor (use customer id from above)
curl -s -X POST http://127.0.0.1:3850/customers/<CUSTOMER_ID>/competitors \
  -H 'Content-Type: application/json' \
  -d '{"name": "Acme Lab", "pricing_url": "http://127.0.0.1:3847/", "target_price_description": "main monthly price"}'

# Run Service B to discover skill
npm run service-b
```

### 3. Run daily monitor (Service C)

```bash
# Enqueue ticks for today
npm run enqueue-daily

# Process all pending ticks
npm run service-c
```

Or use the combined cron script:

```bash
bash scripts/cron-daily-monitor.sh
```

### 4. Check results

```bash
# Monitor tick queue
cat data/monitor-ticks.json | jq .

# Price change emails (customer-facing)
ls outbox/price-change_* 2>/dev/null

# Ops alerts (ops-facing)
ls outbox/ops-alert_* 2>/dev/null

# Snapshots
ls data/snapshots/
```

## Data Files

| File | Purpose |
|------|---------|
| `data/monitor-ticks.json` | Durable queue for pendingMonitorTicks |
| `data/snapshots/*.json` | Last-known price snapshot per skill |
| `outbox/price-change_*.json` | Customer-facing price change emails (file sink) |
| `outbox/ops-alert_*.json` | Ops alerts for failures/blocked watches |
| `data/KILL` | Kill switch file (touch to disable all monitoring) |
| `data/customers.json` | Customer + competitor records (from A/B) |
| `data/skills/*.json` | Discovered pricing skills (from B) |

## Kill Switch

Two methods, either stops all monitoring:

```bash
# File-based kill switch
touch data/KILL

# Environment variable kill switch
export PRICEWATCH_KILL=1
```

Both `enqueue-daily-ticks.js` and `run-monitor-worker.js` check the kill switch.
To re-enable monitoring:

```bash
rm data/KILL
# or unset PRICEWATCH_KILL
```

## Cron Setup (for Boris)

### Option A: crontab

```bash
# Run daily at 06:00 Asia/Jerusalem (≈ 03:00 UTC)
0 3 * * * cd /path/to/pricewatch && bash scripts/cron-daily-monitor.sh >> logs/cron.log 2>&1
```

### Option B: GitHub Actions (docs only — no paid infra)

```yaml
# .github/workflows/daily-monitor.yml
name: Daily Price Monitor
on:
  schedule:
    - cron: '0 3 * * *'  # 03:00 UTC ≈ 06:00 Jerusalem
jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: bash scripts/cron-daily-monitor.sh
```

## Scripts Reference

| Script | npm script | Description |
|--------|-----------|-------------|
| `scripts/enqueue-daily-ticks.js` | `npm run enqueue-daily` | Enqueue ticks for all ready watches |
| `scripts/run-monitor-worker.js` | `npm run service-c` | Process all pending ticks |
| `scripts/run-monitor-worker.js --watch` | `npm run service-c:watch` | Poll mode for ticks |
| `scripts/cron-daily-monitor.sh` | — | Combined enqueue + service-c |

## Source Modules

| Module | Purpose |
|--------|---------|
| `src/monitor-queue.js` | Durable queue for pendingMonitorTicks |
| `src/monitor-lib.js` | Monitor check library (extract, snapshot, diff, email/ops) |

## Running Tests

### Acceptance tests (§7.11–7.14)

Requires lab + Service A running:

```bash
# Terminal 1: lab
node lab/server.js

# Terminal 2: Service A
node src/service-a.js

# Terminal 3: run acceptance
npm run test:e2e:c
```

### What the tests prove

| Test | Section | What it proves |
|------|---------|---------------|
| Due watches + enqueue | §7.11 | Ready skill → 1 pending tick; idempotent (no duplicates) |
| No false email | §7.12 | Unchanged price → 0 price_change outbox files; 0 LLM |
| Change → one email | §7.13 | Price change → exactly 1 price_change with correct before/after + customer id/email |
| Ops on failure | §7.14a | Broken watch → ops_alert, no false price_change |
| Kill switch (file) | §7.14b | data/KILL → enqueue no-ops, Service C no-ops |
| Kill switch (env) | §7.14b | PRICEWATCH_KILL=1 → Service C no-ops |

## Email Sink

For MVP, all emails are written as JSON files to `outbox/`:
- `outbox/price-change_<skillId>_<timestamp>.json` — customer-facing
- `outbox/ops-alert_<skillId>_<timestamp>.json` — ops-facing

Each `price_change` file includes `customer_id`, `customer_email`, and `customer_name`
fields for downstream SMTP/Resend integration (out of scope for this slice).

No real email provider is required for PASS — file sink is sufficient.
