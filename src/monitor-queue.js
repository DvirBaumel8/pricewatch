/**
 * Durable file-based queue for pendingMonitorTicks.
 *
 * Stores ticks as JSON in data/monitor-ticks.json — survives process restart.
 * Same style as src/queue.js (onboarding queue) but for daily monitor checks.
 *
 * Idempotency: at most one pending tick per (customerId, skillId, calendarDay)
 * where calendarDay is Asia/Jerusalem date.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const QUEUE_FILE = path.join(__dirname, "..", "data", "monitor-ticks.json");

function ensureDir() {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
}

function loadQueue() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveQueue(ticks) {
  ensureDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(ticks, null, 2) + "\n");
}

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

function jerusalemDate(date) {
  return (date || new Date()).toLocaleDateString("en-CA", {
    timeZone: "Asia/Jerusalem",
  });
}

/**
 * Enqueue a monitor tick. Idempotent: if a pending or running tick already
 * exists for the same customer+skill on the same Jerusalem calendar day, skip.
 * Also skips if a "done" tick exists for the same day (already checked today).
 */
function enqueue({ customerId, skillId, skillPath, customerEmail, customerName }) {
  const ticks = loadQueue();
  const today = jerusalemDate();

  const existing = ticks.find(
    (t) =>
      t.customerId === customerId &&
      t.skillId === skillId &&
      t.calendarDay === today &&
      (t.status === "pending" || t.status === "running" || t.status === "done")
  );
  if (existing) {
    return { tick: existing, created: false };
  }

  const tick = {
    id: generateId(),
    customerId,
    customerName: customerName || null,
    customerEmail: customerEmail || null,
    skillId,
    skillPath,
    calendarDay: today,
    status: "pending",
    result: null,
    reason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  ticks.push(tick);
  saveQueue(ticks);
  return { tick, created: true };
}

/**
 * Claim the next pending tick (mark it running). Returns null if empty.
 */
function dequeue() {
  const ticks = loadQueue();
  const next = ticks.find((t) => t.status === "pending");
  if (!next) return null;
  next.status = "running";
  next.updatedAt = new Date().toISOString();
  saveQueue(ticks);
  return next;
}

/**
 * Mark a tick done/failed with result and reason.
 */
function complete(tickId, { status, result, reason }) {
  const ticks = loadQueue();
  const tick = ticks.find((t) => t.id === tickId);
  if (!tick) throw new Error(`Tick not found: ${tickId}`);
  tick.status = status;
  tick.result = result || null;
  tick.reason = reason || null;
  tick.updatedAt = new Date().toISOString();
  saveQueue(ticks);
  return tick;
}

function listTicks(filter) {
  const ticks = loadQueue();
  if (!filter) return ticks;
  return ticks.filter((t) => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.customerId && t.customerId !== filter.customerId) return false;
    if (filter.calendarDay && t.calendarDay !== filter.calendarDay) return false;
    return true;
  });
}

function pendingCount() {
  return loadQueue().filter((t) => t.status === "pending").length;
}

module.exports = { enqueue, dequeue, complete, listTicks, pendingCount, loadQueue, saveQueue, jerusalemDate, QUEUE_FILE };
