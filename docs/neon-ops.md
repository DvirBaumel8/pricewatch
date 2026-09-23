# Neon Postgres — ops note (F1)

## 1. Create a Neon project

1. Sign up / log in at <https://console.neon.tech>.
2. **Create Project** → pick a name (e.g. `pricewatch-dev`), region closest
   to you (or `aws-eu-central-1` for Israel). Free tier is fine for dev/staging.
3. Neon creates a default `main` branch with a `neondb` database.
4. Copy the **connection string** from **Connection Details**
   (toggle "Pooled connection" on for the app; use the direct/unpooled string
   for migrations if pooler causes DDL issues).

## 2. Set DATABASE_URL locally

```bash
cp .env.example .env
# Edit .env — paste your Neon connection string:
# DATABASE_URL=postgres://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
```

**Never commit `.env`.** It is already in `.gitignore`.

Optionally set `DATABASE_URL_UNPOOLED` if you want to run migrations
against the direct (non-pooled) endpoint.

## 3. Set DATABASE_URL on Render (Wave 3)

When Render deploy is set up (F8), add the same env var in:

**Render Dashboard → Service → Environment → Secret Files / Env Vars**

Variable names to configure on Render:

- `DATABASE_URL` — required
- `DATABASE_URL_UNPOOLED` — optional (only if pooler breaks DDL)

Do **not** store credentials in the repo or in Render's `render.yaml` as
plaintext — use Render's secret env mechanism.

## 4. Migrate up / down

Run from the repo root with `DATABASE_URL` set (in `.env` or exported):

```bash
# Apply all pending migrations
npm run migrate:up

# Roll back the last migration
npm run migrate:down
```

Under the hood this uses [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate).
Migrations live in `migrations/` and are numbered JS files.

### Using the unpooled connection for migrations

If the Neon pooler (PgBouncer) interferes with DDL (e.g. `CREATE TABLE` errors
with "prepared statement already exists"), use the direct endpoint:

```bash
DATABASE_URL_UNPOOLED=postgres://user:pass@ep-xxx.region.aws.neon.tech/neondb \
  npx node-pg-migrate up --database-url-var DATABASE_URL_UNPOOLED \
  --migration-file-language js --migrations-dir migrations
```

## 5. Fail-closed behavior

The app must fail closed (refuse to start DB features) when `DATABASE_URL`
is not set. Rob will add `src/db.js` with this behavior — a pg Pool
wrapper that throws immediately if the env var is missing.

Existing file-based paths (lab, demos) do not need `DATABASE_URL` and
continue to work without it.

## 6. Testing migrations on a throwaway Neon branch

Chris can prove `migrate:up` / `migrate:down` without touching the team
database by using a Neon branch:

1. In Neon console → **Branches** → **New Branch** from `main`.
2. Copy the branch's connection string.
3. `DATABASE_URL=<branch-url> npm run migrate:up` — should succeed.
4. `DATABASE_URL=<branch-url> npm run migrate:down` — should succeed.
5. Delete the branch when done.

This keeps the shared `main` branch clean while validating migrations.

## 7. CI and DATABASE_URL

Wave 1 CI does **not** require a live Neon connection. Tests that run in CI
(`npm test`) are unit/offline tests that do not touch the database.

If DB-dependent integration tests are added later, use GitHub Actions secrets
to inject `DATABASE_URL` for a dedicated Neon branch, or mock the connection.
