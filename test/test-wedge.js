#!/usr/bin/env node
"use strict";

/**
 * Wedge demo 7-day tests — W2 email format + W3 noise gate fixtures.
 *
 * W3 Fixture A: Pro +$10 → alert fires
 * W3 Fixture B: Banner-only → no alert
 * W2: Email format checks (no localhost, Jerusalem time, support line, table)
 */

const fs = require("fs");
const path = require("path");
const { diffPlanLadders, filterBySelection } = require("../src/plan-ladder-diff");
const { writePlanLadderEmail, buildChangeTable, buildSummaryLine } = require("../src/plan-ladder-email");
const { formatJerusalemTime, isLocalUrl } = require("../src/monitor-lib");
const { saveSelection, loadSelection, isWatched, WATCHED_DIR } = require("../src/plan-selection");

const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");
const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "wedge");
const LOCAL_RE = /127\.0\.0\.1|localhost/i;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function cleanup() {
  if (!fs.existsSync(OUTBOX_DIR)) return;
  for (const f of fs.readdirSync(OUTBOX_DIR)) {
    if (f.startsWith("plan-ladder_test-") || f.startsWith("plan-ladder_example-")) {
      fs.unlinkSync(path.join(OUTBOX_DIR, f));
    }
  }
}

console.log("\n=== Wedge demo tests (W2 + W3) ===\n");

// ──────────────────────────────────────────────────────────────────
//  W3 — Noise gate fixtures
// ──────────────────────────────────────────────────────────────────

console.log("--- W3: Noise gate fixtures ---\n");

const fixtureA = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "fixture-a-price-bump.json"), "utf8"));
const fixtureB = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "fixture-b-banner-only.json"), "utf8"));

test("W3-A: Pro +$10 price bump → hasSignal=true", () => {
  const { changes, hasSignal } = diffPlanLadders(fixtureA.old_plans, fixtureA.new_plans);
  assert(hasSignal === true, `hasSignal=${hasSignal}`);
  assert(changes.length >= 1, `changes.length=${changes.length}`);
  const priceChange = changes.find(c => c.plan === "Pro" && c.field === "price");
  assert(priceChange, "no Pro price change found");
  assert(priceChange.old === 20, `old=${priceChange.old}`);
  assert(priceChange.new === 30, `new=${priceChange.new}`);
});

test("W3-B: Banner/copy only → hasSignal=false", () => {
  const { changes, hasSignal } = diffPlanLadders(fixtureB.old_plans, fixtureB.new_plans);
  assert(hasSignal === false, `hasSignal=${hasSignal}`);
  assert(changes.length === 0, `changes.length=${changes.length} (expected 0)`);
});

test("W3-A: Price bump produces email with correct changes", () => {
  cleanup();
  const { changes } = diffPlanLadders(fixtureA.old_plans, fixtureA.new_plans);
  const emailPath = writePlanLadderEmail(
    fixtureA.site,
    fixtureA.pricing_url,
    changes,
    { customerId: "test-1", customerEmail: "test@example.com", customerName: "Test User" }
  );
  assert(fs.existsSync(emailPath), "email file not written");
  const email = JSON.parse(fs.readFileSync(emailPath, "utf8"));
  assert(email.type === "plan_ladder_change", `type=${email.type}`);
  assert(email.changes.length >= 1, `changes in email: ${email.changes.length}`);
  cleanup();
});

test("W3-B: Banner-only → no signal → no email path needed", () => {
  const { changes, hasSignal } = diffPlanLadders(fixtureB.old_plans, fixtureB.new_plans);
  assert(!hasSignal, "should have no signal for banner-only");
});

// ──────────────────────────────────────────────────────────────────
//  Additional noise gate edge cases
// ──────────────────────────────────────────────────────────────────

console.log("\n--- W3: Additional edge cases ---\n");

