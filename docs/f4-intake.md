# F4 — Intake Preview + Confirm APIs (CB-13/14)

## Overview

F4 adds B2B intake for competitor plans and prices monitoring.
A user pastes a competitor's pricing page URL, previews the
extracted plans and prices, selects which plan(s) to watch,
and confirms. The system creates WatchTarget(s) + skill +
baseline snapshot. No customer email is sent on first learn.

## Routes

| Method | Path | Auth | Notify gate | Description |
|---|---|---|---|---|
| POST | `/b2b/intake/preview` | No | No | Extract candidate plans from URL |
| POST | `/b2b/intake/confirm` | JWT | Yes | Create watch(es) for selected plans |
| POST | `/b2b/intake/selector` | JWT | — | Stub 501 (click-select fallback TODO) |
| POST | `/b2b/intake/manual-seed` | JWT | — | Stub 501 (manual entry fallback TODO) |

## Preview

```
POST /b2b/intake/preview
Content-Type: application/json

{
  "url": "http://127.0.0.1:3847/pricing",
  "intent_text": "Pro"           // optional — ranks/sorts only
}
```

Response (200):

```json
{
  "candidates": [
    {
      "plan_key": "pro",
      "name": "Pro",
      "price": 49,
      "currency": "USD",
      "period": "month"
    },
    {
      "plan_key": "free",
      "name": "Free",
      "price": 0,
      "currency": "USD",
      "period": "month"
    }
  ],
  "url": "http://127.0.0.1:3847/pricing",
  "site": "lab-multiplan",
  "method": "dom",
  "tokens": 0
}
```

**Rules:**
- `url` is required (400 if missing)
- `intent_text` only reorders candidates — never invents prices
- Non-allowlisted URLs → 422 `unsupported_site`
- Blocked/empty page → honest error (502 or 422)
- Returns structured `candidates[]`, never raw HTML
- 0 LLM tokens

## Confirm

```
POST /b2b/intake/confirm
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "url": "http://127.0.0.1:3847/pricing",
  "selected": [{ "plan_key": "pro" }],
  "customer_id": "<customer-id>"
}
```

Response (201):

```json
{
  "watch_targets": [{ "id": "...", "plan_key": "pro", "status": "skill_ready", ... }],
  "skills": ["data/skills/lab-multiplan.json"],
  "baselines": ["data/snapshots/ladder/lab-multiplan.json"],
  "first_learn": true
}
```

**Rules:**
- Requires Bearer JWT (401 without)
- Requires notify email verified — reuses F5 `NOTIFY_GATED_HANDLERS` /
  `isNotifyVerified` pattern (403 `notify_email_unverified` if not)
- `selected` must be a non-empty array of `{ plan_key }` (400 if missing)
- Selected `plan_key` must match a preview candidate (422 `no_matching_plans`)
- Creates WatchTarget(s) with `status: skill_ready` + skill + baseline
- `first_learn: true` — **NO** customer email/outbox on first learn
- Non-allowlisted URLs → 422; missing customer → 404

## Fallback Stubs

| Route | Status | Description |
|---|---|---|
| `POST /b2b/intake/selector` | 501 | Click-select fallback — not yet implemented |
| `POST /b2b/intake/manual-seed` | 501 | Manual seed fallback — not yet implemented |

Both require JWT auth. Returns `{ error: "not_implemented", message: "..." }`.

## Allowlist / Catalog Gate

Only lab and supported domains are accepted:

- **Lab:** `127.0.0.1` / `localhost` at path `/pricing`
- **Supported domains:** plausible.io, linear.app, notion.com, vercel.com,
  slack.com, shopify.com (see `docs/allowlist.md`)
- All other URLs → 422 `unsupported_site` (honest rejection)

## Lab Multi-Plan Fixture

The lab server at `http://127.0.0.1:3847/pricing` serves a controlled
multi-plan page for testing. Plans are stored in `lab/plans.json`.

```bash
# Start lab server
node lab/server.js

# View multi-plan pricing page
curl http://127.0.0.1:3847/pricing

# Get plans as JSON
curl http://127.0.0.1:3847/plans.json

# Update plans (test control)
curl -X POST http://127.0.0.1:3847/set-plans \
  -H 'Content-Type: application/json' \
  -d '{"plans":[{"plan_key":"free","name":"Free","price":0,"currency":"USD","period":"month"}]}'
```

## Daily Path Safety

- WatchTargets store `plan_key` — daily Service C only checks the
  selected plan(s)
- Baseline snapshot marks each plan with `selected: true/false`
- Change to an **unselected** plan alone must **not** trigger email
  (relies on existing Service C / watch-target `plan_key` pin behavior)

## Running Tests

```bash
# F4 tests only (offline, no DB needed):
AUTH_STUB=1 node test/test-f4-intake.js

# Or via npm:
npm run test:f4

# Full suite (includes F4):
npm test
```

Tests use a static HTML fixture (`test/fixtures/lab-multiplan.html`)
and a local HTTP server — no live internet scraping required for CI.

## Token Budget

Preview, confirm, and the resulting daily path: **0 LLM**.
