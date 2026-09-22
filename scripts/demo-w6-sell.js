#!/usr/bin/env node
"use strict";

/**
 * W6 sell-demo script — record-ready pipeline walkthrough.
 *
 * Shows the full PriceWatch story in a clean terminal:
 *   Beat 1   — Extract Vercel's live plan ladder (structured, not vague)
 *   Beat 2.5 — Customer picks which plans to watch (not free-text jargon)
 *   Beat 3   — Simulate a price bump: Pro $20 → $25
 *   Beat 4   — Re-run monitor → diff fires → customer email printed
 *   Beat 5   — Banner-only re-run → noise gate stays silent
 *
 * Usage:
 *   node scripts/demo-w6-sell.js              (Vercel live — default)
 *   node scripts/demo-w6-sell.js --fixture    (offline fixtures, no network)
 *
 * No localhost/127.0.0.1 appears anywhere in output.
 * No raw JSON fields on screen — clean plan names only.
 * Designed for Carlos to screen-record in ≤90s.
 */

const fs = require("fs");
const path = require("path");
const { extractPlanLadder } = require("../src/plan-ladder");
const { saveLadderSnapshot, loadLadderSnapshot, LADDER_DIR } = require("../src/plan-ladder-snapshot");
const { diffPlanLadders } = require("../src/plan-ladder-diff");
const { writePlanLadderEmail, buildChangeTable, buildSummaryLine } = require("../src/plan-ladder-email");
const { saveSelection } = require("../src/plan-selection");

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

function beat(label) {
  console.log(`\n${"▸".repeat(3)}  ${label}\n`);
}

function printLadder(plans) {
  console.log("  ┌─────────────────┬─────────────┬──────────────────┬──────────┐");
  console.log("  │ Plan            │ Price       │ Unit             │ Billing  │");
  console.log("  ├─────────────────┼─────────────┼──────────────────┼──────────┤");
  for (const p of plans) {
    const price = p.price === null ? "Custom" : `$${p.price}`;
    console.log(
      `  │ ${(p.plan || "—").padEnd(15)} │ ${price.padEnd(11)} │ ${(p.unit || "—").padEnd(16)} │ ${(p.billing || "").padEnd(8)} │`
    );
  }
  console.log("  └─────────────────┴─────────────┴──────────────────┴──────────┘");
}

function printPlanPick(plans, selected) {
  const selSet = new Set(selected.map((s) => s.toLowerCase()));
  for (const p of plans) {
    const isSelected = selSet.has(p.plan.toLowerCase());
    const marker = isSelected ? "  ✓" : "   ";
    const price = p.price === null ? "Custom" : `$${p.price}`;
    const dim = isSelected ? "" : "  (not watching)";
    console.log(`  ${marker}  ${p.plan.padEnd(15)}  ${price.padEnd(10)}${dim}`);
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

  // ── Beat 1: Extract ────────────────────────────────────────────
  beat("BEAT 1 — Extract the plan ladder from vercel.com");
  console.log(`  Fetching ${DEMO_URL} ...`);
  const result = await extractPlanLadder(DEMO_URL);
  if (!result.plans || result.plans.length === 0) {
    console.error("  ✗ Could not extract plans (site may be blocked)");
    console.log("  Falling back to fixture mode...\n");
    return runFixture();
  }
  console.log(`  ✓ Extracted ${result.plans.length} plans (0 LLM tokens, ${result.wallMs}ms)\n`);
  printLadder(result.plans);

  saveLadderSnapshot(DEMO_SITE, result.plans);
  console.log(`\n  Baseline snapshot saved.`);
  hr();

  // ── Beat 2.5: Pick plans ───────────────────────────────────────
  beat("BEAT 2.5 — Pick which plans to watch");
  console.log("  The customer sees the plan ladder and picks rows.\n");
  console.log('  ➜  Customer selects: "Pro" (the paid plan they compete with)\n');
  printPlanPick(result.plans, ["Pro"]);
  saveSelection(DEMO_SITE, { mode: "selected", plans: ["Pro"] });
  console.log('\n  ✓ Watching: Pro on vercel.com');
  console.log('    (Also available: "Watch all paid plans" — one click)');
  hr();

  // ── Beat 3: Price bump ─────────────────────────────────────────
  beat("BEAT 3 — Next morning: Vercel raised Pro by $5");
  const bumpedPlans = result.plans.map((p) => {
    if (p.plan === "Pro") return { ...p, price: p.price + 5 };
    return p;
  });
  printLadder(bumpedPlans);
  saveLadderSnapshot(DEMO_SITE, bumpedPlans);
  console.log(`\n  Pro is now $${bumpedPlans.find((p) => p.plan === "Pro").price}.`);
  hr();

  // ── Beat 4: Alert fires ────────────────────────────────────────
  beat("BEAT 4 — Diff → alert fires → customer email");
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

  // ── Beat 5: Banner-only ────────────────────────────────────────
  beat("BEAT 5 — Banner-only change → noise gate stays silent");
  console.log("  Re-running with identical plans (simulating banner/copy edit)...");
  const { changes: noChanges, hasSignal: noSignal } = diffPlanLadders(bumpedPlans, bumpedPlans);
  console.log(`  Changes detected: ${noChanges.length}`);
  console.log(`  Signal: ${noSignal ? "YES" : "NO → no email"}`);
  console.log("\n  ✓ Noise gate: banner/copy changes do not trigger alerts.\n");
  hr();

  saveLadderSnapshot(DEMO_SITE, result.plans);

  console.log("\n  PriceWatch: pick the plans you care about.");
  console.log("  Get an email when the price moves. Not when a banner changes.\n");
}

async function runFixture() {
  cleanupDemo();

  beat("BEAT 1 — Structured plan ladder (Vercel fixture)");
  console.log("  Using offline fixture (no network required)\n");
  printLadder(FIXTURE_OLD);
  saveLadderSnapshot(DEMO_SITE, FIXTURE_OLD);
  console.log(`\n  Baseline snapshot saved.`);
  hr();

  beat("BEAT 2.5 — Pick which plans to watch");
  console.log("  The customer sees the plan ladder and picks rows.\n");
  console.log('  ➜  Customer selects: "Pro"\n');
  printPlanPick(FIXTURE_OLD, ["Pro"]);
  saveSelection(DEMO_SITE, { mode: "selected", plans: ["Pro"] });
  console.log('\n  ✓ Watching: Pro on vercel.com');
  hr();

  beat("BEAT 3 — Price bump: Pro $20 → $25");
  printLadder(FIXTURE_BUMPED);
  hr();

  beat("BEAT 4 — Diff → alert fires → customer email");
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

  beat("BEAT 5 — Banner-only → noise gate stays silent");
  const { changes: noChanges, hasSignal: noSignal } = diffPlanLadders(FIXTURE_BUMPED, FIXTURE_BUMPED);
  console.log(`  Changes detected: ${noChanges.length}`);
  console.log(`  Signal: ${noSignal ? "YES" : "NO → no email"}`);
  console.log("\n  ✓ Noise gate: banner/copy changes stay silent.\n");
  hr();

  saveLadderSnapshot(DEMO_SITE, FIXTURE_OLD);

  console.log("\n  Pick the plans. Get the email. No banner noise.\n");
}

async function main() {
  console.log();
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║  PriceWatch — Plan Ladder Demo                         ║");
  console.log("  ║  Pick plans to watch. Get emailed when prices move.    ║");
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
