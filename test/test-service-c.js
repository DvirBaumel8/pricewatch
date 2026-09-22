#!/usr/bin/env node
"use strict";

/**
 * E2E tests for Service C — §7.11–7.14.
 *
 * Prerequisites:
 *   1. Lab server running on http://127.0.0.1:3847/
 *   2. Service A running on http://127.0.0.1:3850/
 *
 * This script proves the full A → B → C pipeline on the lab site:
 *   §7.11 — Due watches + enqueue (ready skill → pending tick, idempotent)
 *   §7.12 — No false email (unchanged price → zero price_change outbox)
 *   §7.13 — Change → exactly one email (price change → one price_change with before/after)
 *   §7.14 — Ops on failure + kill switch (broken watch → ops alert; kill → no-op)
 */

const http = require("http");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SERVICE_A = process.env.SERVICE_A_URL || "http://127.0.0.1:3850";
const LAB_URL = process.env.LAB_URL || "http://127.0.0.1:3847";
const PROJECT_ROOT = path.join(__dirname, "..");

function httpRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function run(cmd) {
  return execSync(cmd, {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    encoding: "utf8",
    env: { ...process.env },
  });
}

function runSafe(cmd) {
  try {
    return run(cmd);
  } catch (e) {
    return e.stdout || e.stderr || "";
  }
}

