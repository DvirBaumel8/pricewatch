#!/usr/bin/env node
"use strict";

/**
 * Acceptance tests for §8.1–8.2 — outbox → real email delivery.
 *
 * §8.1: Lab price change → Service C → mailer → real inbox
 * §8.2: Unchanged price → zero customer emails
 *
 * Modes:
 *   - Mock mode (default): no creds → mailer exits 7, test verifies
 *     outbox files are correct and mailer is idempotent. Safe to run in CI.
 *   - Real-send mode: set RESEND_API_KEY (preferred) or PRICEWATCH_SMTP_PASS
 *     → mailer sends real email. For CEO / Carlos acceptance.
 *
 * Prerequisites:
 *   1. Lab server: node lab/server.js
 *   2. Service A:  node src/service-a.js
 *
 * Usage:
 *   node test/test-mailer.js                  # mock mode
 *   RESEND_API_KEY=re_xxx \
 *     PRICEWATCH_MAIL_FROM='PriceWatch <onboarding@resend.dev>' \
 *     PRICEWATCH_TEST_EMAIL=dvirbaumel9@gmail.com \
 *     node test/test-mailer.js                # real-send via Resend
 *   npm run test:e2e:mailer
 */

const http = require("http");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SERVICE_A = process.env.SERVICE_A_URL || "http://127.0.0.1:3850";
const LAB_URL = process.env.LAB_URL || "http://127.0.0.1:3847";
const PROJECT_ROOT = path.join(__dirname, "..");
const TEST_EMAIL = process.env.PRICEWATCH_TEST_EMAIL || "dvirbaumel9@gmail.com";
const HAS_CREDS = !!(process.env.PRICEWATCH_SMTP_PASS || process.env.RESEND_API_KEY);

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

function run(cmd, opts) {
  return execSync(cmd, {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    encoding: "utf8",
    env: { ...process.env },
    ...opts,
  });
}

function runSafe(cmd, opts) {
  try {
    return { stdout: run(cmd, opts), code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status };
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

  cleanOutbox();
}

function cleanOutbox() {
  const outboxDir = path.join(PROJECT_ROOT, "outbox");
  if (fs.existsSync(outboxDir)) {
    for (const f of fs.readdirSync(outboxDir)) {
      if (f === "sent") continue;
      fs.unlinkSync(path.join(outboxDir, f));
    }
  }
  const sentDir = path.join(PROJECT_ROOT, "outbox", "sent");
  if (fs.existsSync(sentDir)) {
    for (const f of fs.readdirSync(sentDir)) {
      fs.unlinkSync(path.join(sentDir, f));
    }
  }
}

function countOutboxFiles(type) {
  const outboxDir = path.join(PROJECT_ROOT, "outbox");
  if (!fs.existsSync(outboxDir)) return 0;
  return fs.readdirSync(outboxDir).filter((f) =>
    f.startsWith(type) && f.endsWith(".json") && !f.endsWith(".sent")
  ).length;
}

function countSentMarkers() {
  const outboxDir = path.join(PROJECT_ROOT, "outbox");
  if (!fs.existsSync(outboxDir)) return 0;
  return fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json.sent")).length;
}

function readOutboxFiles(type) {
  const outboxDir = path.join(PROJECT_ROOT, "outbox");
  if (!fs.existsSync(outboxDir)) return [];
  return fs
    .readdirSync(outboxDir)
    .filter((f) => f.startsWith(type) && f.endsWith(".json") && !f.endsWith(".sent"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(outboxDir, f), "utf8")));
}

function setLabPrice(amount) {
  return httpRequest("POST", `${LAB_URL}/set-price`, { amount });
}

function resetMonitorTicks() {
  const ticksFile = path.join(PROJECT_ROOT, "data", "monitor-ticks.json");
  fs.writeFileSync(ticksFile, "[]");
}

