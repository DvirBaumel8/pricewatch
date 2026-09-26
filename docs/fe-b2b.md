# FE-B2B — Marketing landing + signed-in app

Wave 14 splits public **marketing landing** from **signed-in product** on the same `/fe-b2b/` URL (view swap). Wave 13 demo-ready product chrome is preserved for the signed-in path. **Wave 15** adds Tierpeek-style **multi-competitor watches** (list + persistent Add + soft UI cap). Talks to **Service A HTTP APIs only**. No second backend, no client-invented watches, 0 LLM, **no Stripe**.

Primary login UX is **Continue with Google** (GIS, Wave 12b). Fail-closed when Google code/keys are missing. **NEVER** put `GOOGLE_CLIENT_SECRET` (or any secret) in FE HTML, JS, git, or docs values.

## Run (local)

Terminal 1 — Service A (stub auth for local/shame **only**):

```bash
AUTH_STUB=1 npm run service-a
# listens on http://127.0.0.1:3850 by default
```

Optional lab pricing page for preview/confirm:

```bash
npm run lab
# http://127.0.0.1:3847/pricing
```

Terminal 2 — FE shell:

```bash
npm run fe-b2b
# http://127.0.0.1:3920/
```

Open the FE URL. The FE server serves `public/fe-b2b/` and **reverse-proxies** `/auth/*`, `/b2b/*`, `/customers*`, `/health`, etc. to `SERVICE_A_URL` (default `http://127.0.0.1:3850`). That proxy is still **one backend** (Service A) — not a parallel API.

### Env

| Variable | Default | Notes |
|---|---|---|
| `SERVICE_A_URL` | `http://127.0.0.1:3850` | Upstream Service A for the FE proxy |
| `FE_B2B_PORT` | `3920` | Or `--port` |
| `FE_B2B_HOST` | `127.0.0.1` | Loopback for local ops |

Override API target from the browser with `?api=http://127.0.0.1:3850` (direct; may need CORS).

## Routes (Wave 14)

Prefer a single URL with a clear view swap (no separate paid host):

