# F5 — Users, Google OAuth, Notify-Email Verify

## Overview

F5 adds multi-tenant user accounts to PriceWatch via Google Sign-In.
Users are stored in Neon (Postgres). Protected API routes require a
Bearer JWT. The notify-email verification rule (Q6 locked) skips
verification when the notify email matches the Google account email
and requires a real token-consume flow when they differ.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes (prod) | Neon Postgres connection string |
| `GOOGLE_CLIENT_ID` | Yes (prod) | GCP OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes (prod) | GCP OAuth 2.0 client secret — **NEVER commit** |
| `GOOGLE_REDIRECT_URI` | No | OAuth redirect URI (default: `postmessage`) |
| `JWT_SECRET` | Yes (prod) | HMAC-SHA256 key for signing JWTs — **NEVER commit** |
| `AUTH_STUB` | No | Set to `1` for local/CI test mode (no real Google) |

### Secret Names for Render / Production

In Render (or any host), set these as environment secrets:

- `DATABASE_URL` — from Neon Connection Details
- `GOOGLE_CLIENT_ID` — from GCP Console → APIs & Services → Credentials
- `GOOGLE_CLIENT_SECRET` — same page
- `JWT_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Stub vs Real OAuth

### Stub Mode (`AUTH_STUB=1`)

For local development and CI tests. No Google credentials needed.

Login accepts `{ google_subject, email }` directly:

```bash
curl -X POST http://127.0.0.1:3850/auth/login \
  -H "Content-Type: application/json" \
  -d '{"google_subject":"test-sub-123","email":"alice@example.com"}'
```

Returns `{ user, token }`. Use the token as `Authorization: Bearer <token>`.

JWT_SECRET defaults to a test-only value in stub mode.

### Real Mode (production)

Login accepts `{ code }` — a Google authorization code from the
frontend OAuth flow. The server exchanges it with Google for an
`id_token`, extracts `sub` and `email`, and creates/finds the user.

## API Routes

### Public (no auth required)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check — always 200 |
| POST | `/auth/login` | Login (stub or Google OAuth) |

### Protected (require `Authorization: Bearer <jwt>`)

| Method | Path | Description |
|---|---|---|
| GET | `/auth/me` | Current user + notify_verified status |
| POST | `/auth/notify-email` | Set notify email address |
| POST | `/auth/verify-notify-email` | Consume verify token |
| POST | `/customers` | Create customer |
| GET | `/customers` | List customers |
| GET | `/customers/:id` | Customer detail |
| POST | `/customers/:id/competitors` | Add competitor (compat shim) |
| POST | `/customers/:id/watch-targets` | Create WatchTarget |
| GET | `/customers/:id/watch-targets` | List WatchTargets |
| POST | `/watch-targets` | Create WatchTarget |
| GET | `/watch-targets/:id` | Get WatchTarget |
| GET | `/jobs` | List jobs |
| GET | `/jobs/:id` | Job detail |

All protected routes return `401` with `{ "error": "Authentication required" }`
when no valid JWT is present.

## Notify-Email Verification (Q6 — locked)

**Rule:** Skip verify when notify email equals Google account email;
require verify when different.

### Same-email flow

1. User logs in with Google (e.g. `alice@example.com`)
2. On first login, `notify_email` is set to the Google email
3. `notify_verified_at` is set immediately — no verification needed
4. User can create watches immediately

### Different-email flow

1. User calls `POST /auth/notify-email` with a different address
2. Server clears `notify_verified_at` and returns a verify token
3. In production, the token would be emailed (F9 mailer scope)
4. User calls `POST /auth/verify-notify-email` with the token
5. Server marks `notify_verified_at = now()` after consuming the token
6. Tokens are single-use and expire after 1 hour

The verify token is real (consumed in the database) — not cosmetic.

## Database Schema (Migration 3)

### `users` table

| Column | Type | Notes |
|---|---|---|
| id | text PK | Random hex |
| google_subject | text UNIQUE | Google OAuth `sub` claim |
| email | text | Google account email |
| notify_email | text | Where to send alerts |
| notify_verified_at | timestamptz | NULL until verified |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### `email_verify_tokens` table

| Column | Type | Notes |
|---|---|---|
| id | text PK | Random hex |
| user_id | text FK → users | |
| email | text | Email this token verifies |
| token | text UNIQUE | The token value |
| consumed_at | timestamptz | Set when consumed |
| expires_at | timestamptz | 1 hour after creation |
| created_at | timestamptz | |

### `customers` table change

Added `user_id` column (text, FK → users, nullable) to tie customers
to authenticated users. Existing customers without a user remain valid.

## Running F5 Tests

```bash
# Offline tests (no DB, no Google — CI-safe):
AUTH_STUB=1 node test/test-f5-auth.js

# Or via npm (included in npm test):
npm test

# With Neon for full user CRUD tests:
export DATABASE_URL="postgres://..."
AUTH_STUB=1 node test/test-f5-auth.js
```

The test suite:
- Verifies health endpoint is public
- Verifies all protected routes return 401 without auth
- Tests JWT sign/verify round-trip and tamper detection
- Checks no secrets are committed in git-tracked files
- When DATABASE_URL is set: tests full login → same-email → different-email → verify flow
- When DATABASE_URL is absent: skips DB-dependent tests (exit 0)
