#!/usr/bin/env node
"use strict";

/**
 * Enqueue daily monitor ticks for all customers with skill_ready competitors.
 *
 * Scans data/customers.json for competitors with status "skill_ready",
 * resolves the skill ID from the skill file, and enqueues a monitor tick
 * for each into pendingMonitorTicks (data/monitor-ticks.json).
 *
 * Idempotent: at most one pending tick per (customer, skill, Jerusalem calendar day).
 * Second run same day → no duplicates.
 *
 * Kill switch: if data/KILL exists or PRICEWATCH_KILL=1 → no-op.
 *
 * Usage:
 *   node scripts/enqueue-daily-ticks.js
 *   npm run enqueue-daily
 */

const fs = require("fs");
const path = require("path");
const monitorQueue = require("../src/monitor-queue");

const KILL_FILE = path.join(__dirname, "..", "data", "KILL");
const CUSTOMERS_FILE = path.join(__dirname, "..", "data", "customers.json");

function isKilled() {
  if (process.env.PRICEWATCH_KILL === "1") return true;
  if (fs.existsSync(KILL_FILE)) return true;
  return false;
}

function loadCustomers() {
  if (!fs.existsSync(CUSTOMERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function resolveSkillId(skillPath) {
  const fullPath = path.resolve(__dirname, "..", skillPath);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const skill = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    return skill.id || null;
  } catch {
    return null;
  }
}

function main() {
  console.log(`[enqueue-daily] ${new Date().toISOString()}`);
  console.log(`[enqueue-daily] Jerusalem date: ${monitorQueue.jerusalemDate()}`);

  if (isKilled()) {
    console.log("[enqueue-daily] Kill switch active — no ticks enqueued.");
    return;
  }

  const store = loadCustomers();
  const customers = store.customers || {};
  let enqueued = 0;
  let skipped = 0;
  let errors = 0;

  for (const [customerId, customer] of Object.entries(customers)) {
    if (!customer.competitors || customer.competitors.length === 0) continue;

    for (const comp of customer.competitors) {
      if (comp.status !== "skill_ready") continue;
      if (!comp.skillPath) {
        console.log(`  [warn] Customer ${customerId} competitor ${comp.id}: skill_ready but no skillPath`);
        errors++;
        continue;
      }

      const skillId = resolveSkillId(comp.skillPath);
      if (!skillId) {
        console.log(`  [warn] Customer ${customerId} competitor ${comp.id}: skill file not found at ${comp.skillPath}`);
        errors++;
        continue;
      }

      const result = monitorQueue.enqueue({
        customerId,
        skillId,
        skillPath: comp.skillPath,
        customerEmail: customer.email || null,
        customerName: customer.name || null,
      });

      if (result.created) {
        console.log(`  [tick] ${customerId} / ${skillId} → enqueued (${result.tick.id})`);
        enqueued++;
      } else {
        console.log(`  [skip] ${customerId} / ${skillId} → already exists for today (${result.tick.id})`);
        skipped++;
      }
    }
  }

  console.log(`[enqueue-daily] Done: ${enqueued} enqueued, ${skipped} skipped, ${errors} errors`);
}

main();
