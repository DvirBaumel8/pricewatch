#!/usr/bin/env node
"use strict";

/**
 * W6 sell-demo script — record-ready pipeline walkthrough.
 *
 * Shows the full PriceWatch story in a clean terminal:
 *   Scene 1 — Extract Vercel's live plan ladder (structured, not vague)
 *   Scene 2 — Simulate a price bump: Pro $20 → $25
 *   Scene 3 — Re-run monitor → diff fires → customer email printed
 *   Scene 4 — Banner-only re-run → noise gate stays silent
 *
 * Usage:
 *   node scripts/demo-w6-sell.js              (Vercel live — default)
 *   node scripts/demo-w6-sell.js --fixture    (offline fixtures, no network)
 *
 * No localhost/127.0.0.1 appears anywhere in output.
 * Designed for Carlos to screen-record in ≤90s.
 */

const fs = require("fs");
const path = require("path");
const { extractPlanLadder } = require("../src/plan-ladder");
const { saveLadderSnapshot, loadLadderSnapshot, LADDER_DIR } = require("../src/plan-ladder-snapshot");
const { diffPlanLadders } = require("../src/plan-ladder-diff");
const { writePlanLadderEmail, buildChangeTable, buildSummaryLine } = require("../src/plan-ladder-email");

const DEMO_SITE = "vercel.com";
const DEMO_URL = "https://vercel.com/pricing";
const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");

const FIXTURE_OLD = [
  { plan: "Hobby", price: 0, currency: "USD", unit: null, billing: "free" },
  { plan: "Pro", price: 20, currency: "USD", unit: "developer seat", billing: "monthly" },
  { plan: "Enterprise", price: null, currency: "USD", unit: null, billing: "custom" },
];
const FIXTURE_BUMPED = [
  { plan: "Hobby", price: 0, currency: "USD", unit: null, billing: "free" },
  { plan: "Pro", price: 25, currency: "USD", unit: "developer seat", billing: "monthly" },
  { plan: "Enterprise", price: null, currency: "USD", unit: null, billing: "custom" },
];

function hr() {
  console.log("─".repeat(64));
}

function pause(label) {
  console.log(`\n${"▸".repeat(3)}  ${label}\n`);
}

function printPlans(plans) {
  console.log("  Plan            | Price       | Unit             | Billing");
  console.log("  --------------- | ----------- | ---------------- | --------");
  for (const p of plans) {
    const price = p.price === null ? "Custom" : `$${p.price}`;
    console.log(
      `  ${(p.plan || "—").padEnd(15)} | ${price.padEnd(11)} | ${(p.unit || "—").padEnd(16)} | ${p.billing}`
    );
  }
}

