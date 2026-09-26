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

## Static serve path (Boris)

| Path | Role |
|---|---|
| `public/fe-b2b/` | Static HTML/JS for the thin B2B UI |
| `scripts/fe-b2b-server.js` | Local static server + reverse-proxy to Service A |
| `npm run fe-b2b` | Starts the FE shell |

**No new paid Render service.** Optional later: serve the same static folder from existing Service A or a free static path — out of scope unless Render bind changes are requested.

## Shame / CI

`test/test-fe-b2b.js` is wired into `npm test`:

- (a) missing auth → clear error
- (b) preview → confirm happy path (stub + lab fixture)
- (c) Wave 4/5/6 API shame still in `npm test`
- (d) no secrets in git
