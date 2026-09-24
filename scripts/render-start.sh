#!/usr/bin/env bash
set -euo pipefail

# Render start script for PriceWatch Service A.
# Binds to 0.0.0.0, maps Render PORT, runs migrations, starts the server.

export SERVICE_A_HOST="0.0.0.0"
export SERVICE_A_PORT="${PORT:-3850}"

if [ "${NODE_ENV:-}" = "production" ]; then
  if [ -z "${DATABASE_URL:-}" ] && [ -z "${DATABASE_URL_NODE:-}" ]; then
    echo "FATAL: DATABASE_URL or DATABASE_URL_NODE must be set in production." >&2
    exit 1
  fi
fi

# Run migrations. Prefer DATABASE_URL_NODE (avoids pooler/channel_binding
# issues with node-pg-migrate), fall back to DATABASE_URL.
if [ -n "${DATABASE_URL_NODE:-}" ]; then
  MIGRATE_VAR="DATABASE_URL_NODE"
elif [ -n "${DATABASE_URL:-}" ]; then
  MIGRATE_VAR="DATABASE_URL"
else
  MIGRATE_VAR=""
fi

if [ -n "$MIGRATE_VAR" ]; then
  echo "Running migrations (--database-url-var $MIGRATE_VAR)..."
  npx node-pg-migrate up \
    --database-url-var "$MIGRATE_VAR" \
    --migration-file-language js \
    --migrations-dir migrations
  echo "Migrations complete."
else
  echo "No DATABASE_URL set — skipping migrations."
fi

echo "Starting Service A on ${SERVICE_A_HOST}:${SERVICE_A_PORT}..."
exec node src/service-a.js