test("Plan added → signal", () => {
  const old = [{ plan: "Pro", price: 20, currency: "USD", unit: "seat", billing: "monthly" }];
  const nw = [
    { plan: "Pro", price: 20, currency: "USD", unit: "seat", billing: "monthly" },
    { plan: "Enterprise", price: 99, currency: "USD", unit: "seat", billing: "monthly" },
  ];
  const { hasSignal, changes } = diffPlanLadders(old, nw);
  assert(hasSignal, "new plan should be signal");
  assert(changes[0].type === "plan_added", `type=${changes[0].type}`);
});

test("Plan removed → signal", () => {
  const old = [
    { plan: "Free", price: 0, currency: "USD", unit: null, billing: "free" },
    { plan: "Pro", price: 20, currency: "USD", unit: "seat", billing: "monthly" },
  ];
  const nw = [{ plan: "Pro", price: 20, currency: "USD", unit: "seat", billing: "monthly" }];
  const { hasSignal, changes } = diffPlanLadders(old, nw);
  assert(hasSignal, "removed plan should be signal");
  assert(changes[0].type === "plan_removed", `type=${changes[0].type}`);
});

test("Unit change (seat → user) → signal", () => {
  const old = [{ plan: "Pro", price: 20, currency: "USD", unit: "seat", billing: "monthly" }];
  const nw = [{ plan: "Pro", price: 20, currency: "USD", unit: "user", billing: "monthly" }];
  const { hasSignal, changes } = diffPlanLadders(old, nw);
  assert(hasSignal, "unit change should be signal");
});

test("Identical plans → no signal", () => {
  const plans = [
    { plan: "Free", price: 0, currency: "USD", unit: null, billing: "free" },
    { plan: "Pro", price: 20, currency: "USD", unit: "seat", billing: "monthly" },
  ];
  const { hasSignal, changes } = diffPlanLadders(plans, plans);
  assert(!hasSignal, "identical plans should not signal");
  assert(changes.length === 0, "no changes expected");
});

test("Null old plans → no signal (baseline)", () => {
  const { hasSignal } = diffPlanLadders(null, [{ plan: "Pro", price: 20 }]);
  assert(!hasSignal, "null old = baseline, no signal");
});

test("Null new plans → no signal (extract failure)", () => {
  const { hasSignal } = diffPlanLadders([{ plan: "Pro", price: 20 }], null);
  assert(!hasSignal, "null new = extract fail, no signal");
});

// ──────────────────────────────────────────────────────────────────
//  W2 — Email format
// ──────────────────────────────────────────────────────────────────

console.log("\n--- W2: Email format ---\n");

cleanup();

const testChanges = [
  { plan: "Pro", field: "price", old: 20, new: 30, type: "price_change", currency: "USD", billing: "monthly" },
];

const emailPath = writePlanLadderEmail(
  "plausible.io",
  "https://plausible.io/",
  testChanges,
  { customerId: "cust-1", customerEmail: "dvirbaumel9@gmail.com", customerName: "Dvir" }
);
const email = JSON.parse(fs.readFileSync(emailPath, "utf8"));

test("W2: Subject includes site name", () => {
  assert(email.subject.includes("plausible.io"), `subject: ${email.subject}`);
});

test("W2: Subject starts with PriceWatch:", () => {
  assert(email.subject.startsWith("PriceWatch:"), `subject: ${email.subject}`);
});

test("HARD: No localhost/127.0.0.1 in subject", () => {
  assert(!LOCAL_RE.test(email.subject), `subject has lab URL: ${email.subject}`);
});

test("HARD: No localhost/127.0.0.1 in body", () => {
  assert(!LOCAL_RE.test(email.body), "body has lab URL");
});

test("W2: Body has greeting with customer name", () => {
  assert(email.body.startsWith("Hi Dvir,"), `body start: ${email.body.slice(0, 20)}`);
});

test("W2: Body has change table with Plan/Field/Before/After", () => {
  assert(email.body.includes("Plan"), "missing Plan header");
  assert(email.body.includes("Field"), "missing Field header");
  assert(email.body.includes("Before"), "missing Before header");
  assert(email.body.includes("After"), "missing After header");
});

test("W2: Body table shows old $20 → new $30", () => {
  assert(email.body.includes("$20"), "missing old price $20");
  assert(email.body.includes("$30"), "missing new price $30");
});

