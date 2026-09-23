/**
 * Slot / package store (F6 / CB-16).
 *
 * B2C watch-slot enforcement:
 *   - Free tier: 3 slots (granted on signup)
 *   - Purchasable packages: 1, 3, 5, 10, unlimited
 *   - Unlimited soft-cap: 50 WatchTargets (Q8 locked)
 *   - Ops alarm when approaching/hitting soft-cap
 *
 * FAIL if "unlimited" means no cap — Q8 locks soft-cap at 50.
 *
 * Token budget: 0 LLM.
 */
'use strict';

const crypto = require('crypto');
const { query, getPool } = require('./db');

const FREE_SLOTS = 3;
const UNLIMITED_SOFT_CAP = 50;
const SOFT_CAP_WARNING_THRESHOLD = 45;

const PACKAGE_TYPES = Object.freeze({
  free:      { slots: FREE_SLOTS,    label: 'Free' },
  pkg_1:     { slots: 1,             label: '1 Watch' },
  pkg_3:     { slots: 3,             label: '3 Watches' },
  pkg_5:     { slots: 5,             label: '5 Watches' },
  pkg_10:    { slots: 10,            label: '10 Watches' },
  unlimited: { slots: UNLIMITED_SOFT_CAP, label: 'Unlimited (soft-cap 50)' },
});

const VALID_PACKAGE_TYPES = Object.keys(PACKAGE_TYPES);

function dbAvailable() {
  return !!getPool();
}

function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Ops alarm hook — fires when a user approaches or hits the unlimited soft-cap.
 * In production, wire this to your metrics/alerting pipeline (Datadog, PagerDuty, etc.).
 * For now: structured log that ops monitoring can grep/alert on.
 */
function opsAlarmSoftCap({ userId, currentCount, softCap, event }) {
  const payload = {
    alarm: 'SOFT_CAP_WATCH_TARGETS',
    severity: event === 'hit' ? 'critical' : 'warning',
    user_id: userId,
    current_watch_count: currentCount,
    soft_cap: softCap,
    event,
    timestamp: new Date().toISOString(),
    action_required: 'Review user watch target count — potential scrape fan-out risk',
  };
  console.error(`[OPS_ALARM] ${JSON.stringify(payload)}`);
  return payload;
}

/**
 * Grant a package to a user.
 * On signup, auto-grant 'free' package (3 slots).
 * Payment or payment_stub grants a purchased package.
 */
async function grantPackage(userId, packageType, grantedVia) {
  if (!dbAvailable()) {
    throw new Error('No database pool — cannot grant package without Neon');
  }
  if (!VALID_PACKAGE_TYPES.includes(packageType)) {
    throw new Error(`Invalid package_type "${packageType}"; valid: ${VALID_PACKAGE_TYPES.join(', ')}`);
  }
  const validGrantMethods = ['signup', 'payment', 'payment_stub', 'admin'];
  if (!validGrantMethods.includes(grantedVia)) {
    throw new Error(`Invalid granted_via "${grantedVia}"; valid: ${validGrantMethods.join(', ')}`);
  }

  const slotCount = PACKAGE_TYPES[packageType].slots;
  const id = generateId();

  const res = await query(
    `INSERT INTO user_packages (id, user_id, package_type, slot_count, granted_via, active, created_at)
     VALUES ($1, $2, $3, $4, $5, true, now())
     RETURNING *`,
    [id, userId, packageType, slotCount, grantedVia]
  );
  return res.rows[0];
}

/**
 * Ensure user has a free-tier package. Idempotent — skips if already granted.
 */
async function ensureFreePackage(userId) {
  if (!dbAvailable()) return null;

  const existing = await query(
    `SELECT id FROM user_packages WHERE user_id = $1 AND package_type = 'free' AND active = true`,
    [userId]
  );
  if (existing.rows.length > 0) return existing.rows[0];
  return grantPackage(userId, 'free', 'signup');
}

/**
 * Compute total slots for a user across all active packages.
 * Unlimited is capped at UNLIMITED_SOFT_CAP (50).
 */
async function getTotalSlots(userId) {
  if (!dbAvailable()) return FREE_SLOTS;

  const res = await query(
    `SELECT package_type, slot_count FROM user_packages
     WHERE user_id = $1 AND active = true
     ORDER BY created_at ASC`,
    [userId]
  );

  let total = 0;
  let hasUnlimited = false;
  for (const row of res.rows) {
    if (row.package_type === 'unlimited') {
      hasUnlimited = true;
    }
    total += row.slot_count;
  }

  if (hasUnlimited && total > UNLIMITED_SOFT_CAP) {
    total = UNLIMITED_SOFT_CAP;
  }

  return total;
}

/**
 * Count currently used B2C watch slots for a user.
 * Counts watch_targets with surface='b2c' across all customers owned by user.
 */
async function getUsedSlots(userId) {
  if (!dbAvailable()) return 0;

  const res = await query(
    `SELECT COUNT(*)::int AS n FROM watch_targets wt
     JOIN customers c ON wt.customer_id = c.id
     WHERE c.user_id = $1 AND wt.surface = 'b2c'`,
    [userId]
  );
  return res.rows[0].n;
}

/**
 * Check if user can create a new B2C watch target.
 * Enforces slot limits and unlimited soft-cap.
 * Fires ops alarm when approaching/hitting soft-cap.
 *
 * Returns { allowed, reason?, total_slots, used_slots, remaining }.
 */
async function canCreateWatch(userId) {
  if (!dbAvailable()) {
    return { allowed: false, reason: 'no_database', total_slots: 0, used_slots: 0, remaining: 0 };
  }

  await ensureFreePackage(userId);

  const totalSlots = await getTotalSlots(userId);
  const usedSlots = await getUsedSlots(userId);
  const remaining = Math.max(0, totalSlots - usedSlots);

  if (usedSlots >= SOFT_CAP_WARNING_THRESHOLD && usedSlots < UNLIMITED_SOFT_CAP) {
    opsAlarmSoftCap({
      userId,
      currentCount: usedSlots,
      softCap: UNLIMITED_SOFT_CAP,
      event: 'approaching',
    });
  }

  if (usedSlots >= UNLIMITED_SOFT_CAP) {
    opsAlarmSoftCap({
      userId,
      currentCount: usedSlots,
      softCap: UNLIMITED_SOFT_CAP,
      event: 'hit',
    });
    return {
      allowed: false,
      reason: 'soft_cap_reached',
      total_slots: totalSlots,
      used_slots: usedSlots,
      remaining: 0,
    };
  }

  if (remaining <= 0) {
    return {
      allowed: false,
      reason: 'slots_exhausted',
      total_slots: totalSlots,
      used_slots: usedSlots,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    total_slots: totalSlots,
    used_slots: usedSlots,
    remaining,
  };
}

/**
 * List packages for a user.
 */
async function listPackages(userId) {
  if (!dbAvailable()) return [];
  const res = await query(
    `SELECT * FROM user_packages WHERE user_id = $1 AND active = true ORDER BY created_at ASC`,
    [userId]
  );
  return res.rows;
}

module.exports = {
  FREE_SLOTS,
  UNLIMITED_SOFT_CAP,
  SOFT_CAP_WARNING_THRESHOLD,
  PACKAGE_TYPES,
  VALID_PACKAGE_TYPES,
  dbAvailable,
  opsAlarmSoftCap,
  grantPackage,
  ensureFreePackage,
  getTotalSlots,
  getUsedSlots,
  canCreateWatch,
  listPackages,
};
