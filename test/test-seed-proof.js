#!/usr/bin/env node
"use strict";

/**
 * Shame-tests for the seeded allowlisted Resend proof path.
 *
 * Covers:
 *   (a) seed + drain with allowlisted recipient → gate passes (mock transport OK)
 *   (b) seed with non-allowlisted recipient → BLOCKED, no .sent marker
 *   (c) default/schedule path does not seed (seed gate is off unless dispatch input is true)
 *
 * No real network, no LLM. Uses mock Resend key (same as existing shame-tests).
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

function outboxJsonFiles() {
  if (!fs.existsSync(OUTBOX_DIR)) return [];
  return fs.readdirSync(OUTBOX_DIR).filter(
    (f) => f.endsWith(".json") && !f.endsWith(".sent")
  );
}

function sentMarkerExists(filename) {
  return fs.existsSync(path.join(OUTBOX_DIR, filename + ".sent"));
}

function runSeed(envOverrides) {
  const env = { ...process.env, ...envOverrides };
  try {
    const stdout = execSync("node scripts/seed-allowlisted-outbox.js", {
      cwd: PROJECT_ROOT,
      timeout: 10000,
      encoding: "utf8",
      env,
    });
    return { stdout, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status };
  }
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

console.log("\n=== Seeded proof shame-tests ===\n");

// ─── Seed script unit behavior ──────────────────────────────────

console.log("--- Seed script behavior ---\n");

test("seed: PRICEWATCH_TEST_EMAIL unset → hard fail (exit non-zero)", () => {
  cleanOutbox();
  const result = runSeed({
    PRICEWATCH_TEST_EMAIL: "",
  });
  assert(result.code !== 0, `expected non-zero exit, got ${result.code}`);
  assert(
    (result.stderr || "").includes("PRICEWATCH_TEST_EMAIL") ||
      (result.stdout || "").includes("PRICEWATCH_TEST_EMAIL"),
    "should mention PRICEWATCH_TEST_EMAIL in error output"
  );
  const files = outboxJsonFiles();
  assert(files.length === 0, `expected 0 outbox files, got ${files.length}`);
  cleanOutbox();
});

test("seed: PRICEWATCH_TEST_EMAIL set → writes exactly one outbox JSON", () => {
  cleanOutbox();
  const result = runSeed({
    PRICEWATCH_TEST_EMAIL: "pilot@test.dev",
  });
  assert(result.code === 0, `expected exit 0, got ${result.code}`);
  const files = outboxJsonFiles();
  assert(files.length === 1, `expected 1 outbox file, got ${files.length}`);

  const content = JSON.parse(
    fs.readFileSync(path.join(OUTBOX_DIR, files[0]), "utf8")
  );
  assert(
    content.customer_email === "pilot@test.dev",
    `expected customer_email=pilot@test.dev, got ${content.customer_email}`
  );
  assert(content.seeded === true, "outbox entry must have seeded=true marker");
  cleanOutbox();
});

// ─── (a) seed + drain allowlisted → would-send / mock OK ───────

console.log("\n--- (a) Seed + drain allowlisted → gate passes ---\n");

test("SHAME: seed + drain allowlisted recipient → gate passes (mock transport attempt)", () => {
  cleanOutbox();
  removeKillFile();

  const seedResult = runSeed({
    PRICEWATCH_TEST_EMAIL: "allowed@pilot.dev",
  });
  assert(seedResult.code === 0, `seed should succeed, got exit ${seedResult.code}`);
  const files = outboxJsonFiles();
  assert(files.length === 1, `expected 1 seeded file, got ${files.length}`);

  const mailerResult = runMailer({
    PRICEWATCH_M1B_UNLOCK: "",
    PRICEWATCH_MAIL_ALLOWLIST: "allowed@pilot.dev",
    PRICEWATCH_TEST_EMAIL: "allowed@pilot.dev",
    PRICEWATCH_OPS_EMAIL: "",
  });

  assert(
    !(mailerResult.stdout || "").includes("BLOCKED"),
    "allowlisted seeded recipient should NOT be blocked"
  );
  assert(
    !(mailerResult.stdout || "").includes("No outbox files"),
    "outbox must not be empty after seed — seed must have created the file"
  );

  cleanOutbox();
});

// ─── (b) non-allowlisted seed → BLOCKED ────────────────────────

console.log("\n--- (b) Seed non-allowlisted → BLOCKED ---\n");

test("SHAME: seed with email that is NOT on allowlist → BLOCKED, no .sent", () => {
  cleanOutbox();
  removeKillFile();

  const seedResult = runSeed({
    PRICEWATCH_TEST_EMAIL: "stranger@evil.com",
  });
  assert(seedResult.code === 0, `seed should succeed, got exit ${seedResult.code}`);
  const files = outboxJsonFiles();
  assert(files.length === 1, `expected 1 seeded file, got ${files.length}`);
  const seededFile = files[0];

  const mailerResult = runMailer({
    PRICEWATCH_M1B_UNLOCK: "",
    PRICEWATCH_MAIL_ALLOWLIST: "someone-else@team.com",
    PRICEWATCH_TEST_EMAIL: "",
    PRICEWATCH_OPS_EMAIL: "",
  });

  assert(
    (mailerResult.stdout || "").includes("BLOCKED"),
    "non-allowlisted seeded recipient must be BLOCKED"
  );
  assert(
    !sentMarkerExists(seededFile),
    "must NOT have .sent marker for blocked recipient"
  );

  cleanOutbox();
});

// ─── (c) schedule/default path does not seed ────────────────────

console.log("\n--- (c) Schedule/default path does not seed ---\n");

test("SHAME: without seed script, outbox stays empty (schedule path)", () => {
  cleanOutbox();
  removeKillFile();

  const filesBefore = outboxJsonFiles();
  assert(filesBefore.length === 0, "outbox should start empty");

  const mailerResult = runMailer({
    PRICEWATCH_M1B_UNLOCK: "",
    PRICEWATCH_MAIL_ALLOWLIST: "anyone@test.dev",
    PRICEWATCH_TEST_EMAIL: "anyone@test.dev",
    PRICEWATCH_OPS_EMAIL: "",
  });

  assert(
    (mailerResult.stdout || "").includes("No outbox files"),
    "schedule path (no seed) should have empty outbox"
  );

  const filesAfter = outboxJsonFiles();
  assert(
    filesAfter.length === 0,
    `outbox must remain empty on default path, got ${filesAfter.length} files`
  );

  cleanOutbox();
});

test("seed script is gated by workflow_dispatch in daily-cron.yml", () => {
  const workflow = fs.readFileSync(
    path.join(PROJECT_ROOT, ".github", "workflows", "daily-cron.yml"),
    "utf8"
  );

  assert(
    workflow.includes("seed_allowlisted_proof"),
    "workflow must reference seed_allowlisted_proof input"
  );
  assert(
    workflow.includes("workflow_dispatch") && workflow.includes("inputs.seed_allowlisted_proof"),
    "seed step must be conditioned on workflow_dispatch + seed input"
  );
  assert(
    workflow.includes("default: false"),
    "seed input must default to false"
  );

  const seedStepMatch = workflow.match(
    /Seed allowlisted outbox[\s\S]*?if:([^\n]+)/
  );
  assert(seedStepMatch, "workflow must have a seed step with an if: condition");
  const condition = seedStepMatch[1];
  assert(
    condition.includes("workflow_dispatch"),
    "seed step condition must require workflow_dispatch event"
  );
  assert(
    condition.includes("seed_allowlisted_proof"),
    "seed step condition must require seed_allowlisted_proof input"
  );
});

// ─── Summary ────────────────────────────────────────────────────

console.log(
  `\n=== Seeded proof shame-tests: ${passed} passed, ${failed} failed ===\n`
);
process.exit(failed > 0 ? 1 : 0);