test("W2: Body has summary sentence", () => {
  assert(email.body.includes("Pro price increased from $20 to $30"), `missing summary`);
});

test("W2: Body has pricing page link", () => {
  assert(email.body.includes("Open pricing page: https://plausible.io/"), "missing link");
});

test("W2: Body has Jerusalem timezone", () => {
  assert(/IDT|IST|GMT\+[23]/.test(email.body), "no Jerusalem timezone in body");
});

test("W2: Body has support line", () => {
  assert(
    email.body.includes("Questions? Reply to this email or write price.watcher.service@gmail.com."),
    "missing support contact"
  );
});

test("W2: Body ends with PriceWatch signature", () => {
  assert(email.body.trimEnd().endsWith("— PriceWatch"), "missing signature");
});

test("W2: No internal labels (§, acceptance, oauth, test harness)", () => {
  const lower = email.body.toLowerCase();
  assert(!lower.includes("§"), "body contains § reference");
  assert(!lower.includes("acceptance"), "body contains 'acceptance'");
  assert(!lower.includes("oauth"), "body contains 'oauth'");
  assert(!lower.includes("test harness"), "body contains 'test harness'");
});

// Test lab URL scrubbing for plan-ladder emails
const labEmailPath = writePlanLadderEmail(
  "test-lab-site",
  "http://127.0.0.1:3847/pricing",
  testChanges,
  null
);
const labEmail = JSON.parse(fs.readFileSync(labEmailPath, "utf8"));

test("HARD: Lab URL plan-ladder email — no localhost in subject", () => {
  assert(!LOCAL_RE.test(labEmail.subject), `subject: ${labEmail.subject}`);
});

test("HARD: Lab URL plan-ladder email — no localhost in body", () => {
  assert(!LOCAL_RE.test(labEmail.body), "body has lab URL");
});

test("Lab URL: friendly link fallback", () => {
  assert(
    labEmail.body.includes("Your monitored pricing page"),
    "missing neutral link fallback"
  );
});

// ──────────────────────────────────────────────────────────────────
//  buildChangeTable + buildSummaryLine unit tests
// ──────────────────────────────────────────────────────────────────

console.log("\n--- Unit: buildChangeTable + buildSummaryLine ---\n");

test("buildChangeTable: renders correct columns", () => {
  const table = buildChangeTable(testChanges);
  assert(table.includes("Pro"), "missing plan name");
  assert(table.includes("price"), "missing field");
  assert(table.includes("$20"), "missing old value");
  assert(table.includes("$30"), "missing new value");
});

test("buildSummaryLine: single price change", () => {
  const summary = buildSummaryLine(testChanges);
  assert(summary.includes("Pro"), "missing plan name in summary");
  assert(summary.includes("$20"), "missing old price in summary");
  assert(summary.includes("$30"), "missing new price in summary");
});

test("buildSummaryLine: multiple price changes", () => {
  const multi = [
    { plan: "Pro", field: "price", old: 20, new: 30, type: "price_change" },
    { plan: "Basic", field: "price", old: 10, new: 15, type: "price_change" },
  ];
  const summary = buildSummaryLine(multi);
  assert(summary.includes("2 plan prices"), "should mention count");
});

test("buildSummaryLine: plan added with price", () => {
  const added = [{ plan: "Pro", field: "plan", old: null, new: "Pro", type: "plan_added", newPrice: 20 }];
  const summary = buildSummaryLine(added);
  assert(summary.includes("New plan"), "should say 'New plan'");
  assert(summary.includes("Pro"), "should name the plan");
  assert(summary.includes("$20"), "should include price");
});

test("buildChangeTable: plan added shows price in After column", () => {
  const added = [{ plan: "Business", field: "plan", old: null, new: "Business", type: "plan_added", newPrice: 20 }];
  const table = buildChangeTable(added);
  assert(table.includes("Business"), "missing plan name");
  assert(table.includes("added"), "missing 'added' field");
  assert(table.includes("$20"), "missing price in After column");
});

