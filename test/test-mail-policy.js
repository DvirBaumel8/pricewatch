#!/usr/bin/env node
"use strict";

/**
 * Acceptance shame-tests — mail policy gate + kill switch.
 *
 * These tests MUST fail if:
 *   1. Allowlist gate is bypassed (non-allowlisted recipient would send while M1b locked).
 *   2. Kill switch is ignored by mailer.
 *   3. Kill switch is ignored by enqueue.
 *
 * No real SMTP/Resend, no live Neon, no live Render.
 * Uses mock transport / outbox inspection only.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const OUTBOX_DIR = path.join(PROJECT_ROOT, "outbox");
const KILL_FILE = path.join(PROJECT_ROOT, "data", "KILL");

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

function cleanOutbox() {
  if (fs.existsSync(OUTBOX_DIR)) {
    for (const f of fs.readdirSync(OUTBOX_DIR)) {
      if (f === "sent" || f === "samples") continue;
      const fp = path.join(OUTBOX_DIR, f);
      if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
    }
  }
  const sentDir = path.join(OUTBOX_DIR, "sent");
  if (fs.existsSync(sentDir)) {
    for (const f of fs.readdirSync(sentDir)) {
      fs.unlinkSync(path.join(sentDir, f));
    }
  }
}

function removeKillFile() {
  if (fs.existsSync(KILL_FILE)) fs.unlinkSync(KILL_FILE);
}

function writeOutboxEmail(filename, email) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTBOX_DIR, filename),
    JSON.stringify(email, null, 2) + "\n"
  );
}

function runMailer(envOverrides) {
  const env = { ...process.env, ...envOverrides };
  delete env.PRICEWATCH_SMTP_PASS;
  delete env.RESEND_API_KEY;
  env.RESEND_API_KEY = "re_test_fake_key_for_shame_test";
  try {
    const stdout = execSync("node scripts/send-outbox.js", {
      cwd: PROJECT_ROOT,
      timeout: 15000,
      encoding: "utf8",
      env,
    });
    return { stdout, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status };
  }
}

function outboxFileExists(filename) {
  return fs.existsSync(path.join(OUTBOX_DIR, filename));
}

function sentMarkerExists(filename) {
  return fs.existsSync(path.join(OUTBOX_DIR, filename + ".sent"));
}

console.log("\n=== Mail policy shame-tests ===\n");

// ─── Allowlist unit tests (in-process) ──────────────────────────

console.log("--- Allowlist gate (unit) ---\n");

test("isAllowlisted: returns false for stranger when M1b locked", () => {
  const saved = { ...process.env };
  delete process.env.PRICEWATCH_M1B_UNLOCK;
  process.env.PRICEWATCH_MAIL_ALLOWLIST = "team@example.com";
  delete process.env.PRICEWATCH_TEST_EMAIL;
  delete process.env.PRICEWATCH_OPS_EMAIL;

  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  assert(!m.isAllowlisted("stranger@evil.com"), "stranger must NOT be allowlisted");
  assert(m.isAllowlisted("team@example.com"), "team member must be allowlisted");

  Object.assign(process.env, saved);
});

test("isAllowlisted: PRICEWATCH_TEST_EMAIL auto-included", () => {
  const saved = { ...process.env };
  delete process.env.PRICEWATCH_M1B_UNLOCK;
  process.env.PRICEWATCH_MAIL_ALLOWLIST = "";
  process.env.PRICEWATCH_TEST_EMAIL = "test@pw.dev";
  delete process.env.PRICEWATCH_OPS_EMAIL;

  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  assert(m.isAllowlisted("test@pw.dev"), "test email must be allowlisted");
  assert(!m.isAllowlisted("outsider@other.com"), "outsider must NOT be allowlisted");

  Object.assign(process.env, saved);
});

test("isAllowlisted: PRICEWATCH_OPS_EMAIL auto-included", () => {
  const saved = { ...process.env };
  delete process.env.PRICEWATCH_M1B_UNLOCK;
  process.env.PRICEWATCH_MAIL_ALLOWLIST = "";
  delete process.env.PRICEWATCH_TEST_EMAIL;
  process.env.PRICEWATCH_OPS_EMAIL = "ops@pw.dev";

  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  assert(m.isAllowlisted("ops@pw.dev"), "ops email must be allowlisted");

  Object.assign(process.env, saved);
});

test("isAllowlisted: case-insensitive match", () => {
  const saved = { ...process.env };
  delete process.env.PRICEWATCH_M1B_UNLOCK;
  process.env.PRICEWATCH_MAIL_ALLOWLIST = "Team@Example.COM";
  delete process.env.PRICEWATCH_TEST_EMAIL;
  delete process.env.PRICEWATCH_OPS_EMAIL;

  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  assert(m.isAllowlisted("team@example.com"), "should match case-insensitively");
  assert(m.isAllowlisted("TEAM@EXAMPLE.COM"), "should match uppercase");

  Object.assign(process.env, saved);
});

test("isAllowlisted: M1b unlock allows anyone", () => {
  const saved = { ...process.env };
  process.env.PRICEWATCH_M1B_UNLOCK = "1";
  process.env.PRICEWATCH_MAIL_ALLOWLIST = "";
  delete process.env.PRICEWATCH_TEST_EMAIL;
  delete process.env.PRICEWATCH_OPS_EMAIL;

  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  assert(m.isAllowlisted("anyone@anywhere.com"), "M1b unlocked: anyone should be allowed");

  Object.assign(process.env, saved);
});

test("isM1bUnlocked: default is locked (false)", () => {
  const saved = { ...process.env };
  delete process.env.PRICEWATCH_M1B_UNLOCK;

  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  assert(!m.isM1bUnlocked(), "M1b must default to locked");

  Object.assign(process.env, saved);
});

test("parseAllowlist: comma-separated with whitespace", () => {
  const saved = { ...process.env };
  process.env.PRICEWATCH_MAIL_ALLOWLIST = " a@b.com , c@d.com , e@f.com ";
  delete process.env.PRICEWATCH_TEST_EMAIL;
  delete process.env.PRICEWATCH_OPS_EMAIL;

  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  const list = m.parseAllowlist();
  assert(list.has("a@b.com"), "should have a@b.com");
  assert(list.has("c@d.com"), "should have c@d.com");
  assert(list.has("e@f.com"), "should have e@f.com");
  assert(list.size === 3, `expected 3 entries, got ${list.size}`);

  Object.assign(process.env, saved);
});

// ─── Allowlist gate integration (subprocess) ────────────────────

console.log("\n--- Allowlist gate (integration — mailer subprocess) ---\n");

test("SHAME: non-allowlisted recipient is BLOCKED when M1b locked", () => {
  cleanOutbox();
  removeKillFile();
  writeOutboxEmail("price-change_shame-test_blocked.json", {
    type: "price_change",
    customer_email: "stranger@evil.com",
    subject: "PriceWatch: test changed",
    body: "Test body",
  });

  const result = runMailer({
    PRICEWATCH_M1B_UNLOCK: "",
    PRICEWATCH_MAIL_ALLOWLIST: "internal@team.com",
    PRICEWATCH_TEST_EMAIL: "",
    PRICEWATCH_OPS_EMAIL: "",
  });

  assert(
    (result.stdout || "").includes("BLOCKED"),
    "should log BLOCKED for non-allowlisted recipient"
  );
  assert(
    outboxFileExists("price-change_shame-test_blocked.json"),
    "outbox file must be KEPT (not deleted) for audit"
  );
  assert(
    !sentMarkerExists("price-change_shame-test_blocked.json"),
    "must NOT have .sent marker — email was not sent"
  );

  cleanOutbox();
});

test("SHAME: allowlisted recipient proceeds (hits Resend, which fails — but proves gate passed)", () => {
  cleanOutbox();
  removeKillFile();
  writeOutboxEmail("price-change_shame-test_allowed.json", {
    type: "price_change",
    customer_email: "internal@team.com",
    subject: "PriceWatch: test changed",
    body: "Test body",
  });

  const result = runMailer({
    PRICEWATCH_M1B_UNLOCK: "",
    PRICEWATCH_MAIL_ALLOWLIST: "internal@team.com",
    PRICEWATCH_TEST_EMAIL: "",
    PRICEWATCH_OPS_EMAIL: "",
  });

  assert(
    !(result.stdout || "").includes("BLOCKED"),
    "allowlisted recipient should NOT be blocked"
  );

  cleanOutbox();
});

test("SHAME: M1b unlocked allows non-allowlisted recipient through gate", () => {
  cleanOutbox();
  removeKillFile();
  writeOutboxEmail("price-change_shame-test_unlocked.json", {
    type: "price_change",
    customer_email: "stranger@evil.com",
    subject: "PriceWatch: test changed",
    body: "Test body",
  });

  const result = runMailer({
    PRICEWATCH_M1B_UNLOCK: "1",
    PRICEWATCH_MAIL_ALLOWLIST: "",
    PRICEWATCH_TEST_EMAIL: "",
    PRICEWATCH_OPS_EMAIL: "",
  });

  assert(
    !(result.stdout || "").includes("BLOCKED"),
    "M1b unlocked should allow stranger through"
  );

  cleanOutbox();
});

test("SHAME: outbox JSON preserved after non-allowlisted skip (audit trail)", () => {
  cleanOutbox();
  removeKillFile();
  writeOutboxEmail("price-change_shame-audit.json", {
    type: "price_change",
    customer_email: "stranger@evil.com",
    subject: "PriceWatch: audit test",
    body: "Audit body",
  });

  runMailer({
    PRICEWATCH_M1B_UNLOCK: "",
    PRICEWATCH_MAIL_ALLOWLIST: "nobody-matches@test.com",
    PRICEWATCH_TEST_EMAIL: "",
    PRICEWATCH_OPS_EMAIL: "",
  });

  assert(
    outboxFileExists("price-change_shame-audit.json"),
    "outbox JSON must survive allowlist skip for audit"
  );

  cleanOutbox();
});

// ─── Kill switch (mailer) ───────────────────────────────────────

console.log("\n--- Kill switch (mailer subprocess) ---\n");

test("SHAME: kill switch via env stops mailer (no send)", () => {
  cleanOutbox();
  removeKillFile();
  writeOutboxEmail("price-change_shame-kill-env.json", {
    type: "price_change",
    customer_email: "internal@team.com",
    subject: "PriceWatch: kill test",
    body: "Kill test body",
  });

  const result = runMailer({
    PRICEWATCH_KILL: "1",
    PRICEWATCH_M1B_UNLOCK: "1",
    PRICEWATCH_MAIL_ALLOWLIST: "internal@team.com",
  });

  assert(result.code === 0, `expected exit 0, got ${result.code}`);
  assert(
    (result.stdout || "").includes("Kill switch"),
    "should log kill switch message"
  );
  assert(
    !sentMarkerExists("price-change_shame-kill-env.json"),
    "must NOT send while killed"
  );

  cleanOutbox();
});

test("SHAME: kill switch via file stops mailer (no send)", () => {
  cleanOutbox();
  fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
  fs.writeFileSync(KILL_FILE, "");
  writeOutboxEmail("price-change_shame-kill-file.json", {
    type: "price_change",
    customer_email: "internal@team.com",
    subject: "PriceWatch: kill test",
    body: "Kill test body",
  });

  const result = runMailer({
    PRICEWATCH_KILL: "",
    PRICEWATCH_M1B_UNLOCK: "1",
    PRICEWATCH_MAIL_ALLOWLIST: "internal@team.com",
  });

  assert(result.code === 0, `expected exit 0, got ${result.code}`);
  assert(
    (result.stdout || "").includes("Kill switch"),
    "should log kill switch message"
  );
  assert(
    !sentMarkerExists("price-change_shame-kill-file.json"),
    "must NOT send while killed (file)"
  );

  removeKillFile();
  cleanOutbox();
});

// ─── Kill switch (enqueue) ──────────────────────────────────────

console.log("\n--- Kill switch (enqueue subprocess) ---\n");

test("SHAME: kill switch via env stops enqueue", () => {
  removeKillFile();
  const ticksFile = path.join(PROJECT_ROOT, "data", "monitor-ticks.json");
  if (fs.existsSync(ticksFile)) fs.unlinkSync(ticksFile);

  let stdout;
  try {
    stdout = execSync("node scripts/enqueue-daily-ticks.js", {
      cwd: PROJECT_ROOT,
      timeout: 10000,
      encoding: "utf8",
      env: { ...process.env, PRICEWATCH_KILL: "1" },
    });
  } catch (e) {
    stdout = e.stdout || "";
  }

  assert(
    stdout.includes("Kill switch"),
    "enqueue should log kill switch message"
  );
});

test("SHAME: kill switch via file stops enqueue", () => {
  fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
  fs.writeFileSync(KILL_FILE, "");

  let stdout;
  try {
    stdout = execSync("node scripts/enqueue-daily-ticks.js", {
      cwd: PROJECT_ROOT,
      timeout: 10000,
      encoding: "utf8",
      env: { ...process.env, PRICEWATCH_KILL: "" },
    });
  } catch (e) {
    stdout = e.stdout || "";
  }

  assert(
    stdout.includes("Kill switch"),
    "enqueue should log kill switch message (file)"
  );

  removeKillFile();
});

// ─── Mailer idempotency (.sent sidecar) ─────────────────────────

console.log("\n--- Mailer idempotency ---\n");

test("isSent: .sent sidecar prevents re-send", () => {
  delete require.cache[require.resolve("../scripts/send-outbox.js")];
  const m = require("../scripts/send-outbox.js");

  const testFile = path.join(OUTBOX_DIR, "shame-idempotent-test.json");
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.writeFileSync(testFile, '{"test":true}\n');

  assert(!m.isSent(testFile), "should NOT be sent before marker");

  m.markSent(testFile, "mock");
  assert(m.isSent(testFile), "should be sent after marker");

  fs.unlinkSync(testFile);
  fs.unlinkSync(testFile + ".sent");
});

// ─── ops_alert always allowed (goes to OPS_EMAIL / MAIL_FROM) ───

console.log("\n--- ops_alert recipient resolution ---\n");

test("ops_alert email resolves to PRICEWATCH_OPS_EMAIL (auto-allowlisted)", () => {
  cleanOutbox();
  removeKillFile();
  writeOutboxEmail("ops-alert_shame-test.json", {
    type: "ops_alert",
    subject: "[ops] Test alert",
    body: "Ops test body",
  });

  const result = runMailer({
    PRICEWATCH_M1B_UNLOCK: "",
    PRICEWATCH_MAIL_ALLOWLIST: "",
    PRICEWATCH_TEST_EMAIL: "",
    PRICEWATCH_OPS_EMAIL: "ops@pricewatch.dev",
  });

  assert(
    !(result.stdout || "").includes("BLOCKED"),
    "ops_alert to OPS_EMAIL should NOT be blocked (auto-allowlisted)"
  );

  cleanOutbox();
});

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n=== Mail policy shame-tests: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
