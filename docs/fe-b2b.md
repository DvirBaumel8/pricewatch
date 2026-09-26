# Thin FE-B2B — login hook + add-watch UI

Wave 7 thin front-end for B2B pilots. Clickable shell that talks to **Service A HTTP APIs only**. No second backend, no client-invented watches, 0 LLM.

Live Google OAuth consent UI remains **PARKED** (Wave 6 Phase B). Fail-closed when Google code/keys are missing.

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

Terminal 2 — thin FE:

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

## Login hook

1. FE calls `GET /health` → reads `auth_mode` (`stub` | `google`).
2. **`auth_mode=google`:** UI asks for a Google authorization code → `POST /auth/login` with `{ code }`. Missing code → structured `google_code_required` (fail-closed). UI does **not** pretend Google succeeded without a code.
3. **`auth_mode=stub`:** shows a clearly labeled **test-only** stub form (`google_subject` + `email`). **Never claim stub as production Google.** Do not set `AUTH_STUB=1` on Render.

## Add-watch flow

1. Sign in (notify same-email path verifies on login).
2. Enter pricing URL (+ optional intent) → `POST /b2b/intake/preview`.
3. Select plan(s) → FE creates a customer via `POST /customers` if needed → `POST /b2b/intake/confirm` with `customer_id` + `selected[{ plan_key }]`.
4. Server owns allowlist / ownership; FE never bypasses.

## What this is not

- Not FE-B2C
- Not a second API / intake fork
- Not product accept / production-ready
- Not live Google unlock (Wave 6 Phase B stays parked)

## Hosted on Service A (Wave 8)

Public URL on the existing free Service A (no new paid service):

```
https://pricewatch-9cja.onrender.com/fe-b2b/
```

Service A serves `public/fe-b2b/` at `/fe-b2b/` (and `/fe-b2b/index.html`). Trailing slash OK. Existing API routes (`/health`, `/auth`, `/b2b`, `/customers`, …) are unchanged.

**Same-origin happy path:** open the hosted URL — the FE calls `/health`, `/auth`, `/b2b`, `/customers` on the **same host**. No `?api=` required. Live Google OAuth remains PARKED; do **not** set `AUTH_STUB=1` on Render.

## Static serve path

| Path | Role |
|---|---|
| `public/fe-b2b/` | Static HTML/JS for the thin B2B UI |
| Service A `GET /fe-b2b/` | Hosted static serve (Wave 8) |
| `scripts/fe-b2b-server.js` | Local-only static server + reverse-proxy to Service A |
| `npm run fe-b2b` | Starts the local FE shell |

**No new paid Render service.** Local `npm run fe-b2b` remains for offline/shame; production/pilot watch path is Service A `/fe-b2b/`.

## Shame / CI

`test/test-fe-b2b.js` (Wave 7) and `test/test-host-fe-b2b.js` (Wave 8) are wired into `npm test`:

Wave 7 FE:
- (a) missing auth → clear error
- (b) preview → confirm happy path (stub + lab fixture)
- (c) Wave 4/5/6 API shame still in `npm test`
- (d) no secrets in git

Wave 8 host:
- (a) Service A static `/fe-b2b/` serves index
- (b) `/health` reachable same-origin alongside static
- (c) prior FE + hosted shame still green
- (d) secrets CLEAN
