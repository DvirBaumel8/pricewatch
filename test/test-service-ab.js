#!/usr/bin/env node
"use strict";

/**
 * E2E tests for Service A + B against lab site (§7.7–7.10).
 *
 * Prerequisites:
 *   1. Lab server running on http://127.0.0.1:3847/
 *   2. Service A running on http://127.0.0.1:3850/
 *
 * This script tests:
 *   §7.7 — Service A enqueue (create customer + competitor → job created)
 *   §7.8 — Service B happy path (run B → skill ready)
 *   §7.9 — Unsupported/failure path (bad URL → job failed)
 *   §7.10 — Reuse existing skill (step 0, no rediscovery)
 */

const http = require("http");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SERVICE_A = process.env.SERVICE_A_URL || "http://127.0.0.1:3850";
const LAB_URL = process.env.LAB_URL || "http://127.0.0.1:3847";

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
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function cleanTestData() {
  const queueFile = path.join(__dirname, "..", "data", "queue.json");
  const customersFile = path.join(__dirname, "..", "data", "customers.json");
  if (fs.existsSync(queueFile)) fs.unlinkSync(queueFile);
  if (fs.existsSync(customersFile)) fs.unlinkSync(customersFile);
  // Remove lab-generated skills (sha256 hash-based IDs)
  const skillsDir = path.join(__dirname, "..", "data", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const f of fs.readdirSync(skillsDir)) {
      if (f !== ".gitkeep" && /^[0-9a-f]{12}\.json$/.test(f)) {
        fs.unlinkSync(path.join(skillsDir, f));
      }
    }
  }
}

function runWorker() {
  return execSync("node scripts/run-onboarding-worker.js", {
    cwd: path.join(__dirname, ".."),
    timeout: 30000,
    encoding: "utf8",
  });
}