async function main() {
  console.log("\n=== Mailer acceptance tests (§8.1–8.2) ===\n");
  console.log(`  Mode: ${HAS_CREDS ? "REAL-SEND (credentials detected)" : "MOCK (no credentials)"}`);
  console.log(`  Test email: ${TEST_EMAIL}`);
  console.log("");

  try {
    await httpRequest("GET", LAB_URL + "/price.json");
  } catch {
    console.error(`ERROR: Lab server not reachable at ${LAB_URL}`);
    console.error("Start it with: node lab/server.js");
    process.exit(1);
  }

  try {
    await httpRequest("GET", SERVICE_A + "/customers");
  } catch {
    console.error(`ERROR: Service A not reachable at ${SERVICE_A}`);
    console.error("Start it with: node src/service-a.js");
    process.exit(1);
  }

  await setLabPrice(29);
  cleanTestData();

  // ─── Setup: A/B pipeline ─────────────────────────────────────

  console.log("--- Setup: A → B pipeline ---\n");

  let customerId;

  await test("Create customer with test email", async () => {
    const res = await httpRequest("POST", `${SERVICE_A}/customers`, {
      name: "Mailer Test Corp",
      email: TEST_EMAIL,
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    customerId = res.body.id;
    assert(customerId, "Should have customer id");
  });

  await test("Add lab competitor", async () => {
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
  });

  await test("Service B discovers skill", async () => {
    run("node scripts/run-onboarding-worker.js");
    const custRes = await httpRequest("GET", `${SERVICE_A}/customers/${customerId}`);
    const comp = custRes.body.competitors[0];
    assert(comp.status === "skill_ready", `Expected skill_ready, got ${comp.status}`);
  });

  // ─── §8.2 No false email (unchanged price) ───────────────────

  console.log("\n--- §8.2 No false email (unchanged price) ---\n");

  await test("Baseline run: no customer email", async () => {
    run("node scripts/enqueue-daily-ticks.js");
    run("node scripts/run-monitor-worker.js");

    const changeCount = countOutboxFiles("price-change");
    assert(changeCount === 0, `Expected 0 price_change, got ${changeCount}`);
  });

  await test("Second run (unchanged): still zero customer emails", async () => {
    resetMonitorTicks();
    run("node scripts/enqueue-daily-ticks.js");
    run("node scripts/run-monitor-worker.js");

    const changeCount = countOutboxFiles("price-change");
    assert(changeCount === 0, `Expected 0 price_change after unchanged, got ${changeCount}`);
  });

  if (HAS_CREDS) {
    await test("Mailer on empty outbox: nothing to send", async () => {
      const result = runSafe("node scripts/send-outbox.js");
      assert(result.code === 0, `Expected exit 0, got ${result.code}`);
      assert(
        (result.stdout || "").includes("No outbox files") || (result.stdout || "").includes("0 sent"),
        "Should report nothing to send"
      );
    });
  } else {
    await test("Mailer no-ops with exit code 7 (no credentials)", async () => {
      const result = runSafe("node scripts/send-outbox.js");
      assert(result.code === 7, `Expected exit 7, got ${result.code}`);
      assert(
        (result.stdout || "").includes("No mail credentials"),
        "Should log no-credentials message"
      );
    });
  }

  // ─── §8.1 Price change → real email ───────────────────────────

  console.log("\n--- §8.1 Price change → outbox + mailer ---\n");

  await test("Change lab price → exactly one price_change in outbox", async () => {
    cleanOutbox();
    await setLabPrice(49);

    resetMonitorTicks();
    run("node scripts/enqueue-daily-ticks.js");
    run("node scripts/run-monitor-worker.js");

    const changeCount = countOutboxFiles("price-change");
    assert(changeCount === 1, `Expected 1 price_change, got ${changeCount}`);

    const emails = readOutboxFiles("price-change");
    const email = emails[0];
    assert(email.type === "price_change", "Type should be price_change");
    assert(email.before.amount === 29, `Before should be 29, got ${email.before.amount}`);
    assert(email.after.amount === 49, `After should be 49, got ${email.after.amount}`);
    assert(email.customer_id === customerId, "Should include customer_id");
    assert(email.customer_email === TEST_EMAIL, `Should include customer_email=${TEST_EMAIL}`);
    console.log(`    Outbox: before=$${email.before.amount} after=$${email.after.amount} to=${email.customer_email}`);
  });

  if (HAS_CREDS) {
    await test("Mailer sends real email", async () => {
      const result = runSafe("node scripts/send-outbox.js");
      assert(result.code === 0, `Expected exit 0, got ${result.code}`);
      const out = result.stdout || "";
      assert(out.includes("sent") && out.includes(TEST_EMAIL),
        "Should report sent to test email");
      console.log(`    REAL EMAIL SENT to ${TEST_EMAIL}`);

      const sentCount = countSentMarkers();
      assert(sentCount >= 1, `Expected ≥1 .sent markers, got ${sentCount}`);
    });

    await test("Idempotent: re-run mailer does not duplicate", async () => {
      const result = runSafe("node scripts/send-outbox.js");
      assert(result.code === 0, `Expected exit 0, got ${result.code}`);
      const out = result.stdout || "";
      assert(out.includes("skip") || out.includes("already sent") || out.includes("0 sent"),
        "Should skip already-sent files");
      console.log("    Re-run: no duplicate email");
    });
  } else {
    await test("Mailer exits 7 — outbox file preserved for real-send later", async () => {
      const result = runSafe("node scripts/send-outbox.js");
      assert(result.code === 7, `Expected exit 7, got ${result.code}`);

      const changeCount = countOutboxFiles("price-change");
      assert(changeCount === 1, `Outbox file should still exist, got ${changeCount}`);
      console.log("    Outbox preserved. To test real send via Resend:");
      console.log("    RESEND_API_KEY=re_xxx PRICEWATCH_MAIL_FROM='PriceWatch <onboarding@resend.dev>' node scripts/send-outbox.js");
    });

    await test("Idempotent: .sent sidecar prevents re-send (mock)", async () => {
      const outboxDir = path.join(PROJECT_ROOT, "outbox");
      const files = fs.readdirSync(outboxDir).filter((f) =>
        f.startsWith("price-change") && f.endsWith(".json") && !f.endsWith(".sent")
      );
      assert(files.length >= 1, "Should have at least one outbox file");

      const filePath = path.join(outboxDir, files[0]);
      const marker = { sent_at: new Date().toISOString(), transport: "mock-test", file: files[0] };
      fs.writeFileSync(filePath + ".sent", JSON.stringify(marker, null, 2) + "\n");

      const { isSent } = require("../scripts/send-outbox.js");
      assert(isSent(filePath), "isSent should return true for file with .sent sidecar");
      console.log("    .sent sidecar idempotency verified");

      fs.unlinkSync(filePath + ".sent");
    });
  }

  // ─── Restore lab ──────────────────────────────────────────────

  await setLabPrice(29);
  cleanTestData();

  // ─── Summary ──────────────────────────────────────────────────

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (HAS_CREDS) {
    console.log("    Mode: REAL-SEND — check inbox for test email");
  } else {
    console.log("    Mode: MOCK — outbox + idempotency verified");
    console.log("    For real-send acceptance (CEO) via Resend:");
    console.log("      RESEND_API_KEY=re_xxx \\");
    console.log("        PRICEWATCH_MAIL_FROM='PriceWatch <onboarding@resend.dev>' \\");
    console.log("        PRICEWATCH_TEST_EMAIL=dvirbaumel9@gmail.com \\");
    console.log("        npm run test:e2e:mailer");
  }
  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test error:", err.message);
  process.exit(1);
});
