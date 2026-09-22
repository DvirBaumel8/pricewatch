#!/usr/bin/env bash
# PriceWatch daily monitor cron stub.
#
# Enqueues ticks for all ready watches, then runs Service C to process them.
# Intended for: crontab, systemd timer, or GitHub Actions schedule.
#
# Example crontab (06:00 Asia/Jerusalem ≈ 03:00 UTC):
#   0 3 * * * cd /path/to/pricewatch && bash scripts/cron-daily-monitor.sh >> logs/cron.log 2>&1
#
# Kill switch: touch data/KILL  or  export PRICEWATCH_KILL=1

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== PriceWatch daily cron — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

node scripts/enqueue-daily-ticks.js
node scripts/run-monitor-worker.js

echo "=== Done ==="
