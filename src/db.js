'use strict';

const { Pool } = require('pg');

let pool = null;

/**
 * Returns a shared pg Pool connected via DATABASE_URL.
 * Fails closed: throws immediately if DATABASE_URL is not set.
 */
function getPool() {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Neon Postgres is required for DB features. ' +
      'See docs/neon-ops.md for setup instructions.'
    );
  }

  pool = new Pool({
    connectionString: url,
    ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  });

  return pool;
}

/**
 * Run a single query against the pool. Convenience wrapper.
 */
async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

/**
 * Gracefully close the pool (call on shutdown).
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, close };
