# F6 — B2C stubs (CB-15…18)

**Status:** Implemented (fields/API only — no live Stripe, no FE, no catalog intelligence)

## Schema

### `product_offers`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| merchant_url | text NOT NULL | Product/pricing page URL |
| affiliate_url | text | Affiliate redirect target (nullable) |
| affiliate_program_id | text | Partner program identifier (nullable) |
| disclosure | text NOT NULL | Affiliate disclosure text |
| skill_id | text | Optional — links to existing skill |
| active | boolean NOT NULL | Default true |
| label | text NOT NULL | Human-readable offer name |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### `user_packages`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| user_id | text NOT NULL | FK → users(id) |
| package_type | text NOT NULL | `free`, `pkg_1`, `pkg_3`, `pkg_5`, `pkg_10`, `unlimited` |
| slot_count | integer NOT NULL | Effective slot count for this package |
| granted_via | text NOT NULL | `signup`, `payment`, `payment_stub`, `admin` |
| active | boolean NOT NULL | Default true |
| created_at | timestamptz | |

### `click_log`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| product_offer_id | text NOT NULL | FK → product_offers(id) |
| user_id | text | Nullable — anonymous clicks allowed |
| ip | text | |
| user_agent | text | |
| created_at | timestamptz | |

Migration: `migrations/4_f6_b2c_stubs.js`

## Watch slot enforcement

### Tiers

| Package | Slots | Notes |
|---------|-------|-------|
| Free (signup) | 3 | Auto-granted on first B2C slot check |
| pkg_1 | 1 | |
| pkg_3 | 3 | |
| pkg_5 | 5 | |
| pkg_10 | 10 | |
| unlimited | soft-cap **50** | Hard stop at 50; ops alarm at 45+ |

### Rules

- Users start with 3 free B2C watch slots (auto-provisioned)
- Purchasing packages adds slots cumulatively
- `unlimited` is capped at **50** total B2C watch targets per user (Q8 locked)
- Creating a B2C WatchTarget (`surface: "b2c"`) checks slot availability
- B2B watches (`surface: "b2b"`) are NOT counted against B2C slots

### Ops alarm (soft-cap 50)

When a user's B2C watch count reaches the warning threshold (45) or the soft-cap (50), a structured ops alarm is logged:

```json
{
  "alarm": "SOFT_CAP_WATCH_TARGETS",
  "severity": "warning|critical",
  "user_id": "...",
  "current_watch_count": 49,
  "soft_cap": 50,
  "event": "approaching|hit",
  "action_required": "Review user watch target count — potential scrape fan-out risk"
}
```

- `event: "approaching"` → warning at 45–49
- `event: "hit"` → critical at 50+, creation blocked

To wire into production alerting: grep for `[OPS_ALARM]` in structured logs, or replace `opsAlarmSoftCap()` in `src/slot-store.js` with your metrics/PagerDuty call.

## Payment stub (`PAYMENT_STUB`)

**Endpoint:** `POST /b2c/payment-stub`  
**Auth:** Required (Bearer JWT)  
**Body:** `{ "package_type": "pkg_1" | "pkg_3" | "pkg_5" | "pkg_10" | "unlimited" }`

Grants the specified package to the authenticated user **without** real Stripe or card charges. Uses `granted_via: "payment_stub"`.

**Env:** Set `PAYMENT_STUB=1` to enable in production (disabled by default in `NODE_ENV=production`). Always available in non-production.

**Testing:**

```bash
# Login (stub mode)
TOKEN=$(curl -s -X POST http://localhost:3850/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"google_subject":"test","email":"test@example.com"}' | jq -r .token)

# Grant pkg_3
curl -X POST http://localhost:3850/b2c/payment-stub \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"package_type":"pkg_3"}'

# Check slots
curl http://localhost:3850/b2c/slots -H "Authorization: Bearer $TOKEN"
```

## Affiliate redirect (`GET /r/:id`)

**Public** (no auth required). Logs a click and returns `302` redirect.

- If offer has `affiliate_url`, redirects there
- Otherwise redirects to `merchant_url`
- Click is logged in `click_log` table with timestamp, optional user id, IP, user-agent
- No conversion metrics invented — click count only

```bash
# Redirect (follows Location header)
curl -v http://localhost:3850/r/offer-plausible-growth
# → 302 Location: https://aff.example.com/plausible?ref=pricewatch
```

## Seed product offers

```bash
# Seed 2 stub offers (Plausible + Linear)
curl -X POST http://localhost:3850/product-offers/seed \
  -H "Authorization: Bearer $TOKEN"

# List active offers
curl http://localhost:3850/product-offers \
  -H "Authorization: Bearer $TOKEN"
```

## How to test (offline, no DB)

```bash
# All F6 tests (included in npm test)
AUTH_STUB=1 node test/test-f6-b2c.js

# Full suite
npm test
```

Tests run without `DATABASE_URL` — slot enforcement and DB-backed paths are tested via unit checks on constants/shapes and HTTP route structure. DB-integration tests require Neon and are gated on `DATABASE_URL`.

## Out of scope

- Curated catalog intelligence
- Real Stripe / card charges (use `PAYMENT_STUB` stub)
- FE-B2C UI
- Purchase conversion claims
- B2B email pollution with affiliate CTAs
