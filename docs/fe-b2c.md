# Thin FE-B2C — catalog browse + free-3 watch

Wave 9 thin front-end for B2C. Clickable shell that talks to **Service A HTTP APIs only**. No second backend, no client-invented watches, 0 LLM.

Primary login UX is the **Google Sign-In (GIS) button** (Wave 12b). Fail-closed when Google code/keys are missing. **NEVER** put `GOOGLE_CLIENT_SECRET` (or any secret) in FE HTML, JS, git, or docs values.

## Run (local)

Terminal 1 — Service A (stub auth for local/shame **only**):

```bash
AUTH_STUB=1 npm run service-a
# listens on http://127.0.0.1:3850 by default
```

Terminal 2 — thin FE:

```bash
npm run fe-b2c
# http://127.0.0.1:3921/
```

Open the FE URL. The FE server serves `public/fe-b2c/` and **reverse-proxies** `/auth/*`, `/product-offers*`, `/watch-targets*`, `/b2c/*`, `/customers*`, `/r/*`, `/health` to `SERVICE_A_URL` (default `http://127.0.0.1:3850`). That proxy is still **one backend** (Service A) — not a parallel API.

### Env

| Variable | Default | Notes |
|---|---|---|
| `SERVICE_A_URL` | `http://127.0.0.1:3850` | Upstream Service A for the FE proxy |
| `FE_B2C_PORT` | `3921` | Or `--port` |
| `FE_B2C_HOST` | `127.0.0.1` | Loopback for local ops |

Override API target from the browser with `?api=http://127.0.0.1:3850` (direct; may need CORS).

## Login hook — Google Sign-In (GIS) primary

1. FE calls `GET /health` → reads `auth_mode` (`stub` | `google`) and `google_client_id` (public, safe — only the client ID, never the secret).
2. **`auth_mode=google` + `google_client_id` present:** loads Google Identity Services (`https://accounts.google.com/gsi/client`), initializes `google.accounts.oauth2.initCodeClient` with the client ID, and renders a **Sign in with Google** button. On click, Google shows the consent popup; the callback receives an authorization `code` → `POST /auth/login { code }` → JWT session. Redirect alignment: GIS `ux_mode: "popup"` uses `redirect_uri=postmessage` implicitly, which matches the backend default (`GOOGLE_REDIRECT_URI` unset → `postmessage`).
3. **`auth_mode=google` + no `google_client_id`:** fail-closed error — "Google client ID not configured. Sign-in unavailable." No silent fallback.
4. **`auth_mode=stub`:** shows a clearly labeled **test-only** stub form (`google_subject` + `email`). **Never claim stub as production Google.** Do not set `AUTH_STUB=1` on Render.
5. A secondary **dev-only** collapsible allows pasting an authorization code manually (for testing/debugging). This is not the primary UX.

### Client ID — public config only

`GOOGLE_CLIENT_ID` is exposed on `GET /health` as `google_client_id`. This is safe — client IDs are public by design (they appear in every browser's OAuth redirect URL). **NEVER** expose `GOOGLE_CLIENT_SECRET` or `JWT_SECRET` in FE HTML, JS, git, or docs values.

## Catalog → watch flow

1. Sign in (notify same-email path verifies on login).
2. `GET /product-offers` — list active catalog offers.
3. `GET /b2c/slots` — show free-3 usage (server-owned).
4. Watch an offer → FE creates a customer via `POST /customers` if needed → `POST /customers/:id/watch-targets` with `{ surface: "b2c", product_offer_id }`.
5. Free-3 enforced **server-side** (`b2c_slots_exhausted` at +1). UI shows slots and blocks the Watch button when `allowed === false`.
6. Affiliate CTA links to `GET /r/:id` (click log + 302). Commission disclosure from `offer.disclosure` or product-offer-store **DEFAULT**.

## Hosted on Service A (Wave 9)

Public URL on the existing free Service A (no new paid service):

```
https://pricewatch-9cja.onrender.com/fe-b2c/
```

Service A serves `public/fe-b2c/` at `/fe-b2c/` (and `/fe-b2c/index.html`). Trailing slash OK. Existing API routes (`/health`, `/auth`, `/product-offers`, `/watch-targets`, `/b2c/slots`, `/customers`, `/r/:id`, …) are unchanged.

**Same-origin happy path:** open the hosted URL — the FE calls `/health`, `/auth`, `/product-offers`, `/watch-targets`, `/b2c/slots`, `/customers`, `/r/:id` on the **same host**. No `?api=` required. Google Sign-In (GIS) button is the primary login UX. Do **not** set `AUTH_STUB=1` on Render.

## Theme

Default theme is **light** (Wave 10). Shared CSS tokens live in `public/fe-shared/theme.css`, imported by both FE-B2B and FE-B2C via `<link>`. Per-FE accent overrides are in each HTML's inline `<style>`. Service A serves `/fe-shared/*` with the same path-traversal rules as `/fe-b2b/` and `/fe-b2c/`.

## Static serve path

| Path | Role |
|---|---|
| `public/fe-b2c/` | Static HTML/JS for the thin B2C UI |
| `public/fe-shared/theme.css` | Shared light theme tokens (Wave 10) |
| Service A `GET /fe-b2c/` | Hosted static serve (Wave 9) |
| Service A `GET /fe-shared/*` | Shared FE assets (Wave 10) |
| `scripts/fe-b2c-server.js` | Local-only static server + reverse-proxy to Service A |
| `npm run fe-b2c` | Starts the local FE shell |

**No new paid Render service.** Local `npm run fe-b2c` remains for offline/shame; production/pilot watch path is Service A `/fe-b2c/`.

## What this is not

- Not FE-B2B (see `docs/fe-b2b.md`)
- Not a second API / catalog fork
- Not product accept / production-ready
- Not real payments (PAYMENT_STUB stays test-only)

## Shame / CI

`test/test-fe-b2c.js` is wired into `npm test`:

- (a) missing auth → fail-closed clear error
- (b) catalog → watch happy path (stub + mock Neon / lab)
- (c) free-3+1 blocked (`b2c_slots_exhausted`)
- (d) Wave 4–8 shame still green (wired in `npm test`)
- (e) secrets CLEAN

Host smoke (static `/fe-b2c/` 200 + same-origin `/health` + path-traversal blocked) lives in the same test file.