test("buildChangeTable: plan removed shows price in Before column", () => {
  const removed = [{ plan: "Starter", field: "plan", old: "Starter", new: null, type: "plan_removed", oldPrice: 9 }];
  const table = buildChangeTable(removed);
  assert(table.includes("Starter"), "missing plan name");
  assert(table.includes("removed"), "missing 'removed' field");
  assert(table.includes("$9"), "missing price in Before column");
});

cleanup();

// ──────────────────────────────────────────────────────────────────
//  Plan selection + filterBySelection
// ──────────────────────────────────────────────────────────────────

console.log("\n--- Plan selection + filter ---\n");

function cleanupWatched() {
  if (!fs.existsSync(WATCHED_DIR)) return;
  for (const f of fs.readdirSync(WATCHED_DIR)) {
    if (f.startsWith("test-")) {
      fs.unlinkSync(path.join(WATCHED_DIR, f));
    }
  }
}

cleanupWatched();

test("saveSelection + loadSelection round-trip", () => {
  saveSelection("test-site.com", { mode: "selected", plans: ["Pro", "Business"] });
  const sel = loadSelection("test-site.com");
  assert(sel, "selection should exist");
  assert(sel.mode === "selected", `mode=${sel.mode}`);
  assert(sel.plans.length === 2, `plans.length=${sel.plans.length}`);
  assert(sel.plans[0] === "Pro", `plans[0]=${sel.plans[0]}`);
});

test("isWatched: returns true for selected plan", () => {
  assert(isWatched("test-site.com", "Pro"), "Pro should be watched");
  assert(isWatched("test-site.com", "Business"), "Business should be watched");
});

test("isWatched: returns false for unselected plan", () => {
  assert(!isWatched("test-site.com", "Free"), "Free should not be watched");
  assert(!isWatched("test-site.com", "Hobby"), "Hobby should not be watched");
});

test("isWatched: all_paid mode watches everything", () => {
  saveSelection("test-site.com", { mode: "all_paid", plans: [] });
  assert(isWatched("test-site.com", "Pro"), "all_paid: Pro");
  assert(isWatched("test-site.com", "Free"), "all_paid: Free");
  assert(isWatched("test-site.com", "Enterprise"), "all_paid: Enterprise");
});

test("isWatched: no selection → watches all (backward compat)", () => {
  assert(isWatched("nonexistent-site.com", "Pro"), "no selection = watch all");
});

test("filterBySelection: selected mode filters changes", () => {
  const changes = [
    { plan: "Pro", field: "price", old: 20, new: 30, type: "price_change" },
    { plan: "Free", field: "price", old: 0, new: 5, type: "price_change" },
  ];
  const sel = { mode: "selected", plans: ["Pro"] };
  const filtered = filterBySelection(changes, sel);
  assert(filtered.length === 1, `filtered.length=${filtered.length}`);
  assert(filtered[0].plan === "Pro", `plan=${filtered[0].plan}`);
});

test("filterBySelection: all_paid mode passes all changes", () => {
  const changes = [
    { plan: "Pro", field: "price", old: 20, new: 30, type: "price_change" },
    { plan: "Free", field: "price", old: 0, new: 5, type: "price_change" },
  ];
  const sel = { mode: "all_paid", plans: [] };
  const filtered = filterBySelection(changes, sel);
  assert(filtered.length === 2, `filtered.length=${filtered.length}`);
});

test("filterBySelection: null selection passes all changes", () => {
  const changes = [
    { plan: "Pro", field: "price", old: 20, new: 30, type: "price_change" },
  ];
  const filtered = filterBySelection(changes, null);
  assert(filtered.length === 1, `filtered.length=${filtered.length}`);
});

test("filterBySelection: case-insensitive plan matching", () => {
  const changes = [
    { plan: "Pro", field: "price", old: 20, new: 30, type: "price_change" },
  ];
  const sel = { mode: "selected", plans: ["pro"] };
  const filtered = filterBySelection(changes, sel);
  assert(filtered.length === 1, "case-insensitive should match");
});

cleanupWatched();

// ──────────────────────────────────────────────────────────────────

console.log(`\n=== Wedge tests: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
