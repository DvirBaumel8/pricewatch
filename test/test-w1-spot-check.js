#!/usr/bin/env node
"use strict";

/**
 * W1 spot-check — verify plan-ladder extraction correctness.
 *
 * Two modes:
 *   1. If live snapshots exist in data/snapshots/ladder/, verify those.
 *   2. Otherwise fall back to committed golden fixtures in
 *      test/fixtures/wedge/golden-ladders/ (works on fresh clone).
 *
 * Expected values as of September 2026 (public pricing pages).
 * Passes if ≥4/5 sites have correct main plans.
 */

const fs = require("fs");
const path = require("path");

const LADDER_DIR = path.resolve(__dirname, "..", "data", "snapshots", "ladder");
const GOLDEN_DIR = path.resolve(__dirname, "fixtures", "wedge", "golden-ladders");

let passed = 0;
let failed = 0;
let correct = 0;
let total = 0;
let source = "unknown";

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
    correct++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function loadSnapshot(site) {
  const slugged = site.replace(/\./g, "-");

  const livePath = path.join(LADDER_DIR, `${slugged}.json`);
  if (fs.existsSync(livePath)) {
    source = "live";
    return JSON.parse(fs.readFileSync(livePath, "utf8"));
  }

  const goldenPath = path.join(GOLDEN_DIR, `${slugged}.json`);
  if (fs.existsSync(goldenPath)) {
    source = "golden";
    return JSON.parse(fs.readFileSync(goldenPath, "utf8"));
  }

  return null;
}

function findPlan(plans, name) {
  return plans.find(p => p.plan.toLowerCase() === name.toLowerCase());
}

console.log("\n=== W1 spot-check: plan-ladder correctness ===\n");

const firstSnap = loadSnapshot("vercel.com");
if (!firstSnap) {
  console.log("  No snapshots found (live or golden). Run: npm run ladder:allowlist\n");
  process.exit(1);
}
console.log(`  Source: ${source === "live" ? "data/snapshots/ladder/ (live)" : "test/fixtures/wedge/golden-ladders/ (committed)"}\n`);

test("Vercel: Hobby=Free, Pro=$20/developer seat, Enterprise=Custom", () => {
  const snap = loadSnapshot("vercel.com");
  assert(snap, "no snapshot");
  assert(snap.plans.length >= 3, `plans: ${snap.plans.length}`);
  const hobby = findPlan(snap.plans, "Hobby");
  assert(hobby && hobby.price === 0, `Hobby price: ${hobby ? hobby.price : "missing"}`);
  const pro = findPlan(snap.plans, "Pro");
  assert(pro && pro.price === 20, `Pro price: ${pro ? pro.price : "missing"}`);
  assert(pro.unit === "developer seat", `Pro unit: ${pro.unit}`);
  const ent = findPlan(snap.plans, "Enterprise");
  assert(ent && ent.price === null, `Enterprise price: ${ent ? ent.price : "missing"}`);
});

test("Linear: Free=0, Basic=$10/user, Enterprise=Custom", () => {
  const snap = loadSnapshot("linear.app");
  assert(snap, "no snapshot");
  assert(snap.plans.length >= 3, `plans: ${snap.plans.length}`);
  const free = findPlan(snap.plans, "Free");
  assert(free && free.price === 0, `Free: ${free ? free.price : "missing"}`);
  const basic = findPlan(snap.plans, "Basic");
  assert(basic && basic.price === 10, `Basic: ${basic ? basic.price : "missing"}`);
  assert(basic.unit === "user", `Basic unit: ${basic.unit}`);
});

test("Notion: Free=0, Plus=$10/member", () => {
  const snap = loadSnapshot("notion.com");
  assert(snap, "no snapshot");
  assert(snap.plans.length >= 3, `plans: ${snap.plans.length}`);
  const free = findPlan(snap.plans, "Free");
  assert(free && free.price === 0, `Free: ${free ? free.price : "missing"}`);
  const plus = findPlan(snap.plans, "Plus");
  assert(plus && plus.price === 10, `Plus: ${plus ? plus.price : "missing"}`);
  assert(plus.unit === "member", `Plus unit: ${plus.unit}`);
});

test("Plausible: Starter=$9/mo", () => {
  const snap = loadSnapshot("plausible.io");
  assert(snap, "no snapshot");
  assert(snap.plans.length >= 1, `plans: ${snap.plans.length}`);
  const starter = findPlan(snap.plans, "Starter");
  assert(starter && starter.price === 9, `Starter: ${starter ? starter.price : "missing"}`);
});

test("Slack: Free=0, Pro=$8.75/active user", () => {
  const snap = loadSnapshot("slack.com");
  assert(snap, "no snapshot");
  assert(snap.plans.length >= 2, `plans: ${snap.plans.length}`);
  const free = findPlan(snap.plans, "Free");
  assert(free && free.price === 0, `Free: ${free ? free.price : "missing"}`);
  const pro = findPlan(snap.plans, "Pro");
  assert(pro && pro.price === 8.75, `Pro: ${pro ? pro.price : "missing"}`);
  assert(pro.unit === "active user", `Pro unit: ${pro.unit}`);
});

test("Shopify: Basic=$29, Grow=$79, Advanced=$299", () => {
  const snap = loadSnapshot("shopify.com");
  assert(snap, "no snapshot");
  assert(snap.plans.length >= 3, `plans: ${snap.plans.length}`);
  const basic = findPlan(snap.plans, "Basic");
  assert(basic && basic.price === 29, `Basic: ${basic ? basic.price : "missing"}`);
  const grow = findPlan(snap.plans, "Grow");
  assert(grow && grow.price === 79, `Grow: ${grow ? grow.price : "missing"}`);
  const adv = findPlan(snap.plans, "Advanced");
  assert(adv && adv.price === 299, `Advanced: ${adv ? adv.price : "missing"}`);
});

console.log(`\n=== W1 spot-check: ${correct}/${total} sites correct (threshold: 4/5) ===`);
console.log(`=== Results: ${passed} passed, ${failed} failed ===\n`);

if (correct < 4) {
  console.error("FAIL: W1 threshold not met (need ≥4/5 correct)");
  process.exit(1);
}
