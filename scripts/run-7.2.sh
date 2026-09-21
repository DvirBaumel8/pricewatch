#!/usr/bin/env bash
set -euo pipefail

# PriceWatch §7.2 — Controlled system test (happy path)
#
# Prerequisites: lab server running at LAB_URL (default http://127.0.0.1:3847)
# Usage:   ./scripts/run-7.2.sh [lab_url]

LAB_URL="${1:-http://127.0.0.1:3847}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="main monthly price"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${RESET}: $1"; }
fail() { echo -e "${RED}✗ FAIL${RESET}: $1"; exit 1; }
step() { echo -e "\n${BOLD}── $1${RESET}"; }

cleanup() {
  step "Cleanup: resetting lab price to 29"
  curl -sf -X POST "${LAB_URL}/set-price" \
    -H 'Content-Type: application/json' \
    -d '{"amount":29}' > /dev/null || echo "  (lab not reachable for reset)"

  rm -rf "$ROOT/data/skills" "$ROOT/data/snapshots" "$ROOT/outbox"
}
trap cleanup EXIT

# Clean state
rm -rf "$ROOT/data/skills" "$ROOT/data/snapshots" "$ROOT/outbox"

# ── Step 1: Verify lab is reachable ──────────────────────────────────────────
step "Step 0: Verify lab is reachable"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "${LAB_URL}/price.json" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  fail "Lab server not reachable at ${LAB_URL} (HTTP $HTTP_CODE). Start it: node lab/server.js"
fi
pass "Lab reachable at ${LAB_URL}"

# ── Step 1: Discover ─────────────────────────────────────────────────────────
step "Step 1: Discover skill"
DISCOVER_OUT=$(node "$ROOT/src/discover.js" "$LAB_URL" "$TARGET" 2>&1)
echo "$DISCOVER_OUT"

SKILL_ID=$(echo "$DISCOVER_OUT" | grep "Skill ID:" | awk '{print $NF}')
if [ -z "$SKILL_ID" ]; then
  fail "Discovery did not produce a skill ID"
fi

SKILL_FILE="$ROOT/data/skills/${SKILL_ID}.json"
if [ ! -f "$SKILL_FILE" ]; then
  fail "Skill file not found: $SKILL_FILE"
fi
pass "Skill created: $SKILL_ID"

# ── Step 2: Monitor (no change expected) ─────────────────────────────────────
step "Step 2: First monitor run (price unchanged)"
MONITOR_OUT=$(node "$ROOT/src/monitor.js" "$SKILL_ID" 2>&1)
echo "$MONITOR_OUT"

count_outbox() { find "$ROOT/outbox" -name 'price-change_*' 2>/dev/null | wc -l; }
OUTBOX_COUNT=$(count_outbox || true)
if [ "$OUTBOX_COUNT" -ne 0 ]; then
  fail "Expected 0 emails in outbox on first run, found $OUTBOX_COUNT"
fi
pass "No email sent (first run baseline)"

# ── Step 2b: Monitor again (still unchanged) ────────────────────────────────
step "Step 2b: Second monitor run (price still unchanged)"
MONITOR_OUT=$(node "$ROOT/src/monitor.js" "$SKILL_ID" 2>&1)
echo "$MONITOR_OUT"

OUTBOX_COUNT=$(count_outbox || true)
if [ "$OUTBOX_COUNT" -ne 0 ]; then
  fail "Expected 0 emails after repeated check with no change, found $OUTBOX_COUNT"
fi
pass "No email sent (price unchanged)"

# ── Step 3: Change lab price ─────────────────────────────────────────────────
step "Step 3: Change lab price to \$39"
curl -sf -X POST "${LAB_URL}/set-price" \
  -H 'Content-Type: application/json' \
  -d '{"amount":39}' > /dev/null
pass "Lab price set to 39"

# ── Step 4: Monitor (change expected) ────────────────────────────────────────
step "Step 4: Monitor after price change"
MONITOR_OUT=$(node "$ROOT/src/monitor.js" "$SKILL_ID" 2>&1)
echo "$MONITOR_OUT"

OUTBOX_COUNT=$(count_outbox || true)
if [ "$OUTBOX_COUNT" -ne 1 ]; then
  fail "Expected exactly 1 email after price change, found $OUTBOX_COUNT"
fi

EMAIL_FILE=$(find "$ROOT/outbox" -name 'price-change_*' 2>/dev/null | head -1)
BEFORE_AMOUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$EMAIL_FILE','utf8')).before.amount)")
AFTER_AMOUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$EMAIL_FILE','utf8')).after.amount)")

if [ "$BEFORE_AMOUNT" != "29" ] || [ "$AFTER_AMOUNT" != "39" ]; then
  fail "Email amounts wrong: before=$BEFORE_AMOUNT after=$AFTER_AMOUNT (expected 29→39)"
fi
pass "Exactly 1 email with correct before/after (29→39)"

echo ""
echo "$MONITOR_OUT" | grep -q "PRICE CHANGED" && pass "Monitor logged PRICE CHANGED" || fail "Monitor did not log PRICE CHANGED"

# ── Summary ──────────────────────────────────────────────────────────────────
step "Summary"
echo -e "${GREEN}${BOLD}All §7.2 acceptance checks passed.${RESET}"
echo ""
echo "  Skill:    $SKILL_FILE"
echo "  Snapshot: $ROOT/data/snapshots/${SKILL_ID}.json"
echo "  Email:    $EMAIL_FILE"
echo "  LLM tokens used: 0"
