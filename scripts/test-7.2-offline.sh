#!/usr/bin/env bash
set -euo pipefail

# PriceWatch §7.2 — Offline self-test (no external lab required)
# Starts a temporary lab server, runs the full 7.2 sequence, then tears down.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_PORT=0
LAB_PID=""

KEEP_ARTIFACTS="${KEEP_ARTIFACTS:-0}"
for arg in "$@"; do
  case "$arg" in
    --keep-artifacts) KEEP_ARTIFACTS=1 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

cleanup() {
  if [ -n "$LAB_PID" ] && kill -0 "$LAB_PID" 2>/dev/null; then
    kill "$LAB_PID" 2>/dev/null || true
    wait "$LAB_PID" 2>/dev/null || true
  fi
  # Restore original price.json
  if [ -f "$ROOT/lab/price.json.bak" ]; then
    mv "$ROOT/lab/price.json.bak" "$ROOT/lab/price.json"
  fi
  if [ "$KEEP_ARTIFACTS" = "1" ]; then
    echo "  --keep-artifacts: preserving data/skills, data/snapshots, outbox"
  else
    rm -rf "$ROOT/data/skills" "$ROOT/data/snapshots" "$ROOT/outbox"
  fi
}
trap cleanup EXIT

# Back up lab price.json
cp "$ROOT/lab/price.json" "$ROOT/lab/price.json.bak"

# Reset to known state
cat > "$ROOT/lab/price.json" <<'EOF'
{
  "product": "Lab Plan",
  "amount": 29,
  "currency": "USD",
  "period": "month",
  "updated_at": "2026-01-01T00:00:00.000Z"
}
EOF

# Clean generated dirs
rm -rf "$ROOT/data/skills" "$ROOT/data/snapshots" "$ROOT/outbox"

# Find a free port and start lab
LAB_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
PORT=$LAB_PORT node "$ROOT/lab/server.js" &
LAB_PID=$!
sleep 0.5

LAB_URL="http://127.0.0.1:${LAB_PORT}"
echo -e "${BOLD}Offline §7.2 test — lab at ${LAB_URL} (pid $LAB_PID)${RESET}\n"

# Delegate to the main test script
KEEP_ARTIFACTS_ARG=""
if [ "$KEEP_ARTIFACTS" = "1" ]; then
  KEEP_ARTIFACTS_ARG="--keep-artifacts"
fi
KEEP_ARTIFACTS="$KEEP_ARTIFACTS" "$ROOT/scripts/run-7.2.sh" "$LAB_URL" $KEEP_ARTIFACTS_ARG
EXIT_CODE=$?

exit $EXIT_CODE
