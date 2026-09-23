/**
 * Neon-backed WatchTarget store (F2).
 *
 * Canonical unit of watch for B2B and B2C (surface: b2b | b2c).
 * When a DB pool exists (DATABASE_URL / DATABASE_URL_NODE), Neon is authoritative.
 * Competitor API maps to WatchTarget with surface=b2b — see docs/watch-target.md.
 *
 * Token budget: 0 LLM.
 */
"use strict";

const crypto = require("crypto");
const path = require("path");
const { query, getPool } = require("./db");

const VALID_SURFACES = Object.freeze(["b2b", "b2c"]);
const VALID_STATUSES = Object.freeze([
  "pending_onboarding",
  "skill_ready",
  "unsupported",
  "needs_ceo",
  "error",
]);
const slotConstants = require("./slot-store");
const MAX_WATCH_TARGETS = slotConstants.UNLIMITED_SOFT_CAP;

function dbAvailable() {
  return !!getPool();
}

function generateId() {
  return crypto.randomBytes(6).toString("hex");
}

function skillIdFromPath(skillPath) {
  if (!skillPath) return null;
  return path.basename(String(skillPath), ".json");
}

function skillPathFromId(skillId) {
  if (!skillId) return null;
  return path.join("data", "skills", `${skillId}.json`);
}

function assertSurface(surface) {
  if (!VALID_SURFACES.includes(surface)) {
    throw new Error(
      `Invalid surface "${surface}"; expected one of: ${VALID_SURFACES.join(", ")}`
    );
  }
}

function assertStatus(status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(
      `Invalid status "${status}"; expected one of: ${VALID_STATUSES.join(", ")}`
    );
  }
}

function rowToWatchTarget(row) {
  if (!row) return null;
  return {
    id: row.id,
    customer_id: row.customer_id,
    surface: row.surface,
    label: row.label,
    source_url: row.source_url,
    target_description: row.target_description,
    plan_key: row.plan_key,
    skill_id: row.skill_id,
    status: row.status,
    failure_count: row.failure_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Map WatchTarget → legacy competitor shape (Service A / Service B compat). */
function toCompetitorShape(wt) {
  if (!wt) return null;
  return {
    id: wt.id,
    name: wt.label,
    pricingUrl: wt.source_url,
    targetPriceDescription: wt.target_description,
    status: wt.status,
    skillPath: skillPathFromId(wt.skill_id),
    addedAt:
      wt.created_at instanceof Date
        ? wt.created_at.toISOString()
        : wt.created_at,
  };
}

/**
 * Create a WatchTarget row.
 * @param {object} opts
 * @param {string} opts.customer_id
 * @param {"b2b"|"b2c"} opts.surface
 * @param {string} opts.label
 * @param {string} opts.source_url
 * @param {string} opts.target_description
 * @param {string} [opts.plan_key]
 * @param {string} [opts.skill_id]
 * @param {string} [opts.status] default pending_onboarding
 * @param {string} [opts.id] optional fixed id (competitor shim reuse)
 */
async function create(opts) {
  if (!dbAvailable()) {
    throw new Error("No database pool — cannot create WatchTarget without Neon");
  }
  const surface = opts.surface || "b2b";
  assertSurface(surface);
  const status = opts.status || "pending_onboarding";
  assertStatus(status);

  const customerId = opts.customer_id;
  if (!customerId) throw new Error("customer_id is required");
  if (!opts.label) throw new Error("label is required");
  if (opts.source_url == null || opts.source_url === undefined) {
    throw new Error("source_url is required (may be empty string)");
  }
  if (!opts.target_description) throw new Error("target_description is required");

  const countRes = await query(
    "SELECT COUNT(*)::int AS n FROM watch_targets WHERE customer_id = $1",
    [customerId]
  );
  if (countRes.rows[0].n >= MAX_WATCH_TARGETS) {
    return { error: "max_watch_targets_reached", limit: MAX_WATCH_TARGETS };
  }

  const id = opts.id || generateId();
  const res = await query(
    `INSERT INTO watch_targets (
       id, customer_id, surface, label, source_url, target_description,
       plan_key, skill_id, status, failure_count, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, 0, now(), now()
     )
     RETURNING *`,
    [
      id,
      customerId,
      surface,
      opts.label,
      opts.source_url,
      opts.target_description,
      opts.plan_key || null,
      opts.skill_id || null,
      status,
    ]
  );
  return { watchTarget: rowToWatchTarget(res.rows[0]) };
}

async function getById(id) {
  if (!dbAvailable()) return null;
  const res = await query("SELECT * FROM watch_targets WHERE id = $1", [id]);
  return rowToWatchTarget(res.rows[0] || null);
}

async function listByCustomer(customerId, { surface } = {}) {
  if (!dbAvailable()) return [];
  let sql = "SELECT * FROM watch_targets WHERE customer_id = $1";
  const params = [customerId];
  if (surface) {
    assertSurface(surface);
    sql += " AND surface = $2";
    params.push(surface);
  }
  sql += " ORDER BY created_at ASC";
  const res = await query(sql, params);
  return res.rows.map(rowToWatchTarget);
}

async function updateStatus(id, { status, skill_id, failure_count } = {}) {
  if (!dbAvailable()) {
    throw new Error("No database pool — cannot update WatchTarget without Neon");
  }
  if (status) assertStatus(status);

  const sets = ["updated_at = now()"];
  const params = [];
  let i = 1;
  if (status !== undefined) {
    sets.push(`status = $${i++}`);
    params.push(status);
  }
  if (skill_id !== undefined) {
    sets.push(`skill_id = $${i++}`);
    params.push(skill_id);
  }
  if (failure_count !== undefined) {
    sets.push(`failure_count = $${i++}`);
    params.push(failure_count);
  }
  params.push(id);
  const res = await query(
    `UPDATE watch_targets SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    params
  );
  return rowToWatchTarget(res.rows[0] || null);
}

/** Convenience: set skill + typically status=skill_ready. */
async function updateSkill(id, { skill_id, status } = {}) {
  return updateStatus(id, {
    skill_id,
    status: status || (skill_id ? "skill_ready" : undefined),
  });
}

module.exports = {
  VALID_SURFACES,
  VALID_STATUSES,
  MAX_WATCH_TARGETS,
  dbAvailable,
  generateId,
  skillIdFromPath,
  skillPathFromId,
  create,
  getById,
  listByCustomer,
  updateStatus,
  updateSkill,
  toCompetitorShape,
  rowToWatchTarget,
};