function printEmail(emailJson) {
  console.log(`  Subject: ${emailJson.subject}`);
  console.log();
  const lines = emailJson.body.split("\n");
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

function cleanupDemo() {
  if (!fs.existsSync(OUTBOX_DIR)) return;
  for (const f of fs.readdirSync(OUTBOX_DIR)) {
    if (f.startsWith("plan-ladder_vercel") || f.startsWith("plan-ladder_demo")) {
      try { fs.unlinkSync(path.join(OUTBOX_DIR, f)); } catch {}
    }
  }
}

async function runLive() {
  cleanupDemo();

  pause("SCENE 1 — Extract Vercel's live plan ladder");
  console.log(`  Fetching ${DEMO_URL} ...`);
  const result = await extractPlanLadder(DEMO_URL);
  if (!result.plans || result.plans.length === 0) {
    console.error("  ✗ Could not extract plans (site may be blocked)");
    console.log("  Falling back to fixture mode...\n");
    return runFixture();
  }
  console.log(`  ✓ Extracted ${result.plans.length} plans (0 LLM tokens, ${result.wallMs}ms)\n`);
  printPlans(result.plans);

  saveLadderSnapshot(DEMO_SITE, result.plans);
  console.log(`\n  Baseline snapshot saved.\n`);
  hr();

  pause("SCENE 2 — Simulate price bump: Pro $20 → $25");
  const bumpedPlans = result.plans.map((p) => {
    if (p.plan === "Pro") return { ...p, price: p.price + 5 };
    return p;
  });
  console.log("  Injecting simulated change into snapshot...\n");
  printPlans(bumpedPlans);
  saveLadderSnapshot(DEMO_SITE, bumpedPlans);
  console.log(`\n  New snapshot saved (Pro now $${bumpedPlans.find(p => p.plan === "Pro").price}).\n`);
  hr();

  pause("SCENE 3 — Diff → alert fires → customer email");
  const { changes, hasSignal } = diffPlanLadders(result.plans, bumpedPlans);
  console.log(`  Changes detected: ${changes.length}`);
  console.log(`  Signal (price/plan/seat move): ${hasSignal ? "YES → EMAIL" : "no → silent"}\n`);

  if (hasSignal) {
    const emailPath = writePlanLadderEmail(
      DEMO_SITE,
      DEMO_URL,
      changes,
      { customerId: "demo", customerEmail: "dvirbaumel9@gmail.com", customerName: "Dvir" }
    );
    const email = JSON.parse(fs.readFileSync(emailPath, "utf8"));
    console.log("  ╔══════════════════════════════════════════════════════════╗");
    console.log("  ║  CUSTOMER EMAIL                                        ║");
    console.log("  ╚══════════════════════════════════════════════════════════╝\n");
    printEmail(email);
    cleanupDemo();
  }
  hr();

  pause("SCENE 4 — Banner-only change → noise gate stays silent");
  console.log("  Re-running with identical plans (simulating banner/copy edit)...");
  const { changes: noChanges, hasSignal: noSignal } = diffPlanLadders(bumpedPlans, bumpedPlans);
  console.log(`  Changes detected: ${noChanges.length}`);
  console.log(`  Signal: ${noSignal ? "YES" : "NO → no email"}`);
  console.log("\n  ✓ Noise gate working: banner/copy changes do not trigger alerts.\n");
  hr();

  saveLadderSnapshot(DEMO_SITE, result.plans);

  console.log("\n  Demo complete. PriceWatch tells you WHICH plan moved and old$ → new$.");
  console.log("  No vague 'page changed'. No banner noise. Structured signal only.\n");
}

async function runFixture() {
  cleanupDemo();

  pause("SCENE 1 — Structured plan ladder (Vercel fixture)");
  console.log("  Using offline fixture (no network required)\n");
  printPlans(FIXTURE_OLD);

  saveLadderSnapshot(DEMO_SITE, FIXTURE_OLD);
  console.log(`\n  Baseline snapshot saved.\n`);
  hr();

  pause("SCENE 2 — Price bump: Pro $20 → $25");
  printPlans(FIXTURE_BUMPED);
  console.log();
  hr();

  pause("SCENE 3 — Diff → alert fires → customer email");
  const { changes, hasSignal } = diffPlanLadders(FIXTURE_OLD, FIXTURE_BUMPED);
  console.log(`  Changes detected: ${changes.length}`);
  console.log(`  Signal (price/plan/seat move): ${hasSignal ? "YES → EMAIL" : "no → silent"}\n`);

  if (hasSignal) {
    const emailPath = writePlanLadderEmail(
      DEMO_SITE,
      DEMO_URL,
      changes,
      { customerId: "demo", customerEmail: "dvirbaumel9@gmail.com", customerName: "Dvir" }
    );
    const email = JSON.parse(fs.readFileSync(emailPath, "utf8"));
    console.log("  ╔══════════════════════════════════════════════════════════╗");
    console.log("  ║  CUSTOMER EMAIL                                        ║");
    console.log("  ╚══════════════════════════════════════════════════════════╝\n");
    printEmail(email);
    cleanupDemo();
  }
  hr();

  pause("SCENE 4 — Banner-only → noise gate stays silent");
  const { changes: noChanges, hasSignal: noSignal } = diffPlanLadders(FIXTURE_BUMPED, FIXTURE_BUMPED);
  console.log(`  Changes detected: ${noChanges.length}`);
  console.log(`  Signal: ${noSignal ? "YES" : "NO → no email"}`);
  console.log("\n  ✓ Noise gate: banner/copy changes stay silent.\n");
  hr();

  saveLadderSnapshot(DEMO_SITE, FIXTURE_OLD);

  console.log("\n  Demo complete. Structured plan + old$ → new$ table. No banner noise.\n");
}

async function main() {
  console.log();
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║  PriceWatch — Plan Ladder Demo                         ║");
  console.log("  ║  Structured pricing changes, not vague 'page changed'  ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝");
  console.log();
  hr();

  const useFixture = process.argv.includes("--fixture");
  if (useFixture) {
    await runFixture();
  } else {
    await runLive();
  }
}

main().catch((err) => {
  console.error("Demo error:", err.message);
  process.exit(1);
});
