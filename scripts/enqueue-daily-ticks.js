#!/usr/bin/env node
"use strict";

/**
 * Enqueue daily monitor ticks for B2B + B2C WatchTargets with skill_ready status.
 *
 * Wave 4/5: reads from Neon watch_targets table — NOT data/customers.json.
 * Falls back to file-based monitor-queue when DATABASE_URL is not set (lab only).
 *
 * Wave 5: surface IN ('b2b','b2c') — same hosted Neon + ledger spine.
 *
 * Idempotent: at most one claimed ledger row per (watch_target, Jerusalem day).
 * Second run same day → no duplicates (ON CONFLICT DO NOTHING).
 *
 * Kill switch: PRICEWATCH_KILL=1 or data/KILL → no-op.
 *
 * Usage:
 *   node scripts/enqueue-daily-ticks.js
 *   npm run enqueue-daily
 */

const fs = require("fs");
const path = require("path");

const KILL_FILE = path.join(__dirname, "..", "data", "KILL");

function isKilled() {
  if (process.env.PRICEWATCH_KILL === "1") return true;
  if (fs.existsSync(KILL_FILE)) return true;
  return false;
}

function isLabHost(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
  }
}

async function runNeonPath() {
  const { query } = require("../src/db");
  const ledger = require("../src/neon-ledger");
  const day = ledger.jerusalemDate();

  console.log(`[enqueue-daily] Neon path — Jerusalem date: ${day}`);

  // Wave 5: both surfaces share the hosted daily path (same ledger).
  const res = await query(
    `SELECT wt.id, wt.customer_id, wt.skill_id, wt.label, wt.source_url, wt.surface,
            wt.product_offer_id
     FROM watch_targets wt
     WHERE wt.surface IN ('b2b', 'b2c') AND wt.status = 'skill_ready'
     ORDER BY wt.created_at ASC`
  );

  const targets = res.rows;
  console.log(
    `[enqueue-daily] Found ${targets.length} skill_ready WatchTarget(s) in Neon (b2b+b2c)`
  );

  let claimed = 0;
  let skipped = 0;
  let labBlocked = 0;

  for (const wt of targets) {
    if (isLabHost(wt.source_url)) {
      console.log(
        `  [lab-blocked] ${wt.surface} ${wt.customer_id} / ${wt.skill_id} (${wt.label}) → localhost source_url skipped for hosted daily`
      );
      labBlocked++;
      continue;
    }

    const result = await ledger.claim({
      watchTargetId: wt.id,
      customerId: wt.customer_id,
      skillId: wt.skill_id,
    });

    if (result.killed) {
      console.log("[enqueue-daily] Kill switch activated mid-run — stopping.");
      return;
    }

    if (result.created) {
      console.log(
        `  [claim] ${wt.surface} ${wt.customer_id} / ${wt.skill_id} (${wt.label}) → claimed`
      );
      claimed++;
    } else {
      console.log(
        `  [skip]  ${wt.surface} ${wt.customer_id} / ${wt.skill_id} (${wt.label}) → already exists for ${day}`
      );
      skipped++;
    }
  }

  console.log(
    `[enqueue-daily] Done (Neon): ${claimed} claimed, ${skipped} skipped, ${labBlocked} lab-blocked`
  );
}

function runFilePath() {
  const monitorQueue = require("../src/monitor-queue");
  const CUSTOMERS_FILE = path.join(__dirname, "..", "data", "customers.json");

  console.log(`[enqueue-daily] File fallback path — Jerusalem date: ${monitorQueue.jerusalemDate()}`);

  let store = {};
  if (fs.existsSync(CUSTOMERS_FILE)) {
    try { store = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, "utf8")); } catch { store = {}; }
  }

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

      const fullPath = path.resolve(__dirname, "..", comp.skillPath);
      if (!fs.existsSync(fullPath)) {
        console.log(`  [warn] Customer ${customerId} competitor ${comp.id}: skill file not found at ${comp.skillPath}`);
        errors++;
        continue;
      }
      let skillId = null;
      try {
        const skill = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        skillId = skill.id || null;
      } catch { errors++; continue; }

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

  console.log(`[enqueue-daily] Done (file): ${enqueued} enqueued, ${skipped} skipped, ${errors} errors`);
}

async function main() {
  console.log(`[enqueue-daily] ${new Date().toISOString()}`);

  if (isKilled()) {
    console.log("[enqueue-daily] Kill switch active — no ticks enqueued.");
    return;
  }

  const { getPool } = require("../src/db");
  if (getPool()) {
    await runNeonPath();
  } else {
    runFilePath();
  }
}

main().catch((err) => {
  console.error("[enqueue-daily] Fatal:", err.message);
  process.exit(1);
});
