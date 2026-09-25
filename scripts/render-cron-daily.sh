#!/usr/bin/env bash
# Render cron wrapper for the PriceWatch daily monitor pipeline.
#
# Runs the same steps as scripts/cron-daily-monitor.sh but with
# fail-closed guards appropriate for a cloud cron service:
#   1. Requires DATABASE_URL (or DATABASE_URL_NODE) — exits non-zero if missing.
#   2. Respects PRICEWATCH_KILL=1 — exits 0 immediately (no work done).
#   3. Does NOT source .env (Render injects env vars via its dashboard).
#
# Schedule (set in render.yaml): 03:00 UTC daily.
#   - Summer (IDT, UTC+3): 03:00 UTC = 06:00 Jerusalem
#   - Winter (IST, UTC+2): 03:00 UTC = 05:00 Jerusalem
#
# ⚠  DISARMED until Phase B — do not create this service on Render
#    until Mark tips Phase B and pricewatch-api passes health checks.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== PriceWatch Render daily cron — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ── Kill switch ────────────────────────────────────────────────────
if [ "${PRICEWATCH_KILL:-}" = "1" ]; then
  echo "PRICEWATCH_KILL is set — cron no-op (exit 0)."
  exit 0
fi

if [ -f data/KILL ]; then
  echo "data/KILL file present — cron no-op (exit 0)."
  exit 0
fi

# ── Fail closed: require a database connection string ──────────────
if [ -z "${DATABASE_URL:-}" ] && [ -z "${DATABASE_URL_NODE:-}" ]; then
  echo "FATAL: DATABASE_URL or DATABASE_URL_NODE must be set." >&2
  echo "Set the variable in Render Dashboard → Environment." >&2
  exit 1
fi

# ── Pipeline: enqueue → Service C → send-outbox ───────────────────
mkdir -p logs

echo "--- enqueue-daily-ticks ---"
node scripts/enqueue-daily-ticks.js

echo "--- run-monitor-worker (Service C) ---"
node scripts/run-monitor-worker.js

if [ -f scripts/send-outbox.js ]; then
  echo "--- send-outbox ---"
  node scripts/send-outbox.js || true
fi

echo "=== Done ==="
