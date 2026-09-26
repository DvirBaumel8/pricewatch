# Tip-SHA Deploy Verify

Compares the git SHA running on Service A to the local `main` HEAD.
Takes < 30 seconds; no secrets beyond the public URL.

## Prerequisites

| Need | How |
|---|---|
| git CLI | comes with the repo checkout |
| Node ≥ 18 | `fetch` is built-in from Node 18 |
| Service A URL | `SERVICE_A_URL` env var (or use stub mode) |

## Quick start

### 1. Live check against a running Service A

```bash
# Fetch latest main so the comparison is current
git fetch origin main

# Run against the deployed service
SERVICE_A_URL=https://pricewatch.onrender.com npm run verify:tip-sha
```

**Expected output (match):**

```
[verify] GET https://pricewatch.onrender.com/health
[verify] Deploy tip : ca3f03d8a1b2...
[verify] main HEAD  : ca3f03d8a1b2...
[verify] PASS — deploy tip ca3f03d8a1b2 matches main ca3f03d8a1b2
```

**Expected output (mismatch — deploy is stale):**

```
[verify] GET https://pricewatch.onrender.com/health
[verify] Deploy tip : b1234567abcd...
[verify] main HEAD  : ca3f03d8a1b2...
[verify] MISMATCH — deploy tip b1234567abcd ≠ main ca3f03d8a1b2
```

Exit codes: `0` match, `1` mismatch, `2` could not resolve a SHA.

### 2. Stub mode (CI / offline / shame-test)

No network needed — pass a fake (or real) SHA via `STUB_TIP_SHA`.
If `origin/main` is unavailable (e.g. shallow CI clone), also set `MAIN_SHA`:

```bash
# Simulate a matching deploy
STUB_TIP_SHA=$(git rev-parse HEAD) npm run verify:tip-sha

# Simulate a stale deploy
STUB_TIP_SHA=0000000000000000000000000000000000000000 npm run verify:tip-sha

# CI (shallow clone — no origin/main ref)
STUB_TIP_SHA=$(git rev-parse HEAD) MAIN_SHA=$(git rev-parse HEAD) npm run verify:tip-sha
```

### 3. Manual cURL check (no script)

```bash
curl -s https://pricewatch.onrender.com/health | jq .git_sha
# Compare visually to:
git rev-parse origin/main
```

## How it works

1. **Service A `/health` endpoint** now includes a `git_sha` field, resolved
   once at process startup from:
   - `GIT_SHA` environment variable (set this in Render env vars at deploy, or
     let Render's built-in `RENDER_GIT_COMMIT` populate it), **or**
   - `git rev-parse HEAD` in the working directory, **or**
   - `"unknown"` as a last resort.

2. **`scripts/verify-tip-sha.js`** fetches `/health`, extracts `git_sha`, and
   compares it to `git rev-parse origin/main` locally.

## Render deploy setup

Set the `GIT_SHA` env var in Render so the running process always knows its
commit. Add to `render.yaml` or the Dashboard:

```yaml
envVars:
  - key: GIT_SHA
    value: <leave blank — see below>
```

Or use Render's built-in `RENDER_GIT_COMMIT` env var which is automatically set
on every deploy. To wire it:

```yaml
envVars:
  - key: GIT_SHA
    fromService:
      # not needed — just set GIT_SHA=$RENDER_GIT_COMMIT in your start command:
      # node -e "process.env.GIT_SHA=process.env.RENDER_GIT_COMMIT" && node src/service-a.js
```

Simplest: in your Render start command, prefix with:

```bash
GIT_SHA=$RENDER_GIT_COMMIT node src/service-a.js
```

## Frequency

Run after every deploy, or on a weekly ops cadence. The script is fast enough
to include in CI as a post-deploy smoke check.
