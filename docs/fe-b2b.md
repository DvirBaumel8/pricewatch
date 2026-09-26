# Thin FE-B2B — login hook + add-watch UI

Wave 7 thin front-end for B2B pilots. Clickable shell that talks to **Service A HTTP APIs only**. No second backend, no client-invented watches, 0 LLM.

Primary login UX is the **Google Sign-In (GIS) button** (Wave 12b). Fail-closed when Google code/keys are missing. **NEVER** put `GOOGLE_CLIENT_SECRET` (or any secret) in FE HTML, JS, git, or docs values.

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

## Login hook — Google Sign-In (GIS) primary

1. FE calls `GET /health` → reads `auth_mode` (`stub` | `google`) and `google_client_id` (public, safe — only the client ID, never the secret).
2. **`auth_mode=google` + `google_client_id` present:** loads Google Identity Services (`https://accounts.google.com/gsi/client`), initializes `google.accounts.oauth2.initCodeClient` with the client ID, and renders a **Sign in with Google** button. On click, Google shows the consent popup; the callback receives an authorization `code` → `POST /auth/login { code }` → JWT session. Redirect alignment: GIS `ux_mode: "popup"` uses `redirect_uri=postmessage` implicitly, which matches the backend default (`GOOGLE_REDIRECT_URI` unset → `postmessage`).
3. **`auth_mode=google` + no `google_client_id`:** fail-closed error — "Google client ID not configured. Sign-in unavailable." No silent fallback.
4. **`auth_mode=stub`:** shows a clearly labeled **test-only** stub form (`google_subject` + `email`). **Never claim stub as production Google.** Do not set `AUTH_STUB=1` on Render.
5. A secondary **dev-only** collapsible allows pasting an authorization code manually (for testing/debugging). This is not the primary UX.

### Client ID — public config only

`GOOGLE_CLIENT_ID` is exposed on `GET /health` as `google_client_id`. This is safe — client IDs are public by design (they appear in every browser's OAuth redirect URL). **NEVER** expose `GOOGLE_CLIENT_SECRET` or `JWT_SECRET` in FE HTML, JS, git, or docs values.

## Add-watch flow

1. Sign in (notify same-email path verifies on login).
2. Enter pricing URL (+ optional intent) → `POST /b2b/intake/preview`.
3. Select plan(s) → FE creates a customer via `POST /customers` if needed → `POST /b2b/intake/confirm` with `customer_id` + `selected[{ plan_key }]`.
4. Server owns allowlist / ownership; FE never bypasses.

## What this is not

- Not FE-B2C
- Not a second API / intake fork
- Not product accept / production-ready

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
| `public/fe-b2b/` | Static HTML/JS for the thin B2B UI |
| `public/fe-shared/theme.css` | Shared light theme tokens (Wave 10) |
| Service A `GET /fe-b2b/` | Hosted static serve (Wave 8) |
| Service A `GET /fe-shared/*` | Shared FE assets (Wave 10) |
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