function cleanTestData() {
  const files = [
    "data/queue.json",
    "data/customers.json",
    "data/monitor-ticks.json",
    "data/KILL",
  ];
  for (const f of files) {
    const p = path.join(PROJECT_ROOT, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const snapshotsDir = path.join(PROJECT_ROOT, "data", "snapshots");
  if (fs.existsSync(snapshotsDir)) {
    for (const f of fs.readdirSync(snapshotsDir)) {
      if (f !== ".gitkeep") fs.unlinkSync(path.join(snapshotsDir, f));
    }
  }

  const outboxDir = path.join(PROJECT_ROOT, "outbox");
  if (fs.existsSync(outboxDir)) {
    for (const f of fs.readdirSync(outboxDir)) {
      fs.unlinkSync(path.join(outboxDir, f));
    }
  }

  const skillsDir = path.join(PROJECT_ROOT, "data", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const f of fs.readdirSync(skillsDir)) {
      if (f !== ".gitkeep" && /^[0-9a-f]{12}\.json$/.test(f)) {
        fs.unlinkSync(path.join(skillsDir, f));
      }
    }
  }
}

function countOutboxFiles(type) {
  const outboxDir = path.join(PROJECT_ROOT, "outbox");
  if (!fs.existsSync(outboxDir)) return 0;
  return fs.readdirSync(outboxDir).filter((f) => f.startsWith(type)).length;
}

function readOutboxFiles(type) {
  const outboxDir = path.join(PROJECT_ROOT, "outbox");
  if (!fs.existsSync(outboxDir)) return [];
  return fs
    .readdirSync(outboxDir)
    .filter((f) => f.startsWith(type))
    .map((f) => JSON.parse(fs.readFileSync(path.join(outboxDir, f), "utf8")));
}

function loadMonitorTicks() {
  const p = path.join(PROJECT_ROOT, "data", "monitor-ticks.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function setLabPrice(amount) {
  return httpRequest("POST", `${LAB_URL}/set-price`, { amount });
}

async function main() {
  console.log("\n=== Service C E2E tests (§7.11–7.14) ===\n");

  // Verify lab is up
  try {
    await httpRequest("GET", LAB_URL + "/price.json");
  } catch {
    console.error(`ERROR: Lab server not reachable at ${LAB_URL}`);
    console.error("Start it with: node lab/server.js");
    process.exit(1);
  }

  // Verify Service A is up
  try {
    await httpRequest("GET", SERVICE_A + "/customers");
  } catch {
    console.error(`ERROR: Service A not reachable at ${SERVICE_A}`);
    console.error("Start it with: node src/service-a.js");
    process.exit(1);
  }

  // Reset lab price to known baseline
  await setLabPrice(29);

  cleanTestData();

  // ─── Setup: A/B pipeline to get a ready skill ──────────────────

  console.log("--- Setup: A → B pipeline (create customer, discover skill) ---\n");

  let customerId;

  await test("Create customer via Service A", async () => {
    const res = await httpRequest("POST", `${SERVICE_A}/customers`, {
      name: "Test Corp",
      email: "alice@testcorp.com",
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    customerId = res.body.id;
  });

  await test("Add lab competitor via Service A", async () => {
    const res = await httpRequest(
      "POST",
      `${SERVICE_A}/customers/${customerId}/competitors`,
      {
        name: "Acme Lab",
        pricing_url: `${LAB_URL}/`,
        target_price_description: "main monthly price",
      }
    );
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body.job_created === true, "Job should be created");
  });

  await test("Service B discovers skill → skill_ready", async () => {
    const output = run("node scripts/run-onboarding-worker.js");
    assert(
      output.includes("Discovery succeeded") || output.includes("Step 0") ||
      output.includes("Step 1") || output.includes("Step 2"),
      "Worker should show discovery progress"
    );

    const custRes = await httpRequest("GET", `${SERVICE_A}/customers/${customerId}`);
    const comp = custRes.body.competitors[0];
    assert(comp.status === "skill_ready", `Expected skill_ready, got ${comp.status}`);
    assert(comp.skillPath, "Should have skillPath");
  });

  // ─── §7.11 Due watches + enqueue ──────────────────────────────

  console.log("\n--- §7.11 Due watches + enqueue ---\n");

  await test("enqueue-daily produces exactly one tick for ready skill", async () => {
    const output = run("node scripts/enqueue-daily-ticks.js");
    assert(output.includes("enqueued"), "Should show enqueued message");

    const ticks = loadMonitorTicks();
    const pending = ticks.filter((t) => t.status === "pending");
    assert(pending.length === 1, `Expected 1 pending tick, got ${pending.length}`);
    assert(pending[0].customerId === customerId, "Tick should be for our customer");
    assert(pending[0].customerEmail === "alice@testcorp.com", "Tick should have customer email");
  });

  await test("Second enqueue same day does not duplicate pending tick", async () => {
    const output = run("node scripts/enqueue-daily-ticks.js");
    assert(output.includes("skip") || output.includes("already exists"), "Should show skip message");

    const ticks = loadMonitorTicks();
    const pending = ticks.filter((t) => t.status === "pending");
    assert(pending.length === 1, `Still 1 pending tick, got ${pending.length}`);
  });

  // ─── §7.12 No false email (unchanged) ─────────────────────────

  console.log("\n--- §7.12 No false email (unchanged price) ---\n");

  await test("Service C on first run: baseline snapshot, no customer email", async () => {
    const output = run("node scripts/run-monitor-worker.js");
    assert(output.includes("no_email") || output.includes("No email") || output.includes("first_run"),
      "Should report no email / first run");

    const changeCount = countOutboxFiles("price-change");
    assert(changeCount === 0, `Expected 0 price_change emails, got ${changeCount}`);
  });

  // Re-enqueue (tick was consumed), clear the done tick for the next check
  // We need to clear existing done ticks so we can re-enqueue for unchanged test
  await test("Re-enqueue for unchanged check", async () => {
    // Clear ticks file so we can enqueue again
    const ticksFile = path.join(PROJECT_ROOT, "data", "monitor-ticks.json");
    fs.writeFileSync(ticksFile, "[]");

    const output = run("node scripts/enqueue-daily-ticks.js");
    assert(output.includes("enqueued"), "Should enqueue new tick");
  });

  await test("Service C on unchanged price: zero price_change emails", async () => {
    const output = run("node scripts/run-monitor-worker.js");
    assert(output.includes("no_email") || output.includes("No email") || output.includes("unchanged"),
      "Should report unchanged");

    const changeCount = countOutboxFiles("price-change");
    assert(changeCount === 0, `Expected 0 price_change emails after unchanged check, got ${changeCount}`);
    console.log("    0 LLM tokens (lab path, pure HTTP+extract)");
  });

  // ─── §7.13 Change → exactly one email ─────────────────────────

  console.log("\n--- §7.13 Price change → exactly one customer email ---\n");

  await test("Change lab price and run Service C → one price_change email", async () => {
    await setLabPrice(49);

    // Re-enqueue
    const ticksFile = path.join(PROJECT_ROOT, "data", "monitor-ticks.json");
    fs.writeFileSync(ticksFile, "[]");
    run("node scripts/enqueue-daily-ticks.js");

    const output = run("node scripts/run-monitor-worker.js");
    assert(output.includes("PRICE CHANGED") || output.includes("price_changed"),
      "Should report price changed");

    const changeCount = countOutboxFiles("price-change");
    assert(changeCount === 1, `Expected exactly 1 price_change email, got ${changeCount}`);

    const emails = readOutboxFiles("price-change");
    const email = emails[0];
    assert(email.type === "price_change", "Email type should be price_change");
    assert(email.before.amount === 29, `Before should be 29, got ${email.before.amount}`);
    assert(email.after.amount === 49, `After should be 49, got ${email.after.amount}`);
    assert(email.customer_id === customerId, "Should include customer_id");
    assert(email.customer_email === "alice@testcorp.com", "Should include customer_email");
    console.log(`    Email: before=$${email.before.amount} after=$${email.after.amount}`);
    console.log(`    Customer: ${email.customer_id} (${email.customer_email})`);
    console.log("    0 LLM tokens (lab path)");
  });

  // ─── §7.14 Ops on failure + kill switch ────────────────────────

  console.log("\n--- §7.14 Ops on failure + kill switch ---\n");

  // 7.14a: Broken watch → ops alert, no customer price_change
  await test("Broken watch → ops alert, no customer price_change", async () => {
    // Clean outbox for this test
    const outboxDir = path.join(PROJECT_ROOT, "outbox");
    if (fs.existsSync(outboxDir)) {
      for (const f of fs.readdirSync(outboxDir)) fs.unlinkSync(path.join(outboxDir, f));
    }

    // Add a bogus competitor
    const res = await httpRequest(
      "POST",
      `${SERVICE_A}/customers/${customerId}/competitors`,
      {
        name: "Broken Site",
        pricing_url: "http://127.0.0.1:19999/",
        target_price_description: "nonexistent price",
      }
    );
    assert(res.status === 201, `Expected 201, got ${res.status}`);

    // Run onboarding worker — this will fail discovery for bogus URL
    runSafe("node scripts/run-onboarding-worker.js");

    // The bogus competitor should NOT be skill_ready, so enqueue won't pick it up.
    // Instead, we directly test monitor-lib with a broken skill.
    // Create a fake skill pointing to a bogus URL
    const fakeSkillId = "broken-test-skill";
    const fakeSkillPath = path.join(PROJECT_ROOT, "data", "skills", `${fakeSkillId}.json`);
    fs.writeFileSync(fakeSkillPath, JSON.stringify({
      id: fakeSkillId,
      method: "api",
      pricing_url: "http://127.0.0.1:19999/price.json",
      base_url: "http://127.0.0.1:19999/",
      target_price_description: "broken test",
    }, null, 2));

    // Manually enqueue a tick for this broken skill
    const monitorQueue = require("../src/monitor-queue");
    // Clear ticks
    fs.writeFileSync(monitorQueue.QUEUE_FILE, "[]");
    monitorQueue.enqueue({
      customerId,
      skillId: fakeSkillId,
      skillPath: `data/skills/${fakeSkillId}.json`,
      customerEmail: "alice@testcorp.com",
      customerName: "Test Corp",
    });

    const output = runSafe("node scripts/run-monitor-worker.js");

    const opsCount = countOutboxFiles("ops-alert");
    assert(opsCount >= 1, `Expected ops alert, got ${opsCount}`);

    const priceChangeCount = countOutboxFiles("price-change");
    assert(priceChangeCount === 0, `Expected 0 price_change on failure, got ${priceChangeCount}`);

    console.log("    Ops alert written, no false customer email");

    // Clean up fake skill
    if (fs.existsSync(fakeSkillPath)) fs.unlinkSync(fakeSkillPath);
  });

  // 7.14b: Kill switch — enqueue + run → no side effects
  await test("Kill switch (data/KILL) stops all ticks", async () => {
    // Clean outbox
    const outboxDir = path.join(PROJECT_ROOT, "outbox");
    if (fs.existsSync(outboxDir)) {
      for (const f of fs.readdirSync(outboxDir)) fs.unlinkSync(path.join(outboxDir, f));
    }

    // Enable kill switch
    const killFile = path.join(PROJECT_ROOT, "data", "KILL");
    fs.writeFileSync(killFile, "kill switch test\n");

    // Try to enqueue — should no-op
    const enqOutput = run("node scripts/enqueue-daily-ticks.js");
    assert(enqOutput.includes("Kill switch") || enqOutput.includes("kill"),
      "Enqueue should respect kill switch");

    const ticks = loadMonitorTicks();
    const pending = ticks.filter((t) => t.status === "pending");
    // Should not have enqueued any new ticks (previous ones were consumed)
    assert(pending.length === 0, `Expected 0 pending after kill, got ${pending.length}`);

    // Even if we manually add a tick, Service C should no-op
    const monitorQueue = require("../src/monitor-queue");
    // Temporarily remove kill file to enqueue, then re-add
    fs.unlinkSync(killFile);
    fs.writeFileSync(monitorQueue.QUEUE_FILE, "[]");
    monitorQueue.enqueue({
      customerId,
      skillId: "fake-kill-test",
      skillPath: "data/skills/fake.json",
      customerEmail: "alice@testcorp.com",
      customerName: "Test Corp",
    });
    // Re-enable kill switch
    fs.writeFileSync(killFile, "kill switch test\n");

    const cOutput = run("node scripts/run-monitor-worker.js");
    assert(cOutput.includes("Kill switch") || cOutput.includes("kill") || cOutput.includes("no-op"),
      "Service C should respect kill switch");

    const postKillChanges = countOutboxFiles("price-change");
    assert(postKillChanges === 0, `Expected 0 emails after kill switch, got ${postKillChanges}`);

    const postKillOps = countOutboxFiles("ops-alert");
    assert(postKillOps === 0, `Expected 0 ops alerts after kill switch, got ${postKillOps}`);

    console.log("    Kill switch honored — no outbox side effects");

    // Clean up kill switch
    if (fs.existsSync(killFile)) fs.unlinkSync(killFile);
  });

  // 7.14b-alt: Kill switch via env var
  await test("Kill switch (PRICEWATCH_KILL=1 env) stops all ticks", async () => {
    const outboxDir = path.join(PROJECT_ROOT, "outbox");
    if (fs.existsSync(outboxDir)) {
      for (const f of fs.readdirSync(outboxDir)) fs.unlinkSync(path.join(outboxDir, f));
    }

    const monitorQueue = require("../src/monitor-queue");
    fs.writeFileSync(monitorQueue.QUEUE_FILE, "[]");
    monitorQueue.enqueue({
      customerId,
      skillId: "fake-env-kill-test",
      skillPath: "data/skills/fake.json",
      customerEmail: "alice@testcorp.com",
      customerName: "Test Corp",
    });

    const output = execSync("PRICEWATCH_KILL=1 node scripts/run-monitor-worker.js", {
      cwd: PROJECT_ROOT,
      timeout: 10000,
      encoding: "utf8",
    });
    assert(output.includes("Kill switch") || output.includes("kill") || output.includes("no-op"),
      "Service C should respect PRICEWATCH_KILL env");

    const changes = countOutboxFiles("price-change");
    assert(changes === 0, `Expected 0 emails with env kill, got ${changes}`);

    console.log("    PRICEWATCH_KILL=1 honored");
  });

  // ─── Restore lab price ─────────────────────────────────────────

  await setLabPrice(29);

  // ─── Summary ───────────────────────────────────────────────────

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E test error:", err.message);
  process.exit(1);
});
