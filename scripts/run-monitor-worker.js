#!/usr/bin/env node
"use strict";

/**
 * Service C — monitor worker.
 *
 * Wave 4: dual-path — Neon ledger when DATABASE_URL is set, file-based
 * monitor-queue fallback for lab.
 *
 * Consumes claimed ledger entries (or pending file ticks), runs the
 * monitor check (0 LLM on lab), snapshots, diffs, and writes:
 *   - price_change email to outbox/ (customer-facing) on real change
 *   - ops_alert to outbox/ on failure/blocked
 *   - nothing on unchanged price
 *
 * Kill switch: data/KILL or PRICEWATCH_KILL=1 → no-ops all ticks.
 *
 * Usage:
 *   node scripts/run-monitor-worker.js          # process all pending, exit
 *   node scripts/run-monitor-worker.js --watch   # poll for ticks
 *   npm run service-c
 */

const fs = require("fs");
const path = require("path");
const { runMonitorCheck } = require("../src/monitor-lib");

const KILL_FILE = path.join(__dirname, "..", "data", "KILL");
const WATCH_MODE = process.argv.includes("--watch");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || "5000", 10);

function isKilled() {
  if (process.env.PRICEWATCH_KILL === "1") return true;
  if (fs.existsSync(KILL_FILE)) return true;
  return false;
}

function useNeon() {
  const { getPool } = require("../src/db");
  return !!getPool();
}

async function processNeonEntry(entry) {
  const ledger = require("../src/neon-ledger");
  const watchTargets = require("../src/watch-target-store");
  const customers = require("../src/customer-store");

  console.log(`\n[C] Processing ledger entry ${entry.id}`);
  console.log(`    Watch target: ${entry.watch_target_id}`);
  console.log(`    Customer: ${entry.customer_id}`);
  console.log(`    Skill: ${entry.skill_id}`);
  console.log(`    Day: ${entry.jerusalem_day}`);

  if (isKilled()) {
    console.log("  [C] Kill switch active — skipping.");
    await ledger.complete(entry.id, {
      status: "skipped",
      result: "kill_switch",
      reason: "Kill switch active",
    });
    return;
  }

  const wt = await watchTargets.getById(entry.watch_target_id);
  if (!wt) {
    console.log(`  [C] WatchTarget ${entry.watch_target_id} not found — marking blocked.`);
    await ledger.complete(entry.id, {
      status: "blocked",
      result: "watch_target_missing",
      reason: `WatchTarget ${entry.watch_target_id} not found in Neon`,
    });
    return;
  }

  const customer = await customers.getCustomer(entry.customer_id);
  const customerInfo = {
    customerId: entry.customer_id,
    customerEmail: customer ? customer.email : null,
    customerName: customer ? customer.name : null,
    surface: wt.surface || null,
  };

  // Wave 5 B2C: attach affiliate CTA stub + disclosure from ProductOffer.
  if (wt.surface === "b2c" && wt.product_offer_id) {
    try {
      const productOffers = require("../src/product-offer-store");
      const offer = await productOffers.getById(wt.product_offer_id);
      const fields = productOffers.affiliateFieldsForEmail(offer);
      if (fields) {
        customerInfo.productOfferId = fields.product_offer_id;
        customerInfo.affiliateClickUrl = fields.affiliate_click_url;
        customerInfo.disclosureSnippet = fields.disclosure_snippet;
      }
    } catch (e) {
      console.error(`  [C] ProductOffer lookup failed for ${wt.product_offer_id}: ${e.message}`);
    }
  }

  const skillId = entry.skill_id || wt.skill_id;
  if (!skillId) {
    console.log(`  [C] No skill_id — marking blocked.`);
    await ledger.complete(entry.id, {
      status: "blocked",
      result: "no_skill",
      reason: "No skill_id on WatchTarget or ledger entry",
    });
    return;
  }

  const skillPath = watchTargets.skillPathFromId(skillId);

  try {
    const result = await runMonitorCheck(skillId, {
      skillPath,
      customerInfo,
    });

    console.log(`  [C] Result: ${result.status}`);

    if (result.status === "price_changed") {
      if (result.before && result.after) {
        console.log(`  [C] PRICE CHANGED: ${result.before.amount} → ${result.after.amount}`);
      } else if (result.changes) {
        console.log(`  [C] PLANS CHANGED: ${result.changes.length} signal(s)`);
      }
      if (result.emailPath) {
        console.log(`  [C] Email written: ${result.emailPath}`);
      }
      await ledger.complete(entry.id, {
        status: "success",
        result: "price_changed",
        reason: result.before && result.after
          ? `${result.before.amount} → ${result.after.amount}`
          : result.reason || "plans_signal",
      });
    } else if (result.status === "no_email") {
      console.log(`  [C] No email: ${result.reason}`);
      await ledger.complete(entry.id, {
        status: "success",
        result: "no_email",
        reason: result.reason,
      });
    } else {
      console.log(`  [C] Failure: ${result.error}`);
      if (result.opsAlertPath) {
        console.log(`  [C] Ops alert: ${result.opsAlertPath}`);
      }
      await ledger.complete(entry.id, {
        status: "failed",
        result: result.status,
        reason: result.error,
      });
    }
  } catch (err) {
    console.error(`  [C] Unexpected error: ${err.message}`);
    await ledger.complete(entry.id, {
      status: "failed",
      result: "error",
      reason: err.message,
    });
  }
}

