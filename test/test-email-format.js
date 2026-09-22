#!/usr/bin/env node
"use strict";

/**
 * Golden-string tests for customer price_change email format.
 *
 * Verifies subject, body prose, time format, and absence of internal
 * labels and raw lab URLs. No network, no real send.
 *
 * HARD RULE: subject and body must NEVER match /127\.0\.0\.1|localhost/i.
 */

const fs = require("fs");
const path = require("path");
const {
  writePriceChangeEmail,
  friendlyName,
  formatJerusalemTime,
  formatDisplay,
  OUTBOX_DIR,
} = require("../src/monitor-lib");

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
    if (f.startsWith("price-change_test-")) {
      fs.unlinkSync(path.join(OUTBOX_DIR, f));
    }
  }
}

const LOCAL_RE = /127\.0\.0\.1|localhost/i;

console.log("\n=== Customer email format tests ===\n");

// ── friendlyName ────────────────────────────────────────────────

test("friendlyName: real skill uses site field", () => {
  assert(friendlyName({ site: "plausible.io" }) === "plausible.io", "should be plausible.io");
});

test("friendlyName: lab URL with target → uses target_price_description", () => {
  const name = friendlyName({
    base_url: "http://127.0.0.1:3847/",
    target_price_description: "main monthly price",
  });
  assert(name === "main monthly price", `got: ${name}`);
  assert(!LOCAL_RE.test(name), "contains raw lab URL");
});

test("friendlyName: lab URL without target → neutral fallback", () => {
  const name = friendlyName({ base_url: "http://127.0.0.1:3847/" });
  assert(name === "the site you're watching", `got: ${name}`);
  assert(!LOCAL_RE.test(name), "contains raw lab URL");
});

test("friendlyName: localhost URL → no localhost in output", () => {
  const name = friendlyName({
    base_url: "http://localhost:3847/",
    target_price_description: "starter plan",
  });
  assert(name === "starter plan", `got: ${name}`);
  assert(!LOCAL_RE.test(name), "contains localhost");
});

test("friendlyName: real URL without site → hostname", () => {
  const name = friendlyName({ base_url: "https://linear.app/pricing" });
  assert(name === "linear.app", `got: ${name}`);
});

// ── formatJerusalemTime ─────────────────────────────────────────

test("formatJerusalemTime: contains month abbreviation and timezone", () => {
  const t = formatJerusalemTime(new Date("2026-09-22T17:05:00Z"));
  assert(/Sep/.test(t), `should contain 'Sep': ${t}`);
  assert(/2026/.test(t), `should contain '2026': ${t}`);
  assert(/IDT|IST|GMT\+[23]/.test(t), `should contain IDT/IST/GMT+2/GMT+3: ${t}`);
});

// ── Lab skill email golden strings ──────────────────────────────

cleanup();

const labSkill = {
  id: "test-lab-golden",
  base_url: "http://127.0.0.1:3847/",
  pricing_url: "http://127.0.0.1:3847/price.json",
  target_price_description: "main monthly price",
};
const before = { amount: 29, currency: "USD", period: "month" };
const after = { amount: 49, currency: "USD", period: "month" };
const customerInfo = {
  customerId: "cust-123",
  customerEmail: "dvirbaumel9@gmail.com",
  customerName: "Test Corp",
};

const emailPath = writePriceChangeEmail(labSkill, before, after, customerInfo);
const email = JSON.parse(fs.readFileSync(emailPath, "utf8"));

test("Lab subject: 'PriceWatch: main monthly price changed'", () => {
  assert(
    email.subject === "PriceWatch: main monthly price changed",
    `got: ${email.subject}`
  );
});

test("HARD: lab subject contains NO localhost/127.0.0.1", () => {
  assert(!LOCAL_RE.test(email.subject), `subject has raw lab URL: ${email.subject}`);
});

test("HARD: lab body contains NO localhost/127.0.0.1", () => {
  assert(!LOCAL_RE.test(email.body), `body has raw lab URL`);
});

