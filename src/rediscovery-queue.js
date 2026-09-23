/**
 * Rediscovery queue (F3) — step2-only, 0 LLM.
 *
 * When failure_count hits PRICEWATCH_FAILURE_THRESHOLD, Service C marks the
 * skill unhealthy and enqueues a rediscovery hint here. Service B (or a
 * future worker) may consume these; F3 only requires the hook exists.
 *
 * File: data/rediscovery-queue.json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const QUEUE_FILE = path.join(__dirname, "..", "data", "rediscovery-queue.json");

function ensureDir() {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(items) {
  ensureDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2) + "\n");
}

/**
 * Enqueue a step2-only rediscovery request. Idempotent while pending/running
 * for the same skillId.
 */
function enqueue({ skillId, skillPath, pricingUrl, target, reason }) {
  const items = load();
  const dup = items.find(
    (j) =>
      j.skillId === skillId &&
      (j.status === "pending" || j.status === "running")
  );
  if (dup) return { job: dup, created: false };

  const job = {
    id: crypto.randomBytes(8).toString("hex"),
    skillId,
    skillPath: skillPath || null,
    pricingUrl: pricingUrl || null,
    target: target || null,
    reason: reason || "failure_threshold",
    step2Only: true,
    llmTokens: 0,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  items.push(job);
  save(items);
  return { job, created: true };
}

function list(filter) {
  const items = load();
  if (!filter) return items;
  return items.filter((j) => {
    if (filter.status && j.status !== filter.status) return false;
    if (filter.skillId && j.skillId !== filter.skillId) return false;
    return true;
  });
}

module.exports = { enqueue, list, QUEUE_FILE };
