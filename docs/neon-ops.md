# Neon Postgres — ops note (F1)

## 1. Create a Neon project

1. Sign up / log in at <https://console.neon.tech>.
2. **Create Project** → pick a name (e.g. `pricewatch-dev`), region closest
   to you (or `aws-eu-central-1` for Israel). Free tier is fine for dev/staging.
3. Neon creates a default `main` branch with a `neondb` database.
4. Copy the **connection string** from **Connection Details**
   (toggle "Pooled connection" on for the app; use the direct/unpooled string
   for migrations if pooler causes DDL issues).

## 2. Shared box secrets

On the shared dev box, credentials live in a mode-600 env file:

```
/home/box/secrets/pricewatch.env
```

Load before running any DB command:

```bash
set -a && source /home/box/secrets/pricewatch.env && set +a
```

Keys in `pricewatch.env`:

- `DATABASE_URL` — Neon pooled connection string
- `DATABASE_URL_NODE` — prefer this for `node-pg` / `node-pg-migrate`
  if the pooler's `channel_binding` setting causes handshake errors

**Never paste connection strings or URLs into chat, PRs, or docs.**

## 3. Set DATABASE_URL locally (personal machine)

```bash
cp .env.example .env
# Edit .env — paste your Neon connection string (never commit .env):
# DATABASE_URL=postgres://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
```

**Never commit `.env`.** It is already in `.gitignore`.

Optionally set `DATABASE_URL_UNPOOLED` if you want to run migrations
against the direct (non-pooled) endpoint.

## 4. Set DATABASE_URL on Render (Wave 3)

When Render deploy is set up (F8), add the same env var in:

**Render Dashboard → Service → Environment → Secret Files / Env Vars**

Variable names to configure on Render:

- `DATABASE_URL` — required
- `DATABASE_URL_UNPOOLED` — optional (only if pooler breaks DDL)

Do **not** store credentials in the repo or in Render's `render.yaml` as
plaintext — use Render's secret env mechanism.

## 5. Migrate up / down

Run from the repo root with `DATABASE_URL` set (in `.env` or exported):

```bash
# Apply all pending migrations
npm run migrate:up

# Roll back the last migration
npm run migrate:down
```

Under the hood this uses [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate).
Migrations live in `migrations/` and are numbered JS files.

### Using DATABASE_URL_NODE for migrations

If the Neon pooler's `channel_binding` setting causes handshake errors
with `node-pg`, prefer `DATABASE_URL_NODE` (set in the shared box secrets
or your local `.env`):

```bash
npx node-pg-migrate up --database-url-var DATABASE_URL_NODE \
  --migration-file-language js --migrations-dir migrations
```

### Using the unpooled connection for migrations

If the pooler interferes with DDL (e.g. `CREATE TABLE` errors with
"prepared statement already exists"), use the direct endpoint via
`DATABASE_URL_UNPOOLED`:

```bash
npx node-pg-migrate up --database-url-var DATABASE_URL_UNPOOLED \
  --migration-file-language js --migrations-dir migrations
```

## 6. Fail-closed behavior

The app must fail closed (refuse to start DB features) when `DATABASE_URL`
is not set. See `src/db.js` — a pg Pool wrapper that throws when the env
var is missing if `PRICEWATCH_REQUIRE_DB=1` or `NODE_ENV=production`.

Existing file-based paths (lab, demos) do not need `DATABASE_URL` and
continue to work without it.

## 7. Testing migrations on a throwaway Neon branch

Chris can prove `migrate:up` / `migrate:down` without touching the team
database by using a Neon branch:

1. In Neon console → **Branches** → **New Branch** from `main`.
2. Copy the branch's connection string.
3. `DATABASE_URL=<branch-url> npm run migrate:up` — should succeed.
4. `DATABASE_URL=<branch-url> npm run migrate:down` — should succeed.
5. Delete the branch when done.

This keeps the shared `main` branch clean while validating migrations.

## 8. Proof

Proven locally on 2026-09-23 (Asia/Jerusalem) using `DATABASE_URL_NODE`
against a live Neon database with placeholder migration `1_schema-meta`:

| Command | Result |
|---|---|
| `npm run migrate:up` | EXIT 0 — `schema_meta` table created |
| `npm run migrate:down` | EXIT 0 — `schema_meta` table dropped |
| `npm run migrate:up` (re-apply) | EXIT 0 — `schema_meta` table re-created |

No connection strings or URLs recorded here.

## 9. CI and DATABASE_URL

Wave 1 CI does **not** require a live Neon connection. Tests that run in CI
(`npm test`) are unit/offline tests that do not touch the database.

If DB-dependent integration tests are added later, use GitHub Actions secrets
to inject `DATABASE_URL` for a dedicated Neon branch, or mock the connection.