| URL | Auth state | View |
|---|---|---|
| `/fe-b2b/` | Signed out | **Landing** — marketing promise, how it works, optional sample waiting card, **Continue with Google** only |
| `/fe-b2b/` | Signed in (after GIS success) | **App** — Wave 13 product only (honesty chip → Start pilot → You're in → add watch → Option B waiting) |

DOM: `#landingView` (default) ↔ `#appView` (after `POST /auth/login` success). Film beat 0 opens `/fe-b2b/` signed-out; beat 1 continues with Google into the app. No marketing hero competing with app chrome on the same scroll.

## Signed-out landing (Wave 14)

- Promise: email when competitor **plans and prices** change (never say “ladder”).
- How it works (3 steps).
- Optional static **sample** waiting card clearly labeled **Sample · not a live watch**.
- Primary CTA: **Continue with Google** (GIS) only.
- **No** add-rival form, checkout stub, live watch list, or Dev/stub panels on the google camera path.

## Signed-in app (Wave 13 product, Wave 14 container, Wave 15 list)

- Brand mark + **PriceWatch** title (no “(thin)” / “B2B thin” chip).
- No Service A / thin / API jargon on the camera path.
- Honesty chip → Start pilot → You're in → add watch → **Your watches** (one Option B card per rival).
- Signed-in state shows the human email (not a raw JSON hero).

## Login hook — Google Sign-In (GIS) primary

1. FE calls `GET /health` → reads `auth_mode` (`stub` | `google`) and `google_client_id` (public, safe — only the client ID, never the secret).
2. **`auth_mode=google` + `google_client_id` present:** loads Google Identity Services (`https://accounts.google.com/gsi/client`), initializes `google.accounts.oauth2.initCodeClient` with the client ID, and renders a **Continue with Google** button on the landing. On click, Google shows the consent popup; the callback receives an authorization `code` → `POST /auth/login { code }` → JWT session → swaps to **app** view. Redirect alignment: GIS `ux_mode: "popup"` uses `redirect_uri=postmessage` implicitly, which matches the backend default (`GOOGLE_REDIRECT_URI` unset → `postmessage`). Stub panel and Dev paste-code are **hidden** on this path.
3. **`auth_mode=google` + no `google_client_id`:** fail-closed error — Google sign-in unavailable (`google_code_required`). No silent fallback.
4. **`auth_mode=stub`:** shows a clearly labeled **test-only** stub form (`google_subject` + `email`) on the landing for local shame. **Never claim stub as production Google.** Do not set `AUTH_STUB=1` on Render.
5. A secondary **dev-only** paste-code path remains in the DOM for local shame, but is hidden when `auth_mode=google`.

### Client ID — public config only

`GOOGLE_CLIENT_ID` is exposed on `GET /health` as `google_client_id`. This is safe — client IDs are public by design (they appear in every browser's OAuth redirect URL). **NEVER** expose `GOOGLE_CLIENT_SECRET` or `JWT_SECRET` in FE HTML, JS, git, or docs values.

## Honest checkout stub (Wave 13 — no Stripe)

After sign-in, before Add watch unlocks:

1. **Pilot** plan + price + **Start pilot** CTA.
2. Visible honesty chip (exact): **Demo / pilot checkout — not a live charge**.
3. Success: **You're in** / **Pilot started** → unlocks Add watch.

Client-side stub only. No Stripe, no fake card last4, no implied live charge.

## Add-watch flow

1. Sign in (notify same-email path verifies on login).
2. Start pilot (honest stub above).
3. Enter competitor name + pricing URL (+ optional focus plan) → `POST /b2b/intake/preview`.
4. Select plan(s) → FE creates a customer via `POST /customers` if needed → `POST /b2b/intake/confirm` with `customer_id` + `selected[{ plan_key }]`.
5. Server owns allowlist / ownership; FE never bypasses. Watches are not invented in the browser.
6. After success: inputs clear; preview→confirm is ready for the **next** URL. Add stays on the same signed-in view (Tierpeek persistent Add).

Camera path uses human copy (Competitor name, Preview plans, Confirm watch) — no on-screen `POST /b2b/…` jargon.

## Your watches (Wave 15 — multi-competitor)

Signed-in app shows a **Your watches** list — one quiet Option B card **per rival** (not a single overwritten slot):

- Rival name + URL
- Baseline plans / $
- **No price change**
- **Last checked** (Israel time)
- Cadence: **Daily · morning Israel time**

Each successful confirm **appends** (or merges plans for the same URL). Prior rivals stay visible.

### Soft UI cap — `FE_WATCH_SOFT_CAP = 5`

Demo-ready soft stop in the FE (`public/fe-b2b/index.html` constant **`FE_WATCH_SOFT_CAP = 5`**). At the cap: friendly “you're full” message; refuse new confirm; **existing cards keep running**. Backend soft-cap remains **50** (`UNLIMITED_SOFT_CAP`) — the API is not product-capped at a single rival.

### Reload from Service A

On app open / session restore, FE loads watches from Service A when a customer is known:

1. Resolve customer via `GET /customers` (match signed-in email / user).
2. Prefer **`GET /customers/:id/watch-targets`**; fall back to `GET /customers/:id` (`watch_targets` / competitors).
3. Group WatchTargets by `source_url` → one Option B card per rival.

Confirm still creates watches only via `POST /b2b/intake/confirm`. Session restore keeps the list across refresh when the JWT session is present.

Optional collapsed debug details. Prefer preview/confirm data; otherwise honest values from the list API. No fake busy scanning.

## What this is not

- Not FE-B2C
- Not a second API / intake fork
- Not live Stripe / Customer-ready pay
- Not product accept for strangers

## Hosted on Service A (Wave 8)

Public URL on the existing free Service A (no new paid service):

```
https://pricewatch-9cja.onrender.com/fe-b2b/
```

Service A serves `public/fe-b2b/` at `/fe-b2b/` (and `/fe-b2b/index.html`). Trailing slash OK. Existing API routes (`/health`, `/auth`, `/b2b`, `/customers`, …) are unchanged.

**Same-origin happy path:** open the hosted URL — the FE calls `/health`, `/auth`, `/b2b`, `/customers` on the **same host**. No `?api=` required. Google Sign-In (GIS) button is the primary login UX. Do **not** set `AUTH_STUB=1` on Render.

## Theme

Default theme is **light** (Wave 10). Shared CSS tokens live in `public/fe-shared/theme.css`, imported by both FE-B2B and FE-B2C via `<link>`. Per-FE accent overrides are in each HTML's inline `<style>`. Service A serves `/fe-shared/*` with the same path-traversal rules as `/fe-b2b/` and `/fe-b2c/`.

## Static serve path

| Path | Role |
|---|---|
| `public/fe-b2b/` | Static HTML/JS for the B2B UI |
| `public/fe-shared/theme.css` | Shared light theme tokens (Wave 10) |
| Service A `GET /fe-b2b/` | Hosted static serve (Wave 8) |
| Service A `GET /fe-shared/*` | Shared FE assets (Wave 10) |
| `scripts/fe-b2b-server.js` | Local-only static server + reverse-proxy to Service A |
| `npm run fe-b2b` | Starts the local FE shell |

**No new paid Render service.** Local `npm run fe-b2b` remains for offline/shame; production/pilot watch path is Service A `/fe-b2b/`.

## Shame / CI

`test/test-fe-b2b.js` (Wave 7 + 13) and `test/test-host-fe-b2b.js` (Wave 8) are wired into `npm test`:

Wave 7 / 13 / 14 / 15 FE:
- (a) missing auth → clear error
- (b) preview → confirm happy path (stub + lab fixture)
- (c) Wave 4/5/6 API shame still in `npm test`
- (d) no secrets in git
- Wave 13: honesty chip, checkout stub, Option B phrases, product watch card; no lab chrome / Stripe / fake last4 on camera path
- Wave 14: landing vs app view swap; GIS CTA on landing; no add-watch/checkout/live watches on signed-out camera path; sample card labeled not a live watch
- Wave 15: “Your watches” multi-card list (not overwrite-only); `FE_WATCH_SOFT_CAP = 5`; persistent Add after success; reload via `GET /customers/:id/watch-targets`

Wave 8 host:
- (a) Service A static `/fe-b2b/` serves index
- (b) `/health` reachable same-origin alongside static
- (c) prior FE + hosted shame still green
- (d) secrets CLEAN
