#!/usr/bin/env bash
# Cloud daily-cron wrapper for PriceWatch.
#
# Runs the same pipeline as cron-daily-monitor.sh but does NOT source .env —
# the cloud runner (GitHub Actions or Render) injects env vars externally.
#
# Pipeline:  enqueue-daily-ticks.js → run-monitor-worker.js → send-outbox.js
#
# Schedule target: 0 3 * * * UTC
#   = 06:00 Asia/Jerusalem (IDT, summer, UTC+3)
#   = 05:00 Asia/Jerusalem (IST, winter, UTC+2)
#   GitHub may delay scheduled runs by a few minutes — acceptable.
#
# Cloud path: GitHub Actions (.github/workflows/daily-cron.yml).
# Render cron is CANCELLED (paid starter) — do not create.
#
# Kill switch: set PRICEWATCH_KILL=1 or create data/KILL to skip all steps.
# Fail-closed: exits non-zero when DATABASE_URL is missing.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== PriceWatch daily cron — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ── Kill switch ──────────────────────────────────────────────────
if [ -f data/KILL ]; then
  echo "data/KILL file present — cron no-op (exit 0)."
  exit 0
fi
if [ "${PRICEWATCH_KILL:-}" = "1" ]; then
  echo "PRICEWATCH_KILL=1 — cron no-op (exit 0)."
  exit 0
fi

# ── Fail closed: require a database connection string ────────────
if [ -z "${DATABASE_URL:-}" ] && [ -z "${DATABASE_URL_NODE:-}" ]; then
  echo "FATAL: DATABASE_URL or DATABASE_URL_NODE must be set." >&2
  exit 1
fi

# ── Pipeline: enqueue → Service C → send-outbox ─────────────────
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
