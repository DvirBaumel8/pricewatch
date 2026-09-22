#!/usr/bin/env node
"use strict";

/**
 * Golden-string tests for customer price_change email format.
 *
 * Verifies subject, body prose, time format, and absence of internal labels.
 * No network, no real send — pure unit test on writePriceChangeEmail output.
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

console.log("\n=== Customer email format tests ===\n");

// ── friendlyName ────────────────────────────────────────────────

test("friendlyName: real skill uses site field", () => {
  assert(friendlyName({ site: "plausible.io" }) === "plausible.io", "should be plausible.io");
});

test("friendlyName: lab URL → 'Lab demo site'", () => {
  const name = friendlyName({ base_url: "http://127.0.0.1:3847/" });
  assert(name === "Lab demo site", `got: ${name}`);
});

test("friendlyName: localhost URL → 'Lab demo site'", () => {
  const name = friendlyName({ base_url: "http://localhost:3847/" });
  assert(name === "Lab demo site", `got: ${name}`);
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
  assert(/IDT|IST|GMT\+[23]/.test(t), `should contain IDT/IST/GMT+2/GMT+3 timezone: ${t}`);
});

// ── writePriceChangeEmail golden strings ────────────────────────

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

test("Subject: 'PriceWatch: Lab demo site price changed'", () => {
  assert(
    email.subject === "PriceWatch: Lab demo site price changed",
    `got: ${email.subject}`
  );
});

test("Subject: no raw localhost/127.0.0.1 URL", () => {
  assert(!/127\.0\.0\.1/.test(email.subject), "subject contains raw IP");
  assert(!/localhost/.test(email.subject), "subject contains localhost");
});

test("Body: greeting with customer name", () => {
  assert(email.body.startsWith("Hi Test Corp,"), `body start: ${email.body.slice(0, 30)}`);
});

test("Body: before/after amounts on clear lines", () => {
  assert(email.body.includes("Before: $29/mo"), "missing before line");
  assert(email.body.includes("After:  $49/mo"), "missing after line");
});

test("Body: friendly site name in prose", () => {
  assert(email.body.includes("Lab demo site"), "missing 'Lab demo site'");
  const proseLines = email.body.split("\n").filter((l) => !l.startsWith("http"));
  for (const line of proseLines) {
    assert(!/http:\/\/127\.0\.0\.1/.test(line), `prose line contains raw IP: ${line}`);
  }
});

test("Body: friendly pricing link", () => {
  assert(
    email.body.includes("Lab demo pricing page"),
    "missing 'Lab demo pricing page'"
  );
});

test("Body: Jerusalem timezone", () => {
  assert(/IDT|IST|GMT\+[23]/.test(email.body), `no Jerusalem timezone in body`);
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

// ── real-site skill golden string ───────────────────────────────

const realSkill = {
  id: "test-real-golden",
  site: "plausible.io",
  base_url: "https://plausible.io/",
  pricing_url: "https://plausible.io/",
  target_price_description: "Starter plan monthly USD",
};

const realPath = writePriceChangeEmail(realSkill, before, after, customerInfo);
const realEmail = JSON.parse(fs.readFileSync(realPath, "utf8"));

test("Real site subject: 'PriceWatch: plausible.io price changed'", () => {
  assert(
    realEmail.subject === "PriceWatch: plausible.io price changed",
    `got: ${realEmail.subject}`
  );
});

test("Real site body: 'Open pricing page:' link", () => {
  assert(
    realEmail.body.includes("Open pricing page: https://plausible.io/"),
    "missing pricing page link"
  );
});

// ── cleanup ─────────────────────────────────────────────────────

cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
