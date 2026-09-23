/**
 * Neon / Postgres connection helper (F1 — Rob).
 *
 * Pool from DATABASE_URL. Never log the connection string.
 *
 * Fail closed when DATABASE_URL is missing if:
 *   PRICEWATCH_REQUIRE_DB=1  OR  NODE_ENV=production
 *
 * Migration tip (ops): prefer DATABASE_URL_UNPOOLED, else DATABASE_URL_NODE,
 * else DATABASE_URL — see docs/neon-ops.md and .env.example.
 */
'use strict';

const { Pool } = require('pg');

let pool = null;

function requireDb() {
  return (
    process.env.PRICEWATCH_REQUIRE_DB === '1' ||
    process.env.NODE_ENV === 'production'
  );
}

function getDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (url && String(url).trim()) return String(url).trim();
  return null;
}

function getPool() {
  const url = getDatabaseUrl();
  if (!url) {
    if (requireDb()) {
      throw new Error(
        'DATABASE_URL is required (PRICEWATCH_REQUIRE_DB=1 or NODE_ENV=production). ' +
          'Set it from Neon Connection Details; never commit the value.'
      );
    }
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      // Neon requires TLS; connection string usually includes sslmode=require
      ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => {
      // Do not include connection string or query params in logs
      console.error('[db] pool error:', err && err.message ? err.message : err);
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) {
    throw new Error(
      'No database pool — DATABASE_URL is not set. ' +
        'Lab/file mode may omit it; set PRICEWATCH_REQUIRE_DB=1 to fail closed.'
    );
  }
  return p.query(text, params);
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = {
  query,
  getPool,
  closePool,
};