test("Body: greeting with customer name", () => {
  assert(email.body.startsWith("Hi Test Corp,"), `body start: ${email.body.slice(0, 30)}`);
});

test("Body: before/after amounts on clear lines", () => {
  assert(email.body.includes("Before: $29/mo"), "missing before line");
  assert(email.body.includes("After:  $49/mo"), "missing after line");
});

test("Body: no repeated phrase — lab uses 'for {target}.' not 'at {name}'", () => {
  assert(email.body.includes("main monthly price"), "missing target description");
  assert(!email.body.includes("Lab demo"), "contains 'Lab demo'");
  assert(
    email.body.includes("a price change for main monthly price."),
    "should end with period, no 'at' clause"
  );
  assert(
    !email.body.includes("at main monthly price"),
    "should NOT repeat name when name == target"
  );
});

test("Body: friendly link with no URL for lab", () => {
  assert(
    email.body.includes("Your monitored pricing page"),
    "missing 'Your monitored pricing page'"
  );
});

test("Body: Jerusalem timezone", () => {
  assert(/IDT|IST|GMT\+[23]/.test(email.body), "no Jerusalem timezone in body");
});

test("Body: no internal labels (§8.1, acceptance, OAuth, test harness)", () => {
  const lower = email.body.toLowerCase();
  assert(!lower.includes("§8"), "body contains §8 reference");
  assert(!lower.includes("acceptance"), "body contains 'acceptance'");
  assert(!lower.includes("oauth"), "body contains 'oauth'");
  assert(!lower.includes("test harness"), "body contains 'test harness'");
});

test("Body: ends with PriceWatch signature", () => {
  assert(email.body.trimEnd().endsWith("— PriceWatch"), "missing signature");
});

// ── Real-site skill golden strings ──────────────────────────────

const realSkill = {
  id: "test-real-golden",
  site: "plausible.io",
  base_url: "https://plausible.io/",
  pricing_url: "https://plausible.io/",
  target_price_description: "Starter plan monthly USD",
};

const realPath = writePriceChangeEmail(realSkill, before, after, customerInfo);
const realEmail = JSON.parse(fs.readFileSync(realPath, "utf8"));

test("Real subject: 'PriceWatch: plausible.io changed'", () => {
  assert(
    realEmail.subject === "PriceWatch: plausible.io changed",
    `got: ${realEmail.subject}`
  );
});

test("HARD: real subject contains NO localhost/127.0.0.1", () => {
  assert(!LOCAL_RE.test(realEmail.subject), `subject has raw lab URL: ${realEmail.subject}`);
});

test("HARD: real body contains NO localhost/127.0.0.1", () => {
  assert(!LOCAL_RE.test(realEmail.body), "body has raw lab URL");
});

test("Real body: 'for {target} on {site}' prose", () => {
  assert(
    realEmail.body.includes("a price change for Starter plan monthly USD on plausible.io."),
    "should use 'for target on site' pattern"
  );
});

test("Real body: 'Open pricing page:' link", () => {
  assert(
    realEmail.body.includes("Open pricing page: https://plausible.io/"),
    "missing pricing page link"
  );
});

// ── Skill with no target description and lab URL ────────────────

const bareLabSkill = {
  id: "test-bare-lab",
  base_url: "http://localhost:9999/",
  pricing_url: "http://localhost:9999/api",
};

const barePath = writePriceChangeEmail(bareLabSkill, before, after, null);
const bareEmail = JSON.parse(fs.readFileSync(barePath, "utf8"));

test("HARD: bare lab subject NO localhost/127.0.0.1", () => {
  assert(!LOCAL_RE.test(bareEmail.subject), `subject: ${bareEmail.subject}`);
});

test("HARD: bare lab body NO localhost/127.0.0.1", () => {
  assert(!LOCAL_RE.test(bareEmail.body), "body has raw lab URL");
});

test("Bare lab subject uses neutral fallback", () => {
  assert(
    bareEmail.subject === "PriceWatch: the site you're watching changed",
    `got: ${bareEmail.subject}`
  );
});

// ── cleanup ─────────────────────────────────────────────────────

cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