async function retryFailedEntries() {
  const ledger = require("../src/neon-ledger");
  const day = ledger.jerusalemDate();
  const all = await ledger.listByDay(day);
  const failed = all.filter((e) => e.status === "failed");
  let retried = 0;
  for (const entry of failed) {
    const res = await ledger.retry(entry.id);
    if (res.retried) {
      console.log(`[C] Retried failed ledger entry ${entry.id} (retry_count=${res.entry.retry_count})`);
      retried++;
    }
  }
  return retried;
}

async function runNeonOnce() {
  const ledger = require("../src/neon-ledger");

  await retryFailedEntries();

  const entries = await ledger.listClaimed();
  if (entries.length === 0) {
    console.log("[C] No claimed ledger entries.");
    return false;
  }
  for (const entry of entries) {
    if (isKilled()) {
      console.log("[C] Kill switch active mid-processing — stopping.");
      break;
    }
    await processNeonEntry(entry);
  }
  return true;
}

async function processFileTick(tick) {
  const monitorQueue = require("../src/monitor-queue");

  console.log(`\n[C] Processing tick ${tick.id}`);
  console.log(`    Customer: ${tick.customerId} (${tick.customerName || "?"})`);
  console.log(`    Skill: ${tick.skillId}`);
  console.log(`    Calendar day: ${tick.calendarDay}`);

  if (isKilled()) {
    console.log("  [C] Kill switch active — skipping tick.");
    monitorQueue.complete(tick.id, {
      status: "skipped",
      result: "kill_switch",
      reason: "Kill switch active",
    });
    return;
  }

  try {
    const result = await runMonitorCheck(tick.skillId, {
      skillPath: tick.skillPath,
      customerInfo: {
        customerId: tick.customerId,
        customerEmail: tick.customerEmail,
        customerName: tick.customerName,
      },
    });

    console.log(`  [C] Result: ${result.status}`);

    if (result.status === "price_changed") {
      if (result.before && result.after) {
        console.log(`  [C] PRICE CHANGED: ${result.before.amount} → ${result.after.amount}`);
      } else if (result.changes) {
        console.log(`  [C] PLANS CHANGED: ${result.changes.length} signal(s)`);
      }
      if (result.emailPath) {
        console.log(`  [C] Email written: ${result.emailPath}`);
      }
      monitorQueue.complete(tick.id, {
        status: "done",
        result: "price_changed",
        reason: result.before && result.after
          ? `${result.before.amount} → ${result.after.amount}`
          : result.reason || "plans_signal",
      });
    } else if (result.status === "no_email") {
      console.log(`  [C] No email: ${result.reason}`);
      monitorQueue.complete(tick.id, {
        status: "done",
        result: "no_email",
        reason: result.reason,
      });
    } else {
      console.log(`  [C] Failure: ${result.error}`);
      if (result.opsAlertPath) {
        console.log(`  [C] Ops alert: ${result.opsAlertPath}`);
      }
      monitorQueue.complete(tick.id, {
        status: "failed",
        result: result.status,
        reason: result.error,
      });
    }
  } catch (err) {
    console.error(`  [C] Unexpected error: ${err.message}`);
    monitorQueue.complete(tick.id, {
      status: "failed",
      result: "error",
      reason: err.message,
    });
  }
}

async function runFileOnce() {
  const monitorQueue = require("../src/monitor-queue");
  const tick = monitorQueue.dequeue();
  if (!tick) {
    console.log("[C] No pending ticks.");
    return false;
  }
  await processFileTick(tick);
  return true;
}

async function runWatch() {
  console.log(`[C] Watch mode — polling every ${POLL_INTERVAL_MS}ms (Ctrl+C to stop)`);
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  const neon = useNeon();
  while (running) {
    if (isKilled()) {
      console.log("[C] Kill switch active — sleeping...");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const hadWork = neon ? await runNeonOnce() : await runFileOnce();
    if (!hadWork && running) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  console.log("[C] Worker stopped.");
}

async function main() {
  console.log("[Service C] Monitor worker starting");

  if (isKilled()) {
    console.log("[C] Kill switch active — no-op.");
    return;
  }

  const neon = useNeon();
  console.log(`[C] Mode: ${neon ? "Neon ledger" : "file-based queue"}`);

  if (WATCH_MODE) {
    await runWatch();
  } else {
    if (neon) {
      await runNeonOnce();
    } else {
      const monitorQueue = require("../src/monitor-queue");
      const pending = monitorQueue.pendingCount();
      console.log(`[C] ${pending} pending tick(s) in queue`);
      let processed = 0;
      while (true) {
        const hadWork = await runFileOnce();
        if (!hadWork) break;
        processed++;
      }
      console.log(`[C] Processed ${processed} tick(s). Exiting.`);
    }
  }
}

main().catch((err) => {
  console.error("[C] Fatal error:", err.message);
  process.exit(1);
});
