#!/usr/bin/env node
"use strict";

/**
 * Service C — monitor worker.
 *
 * Consumes ticks from pendingMonitorTicks queue (data/monitor-ticks.json),
 * runs the monitor check (0 LLM on lab), snapshots, diffs, and writes:
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
const monitorQueue = require("../src/monitor-queue");
const { runMonitorCheck } = require("../src/monitor-lib");

const KILL_FILE = path.join(__dirname, "..", "data", "KILL");
const WATCH_MODE = process.argv.includes("--watch");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || "5000", 10);

function isKilled() {
  if (process.env.PRICEWATCH_KILL === "1") return true;
  if (fs.existsSync(KILL_FILE)) return true;
  return false;
}

async function processTick(tick) {
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
      console.log(`  [C] PRICE CHANGED: ${result.before.amount} → ${result.after.amount}`);
      console.log(`  [C] Email written: ${result.emailPath}`);
      monitorQueue.complete(tick.id, {
        status: "done",
        result: "price_changed",
        reason: `${result.before.amount} → ${result.after.amount}`,
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

async function runOnce() {
  const tick = monitorQueue.dequeue();
  if (!tick) {
    console.log("[C] No pending ticks.");
    return false;
  }
  await processTick(tick);
  return true;
}

async function runWatch() {
  console.log(`[C] Watch mode — polling every ${POLL_INTERVAL_MS}ms (Ctrl+C to stop)`);
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    if (isKilled()) {
      console.log("[C] Kill switch active — sleeping...");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const hadWork = await runOnce();
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

  if (WATCH_MODE) {
    await runWatch();
  } else {
    const pending = monitorQueue.pendingCount();
    console.log(`[C] ${pending} pending tick(s) in queue`);
    let processed = 0;
    while (true) {
      const hadWork = await runOnce();
      if (!hadWork) break;
      processed++;
    }
    console.log(`[C] Processed ${processed} tick(s). Exiting.`);
  }
}

main().catch((err) => {
  console.error("[C] Fatal error:", err.message);
  process.exit(1);
});
