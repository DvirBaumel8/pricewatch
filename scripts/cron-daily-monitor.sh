#!/usr/bin/env bash
# PriceWatch daily monitor cron stub.
#
# Enqueues ticks for all ready watches, then runs Service C to process them,
# then drains the outbox via send-outbox.js (real email delivery).
#
# Intended for: crontab, systemd timer, or GitHub Actions schedule.
#
# Example crontab (06:00 Asia/Jerusalem ≈ 03:00 UTC):
#   0 3 * * * cd /path/to/pricewatch && bash scripts/cron-daily-monitor.sh >> logs/cron-daily.log 2>&1
#
# Kill switch: touch data/KILL  or  export PRICEWATCH_KILL=1

set -euo pipefail
cd "$(dirname "$0")/.."

# Source .env if present (Boris box convention)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "=== PriceWatch daily cron — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

mkdir -p logs

node scripts/enqueue-daily-ticks.js
node scripts/run-monitor-worker.js

# Drain outbox → real email (no-op if no credentials)
if [ -f scripts/send-outbox.js ]; then
  echo "--- send-outbox ---"
  node scripts/send-outbox.js || true
fi

echo "=== Done ==="