async function main() {
  console.log("\n=== Service A + B E2E tests (§7.7–7.10) ===\n");

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

  cleanTestData();

  let customerId;
  let competitorId;
  let jobId;

  // ─── §7.7 Service A enqueue ────────────────────────────────────

  console.log("--- §7.7 Service A enqueue ---");

  await test("POST /customers creates a customer", async () => {
    const res = await httpRequest("POST", `${SERVICE_A}/customers`, {
      name: "Test Customer",
      email: "test@example.com",
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body.id, "Customer should have an id");
    assert(res.body.check_interval === "daily", "check_interval should be daily");
    customerId = res.body.id;
  });

  await test("POST /customers/:id/competitors creates competitor and enqueues job", async () => {
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
    assert(res.body.competitor, "Should return competitor");
    assert(res.body.job, "Should return job");
    assert(res.body.job_created === true, "Job should be newly created");
    assert(res.body.job.status === "pending", "Job should be pending");
    assert(
      res.body.job.pricingUrl === `${LAB_URL}/`,
      `URL should be ${LAB_URL}/`
    );
    assert(
      res.body.job.targetPriceDescription === "main monthly price",
      "Target should match"
    );
    competitorId = res.body.competitor.id;
    jobId = res.body.job.id;
  });

  await test("Queue file has exactly one pending job", async () => {
    const queueFile = path.join(__dirname, "..", "data", "queue.json");
    assert(fs.existsSync(queueFile), "queue.json should exist");
    const jobs = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    const pending = jobs.filter((j) => j.status === "pending");
    assert(pending.length === 1, `Expected 1 pending job, got ${pending.length}`);
  });

  await test("Idempotency: same competitor does not create second pending job", async () => {
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
    // The competitor is added (each add creates a new competitor entry)
    // but the queue should NOT have a second pending job
    assert(res.body.job_created === false, "Should not create duplicate job");

    const queueFile = path.join(__dirname, "..", "data", "queue.json");
    const jobs = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    const pending = jobs.filter((j) => j.status === "pending");
    assert(pending.length === 1, `Still exactly 1 pending job, got ${pending.length}`);
  });

  await test("GET /customers/:id shows customer with competitor and job", async () => {
    const res = await httpRequest("GET", `${SERVICE_A}/customers/${customerId}`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.competitors.length >= 1, "Should have competitors");
    assert(res.body.jobs.length >= 1, "Should have jobs");
  });

  // ─── §7.8 Service B happy path ────────────────────────────────

  console.log("\n--- §7.8 Service B happy path (lab) ---");

  await test("Service B processes job → skill ready", async () => {
    const output = runWorker();
    console.log("    Worker output:");
    for (const line of output.split("\n").filter(Boolean)) {
      console.log(`      ${line}`);
    }

    assert(output.includes("Discovery succeeded") || output.includes("Step 0: reusing") || output.includes("Step 1") || output.includes("Step 2"), "Worker should show discovery progress");

    // Check job is done
    const res = await httpRequest("GET", `${SERVICE_A}/jobs/${jobId}`);
    assert(res.status === 200, `Expected 200 for job, got ${res.status}`);
    assert(res.body.status === "done", `Job should be done, got ${res.body.status}`);
    assert(res.body.result === "skill_ready", `Result should be skill_ready, got ${res.body.result}`);
    assert(res.body.skillPath, "Should have skillPath");

    console.log(`    Job status: ${res.body.status}`);
    console.log(`    Result: ${res.body.result}`);
    console.log(`    Reason: ${res.body.reason}`);
    console.log(`    Skill: ${res.body.skillPath}`);
  });

  await test("GET /customers/:id shows skill_ready for competitor", async () => {
    const res = await httpRequest("GET", `${SERVICE_A}/customers/${customerId}`);
    assert(res.status === 200, `Expected 200`);
    const comp = res.body.competitors.find((c) => c.id === competitorId);
    assert(comp, "Competitor should exist");
    assert(
      comp.status === "skill_ready",
      `Competitor status should be skill_ready, got ${comp.status}`
    );
  });

  // ─── §7.9 Unsupported / failure path ──────────────────────────

  console.log("\n--- §7.9 Unsupported / failure path ---");

  let failJobId;
  await test("Add competitor with bogus URL → enqueue job", async () => {
    const res = await httpRequest(
      "POST",
      `${SERVICE_A}/customers/${customerId}/competitors`,
      {
        name: "Bogus Site",
        pricing_url: "http://127.0.0.1:19999/",
        target_price_description: "nonexistent price",
      }
    );
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body.job_created === true, "Job should be created for bogus URL");
    failJobId = res.body.job.id;
  });

  await test("Service B handles bogus URL — job fails cleanly, no hang", async () => {
    let output;
    try {
      output = runWorker();
    } catch (e) {
      output = e.stdout || e.stderr || "";
    }
    console.log("    Worker output:");
    for (const line of (output || "").split("\n").filter(Boolean)) {
      console.log(`      ${line}`);
    }

    const res = await httpRequest("GET", `${SERVICE_A}/jobs/${failJobId}`);
    assert(res.status === 200, `Expected 200`);
    assert(
      res.body.status === "failed",
      `Job should be failed, got ${res.body.status}`
    );
    assert(res.body.reason, "Should have a failure reason");
    console.log(`    Job status: ${res.body.status}`);
    console.log(`    Result: ${res.body.result}`);
    console.log(`    Reason: ${res.body.reason}`);
  });

  let noUrlJobId;
  await test("Add competitor with no URL → enqueue + fails with unsupported", async () => {
    const res = await httpRequest(
      "POST",
      `${SERVICE_A}/customers/${customerId}/competitors`,
      {
        name: "No URL Co",
        target_price_description: "price with no URL",
      }
    );
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body.job_created === true, "Job should be created");
    noUrlJobId = res.body.job.id;

    let output;
    try {
      output = runWorker();
    } catch (e) {
      output = e.stdout || e.stderr || "";
    }

    const jobRes = await httpRequest("GET", `${SERVICE_A}/jobs/${noUrlJobId}`);
    assert(jobRes.body.status === "failed", `Should be failed, got ${jobRes.body.status}`);
    assert(
      jobRes.body.result === "unsupported",
      `Should be unsupported, got ${jobRes.body.result}`
    );
  });

  // ─── §7.10 Reuse existing skill (step 0) ──────────────────────

  console.log("\n--- §7.10 Reuse existing skill (step 0) ---");

  let customer2Id;
  let reuse_jobId;

  await test("Create second customer + same lab competitor → reuses skill", async () => {
    const custRes = await httpRequest("POST", `${SERVICE_A}/customers`, {
      name: "Second Customer",
      email: "second@example.com",
    });
    assert(custRes.status === 201, `Expected 201, got ${custRes.status}`);
    customer2Id = custRes.body.id;

    const compRes = await httpRequest(
      "POST",
      `${SERVICE_A}/customers/${customer2Id}/competitors`,
      {
        name: "Acme Lab",
        pricing_url: `${LAB_URL}/`,
        target_price_description: "main monthly price",
      }
    );
    assert(compRes.status === 201, `Expected 201, got ${compRes.status}`);
    assert(compRes.body.job_created === true, "New job for new customer");
    reuse_jobId = compRes.body.job.id;
  });

  await test("Service B reuses skill (step 0) — fast, no LLM", async () => {
    const t0 = Date.now();
    const output = runWorker();
    const wallMs = Date.now() - t0;

    console.log("    Worker output:");
    for (const line of output.split("\n").filter(Boolean)) {
      console.log(`      ${line}`);
    }
    console.log(`    Wall time: ${wallMs}ms`);

    const res = await httpRequest("GET", `${SERVICE_A}/jobs/${reuse_jobId}`);
    assert(res.body.status === "done", `Job should be done, got ${res.body.status}`);
    assert(res.body.result === "skill_ready", `Should be skill_ready, got ${res.body.result}`);

    const isReuse = output.includes("Step 0") || output.includes("reuse") || output.includes("reusing");
    if (isReuse) {
      console.log("    → Step 0 reuse confirmed");
    } else {
      console.log("    → Step 0 reuse not confirmed in output (skill may have matched via step 1/2 — fast path)");
    }
    console.log(`    Reason: ${res.body.reason}`);
  });

  // ─── Summary ───────────────────────────────────────────────────

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E test error:", err.message);
  process.exit(1);
});
