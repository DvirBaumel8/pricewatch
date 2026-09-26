/**
 * Neon-backed daily ledger — hosted replacement for file-based monitor-queue.
 *
 * One row per (watch_target_id, jerusalem_day).
 * claim()   → INSERT … ON CONFLICT DO NOTHING → idempotent one-per-day.
 * complete() → UPDATE status + result + reason.
 * listClaimed() → SELECT … WHERE status = 'claimed'.
 *
 * Bounded retry: MAX_RETRIES per entry per day.
 * Kill-aware: claim/complete check kill before acting.
 *
 * 0 LLM.
 */
"use strict";

const crypto = require("crypto");
const { query, getPool } = require("./db");

const MAX_RETRIES = 3;

function dbAvailable() {
  return !!getPool();
}

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

function jerusalemDate(date) {
  return (date || new Date()).toLocaleDateString("en-CA", {
    timeZone: "Asia/Jerusalem",
  });
}

function isKilled() {
  if (process.env.PRICEWATCH_KILL === "1") return true;
  const fs = require("fs");
  const path = require("path");
  const killFile = path.join(__dirname, "..", "data", "KILL");
  if (fs.existsSync(killFile)) return true;
  return false;
}

/**
 * Claim a daily slot for a watch target.
 * Idempotent: second call same (watch_target_id, day) returns created=false.
 * Kill switch: returns { created: false, killed: true }.
 */
async function claim({ watchTargetId, customerId, skillId }) {
  if (!dbAvailable()) {
    throw new Error("No database pool — daily ledger requires Neon");
  }
  if (isKilled()) {
    return { created: false, killed: true, entry: null };
  }

  const day = jerusalemDate();
  const id = generateId();

  const res = await query(
    `INSERT INTO daily_ledger (id, watch_target_id, customer_id, skill_id, jerusalem_day, status)
     VALUES ($1, $2, $3, $4, $5, 'claimed')
     ON CONFLICT (watch_target_id, jerusalem_day) DO NOTHING
     RETURNING *`,
    [id, watchTargetId, customerId, skillId || null, day]
  );

  if (res.rows.length === 0) {
    const existing = await query(
      `SELECT * FROM daily_ledger WHERE watch_target_id = $1 AND jerusalem_day = $2`,
      [watchTargetId, day]
    );
    return { created: false, killed: false, entry: existing.rows[0] || null };
  }

  return { created: true, killed: false, entry: res.rows[0] };
}

/**
 * Complete a ledger entry with result.
 * @param {string} ledgerId
 * @param {"success"|"failed"|"blocked"|"skipped"} status
 * @param {string} [result]
 * @param {string} [reason]
 */
async function complete(ledgerId, { status, result, reason }) {
  if (!dbAvailable()) {
    throw new Error("No database pool — daily ledger requires Neon");
  }

  const res = await query(
    `UPDATE daily_ledger
     SET status = $1, result = $2, reason = $3, updated_at = now()
     WHERE id = $4
     RETURNING *`,
    [status, result || null, reason || null, ledgerId]
  );

  if (res.rows.length === 0) {
    throw new Error(`Ledger entry not found: ${ledgerId}`);
  }
  return res.rows[0];
}

/**
 * List claimed entries for today (or a given day).
 */
async function listClaimed(day) {
  if (!dbAvailable()) return [];
  const d = day || jerusalemDate();
  const res = await query(
    `SELECT * FROM daily_ledger WHERE jerusalem_day = $1 AND status = 'claimed' ORDER BY created_at ASC`,
    [d]
  );
  return res.rows;
}

/**
 * List all entries for a given day.
 */
async function listByDay(day) {
  if (!dbAvailable()) return [];
  const d = day || jerusalemDate();
  const res = await query(
    `SELECT * FROM daily_ledger WHERE jerusalem_day = $1 ORDER BY created_at ASC`,
    [d]
  );
  return res.rows;
}

/**
 * Retry a failed entry if under MAX_RETRIES.
 * Resets status to 'claimed' and increments retry_count.
 */
async function retry(ledgerId) {
  if (!dbAvailable()) {
    throw new Error("No database pool — daily ledger requires Neon");
  }
  if (isKilled()) {
    return { retried: false, killed: true };
  }

  const res = await query(
    `UPDATE daily_ledger
     SET status = 'claimed', retry_count = retry_count + 1, updated_at = now()
     WHERE id = $1 AND status = 'failed' AND retry_count < $2
     RETURNING *`,
    [ledgerId, MAX_RETRIES]
  );

  if (res.rows.length === 0) {
    return { retried: false, killed: false };
  }
  return { retried: true, killed: false, entry: res.rows[0] };
}

module.exports = {
  dbAvailable,
  jerusalemDate,
  isKilled,
  claim,
  complete,
  listClaimed,
  listByDay,
  retry,
  MAX_RETRIES,
};
