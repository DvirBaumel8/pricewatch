#!/usr/bin/env bash
# PriceWatch pilot daily loop — nohup fallback when no cron.
#
# Runs once per day at the configured hour, then sleeps.
# Launch: nohup bash scripts/pilot-daily-loop.sh >> logs/pilot-daily.log 2>&1 &
#
# Stop: kill the PID, or touch data/KILL, or export PRICEWATCH_KILL=1
#
# Prefer cron (see docs/cron-pilot.md). This script is for machines
# where crontab is unavailable or the user wants a foreground loop.

set -euo pipefail
cd "$(dirname "$0")/.."

# Source .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

SLEEP_SECONDS="${PRICEWATCH_LOOP_INTERVAL:-86400}"

echo "=== PriceWatch pilot-daily-loop started — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "    Sleep interval: ${SLEEP_SECONDS}s"
echo "    Kill switch: touch data/KILL or Ctrl+C"

while true; do
  if [ -f data/KILL ] || [ "${PRICEWATCH_KILL:-}" = "1" ]; then
    echo "[loop] Kill switch active — exiting."
    exit 0
  fi

  echo ""
  echo "[loop] === Run at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  bash scripts/cron-daily-monitor.sh || true
  echo "[loop] Sleeping ${SLEEP_SECONDS}s ..."
  sleep "$SLEEP_SECONDS"
done
