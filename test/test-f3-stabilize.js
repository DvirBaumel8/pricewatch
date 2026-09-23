#!/usr/bin/env node
"use strict";

/**
 * F3 hard-fail tests — skill unify, failure_count, kill on mailer,
 * honest empty/blocked, plans path via Service C, noise gate.
 *
 * Offline where possible (no live network). Lab HTTP used only for
 * single-price happy-path sections when LAB_URL is reachable.
 *
 * Token budget: 0 LLM.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "data", "skills");
const SNAPSHOTS_DIR = path.join(ROOT, "data", "snapshots");
const OUTBOX_DIR = path.join(ROOT, "outbox");
const KILL_FILE = path.join(ROOT, "data", "KILL");
const REDISCOVERY_FILE = path.join(ROOT, "data", "rediscovery-queue.json");
const FIXTURE_DIR = path.join(__dirname, "fixtures", "f3");
const WEDGE_DIR = path.join(__dirname, "fixtures", "wedge");

const {
  normalizeSkill,
  isPlansSkill,
  isValidSinglePrice,
  isValidPlans,
  FAILURE_THRESHOLD,
} = require("../src/skill-schema");
const { recordFailure, recordSuccess } = require("../src/skill-failures");
const {
  runMonitorCheck,
  saveSnapshot,
  loadLatestSnapshot,
  writeOpsAlert,
  extractSinglePrice,
} = require("../src/monitor-lib");
const { diffPlanLadders } = require("../src/plan-ladder-diff");
const { isKilled, drainOutbox } = require("../scripts/send-outbox");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
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

function rmQuiet(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function cleanTestArtifacts() {
  rmQuiet(KILL_FILE);
  // skills
  for (const f of fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : []) {
    if (f.startsWith("f3-") && f.endsWith(".json")) {
      rmQuiet(path.join(SKILLS_DIR, f));
    }
  }
  // snapshots
  for (const f of fs.existsSync(SNAPSHOTS_DIR) ? fs.readdirSync(SNAPSHOTS_DIR) : []) {
    if (f.startsWith("f3-") && f.endsWith(".json")) {
      rmQuiet(path.join(SNAPSHOTS_DIR, f));
    }
  }
  const ladderDir = path.join(SNAPSHOTS_DIR, "ladder");
  if (fs.existsSync(ladderDir)) {
    for (const f of fs.readdirSync(ladderDir)) {
      if (f.startsWith("f3-") || f.includes("f3test")) rmQuiet(path.join(ladderDir, f));
    }
  }
  // outbox
  if (fs.existsSync(OUTBOX_DIR)) {
    for (const f of fs.readdirSync(OUTBOX_DIR)) {
      if (f.includes("f3-") || f.includes("f3test")) {
        rmQuiet(path.join(OUTBOX_DIR, f));
      }
    }
  }
  if (fs.existsSync(REDISCOVERY_FILE)) {
    try {
      const items = JSON.parse(fs.readFileSync(REDISCOVERY_FILE, "utf8"));
      const kept = items.filter((j) => !(j.skillId || "").startsWith("f3-"));
      fs.writeFileSync(REDISCOVERY_FILE, JSON.stringify(kept, null, 2) + "\n");
    } catch {
      /* ignore */
    }
  }
}

function writeSkill(id, obj) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const fp = path.join(SKILLS_DIR, `${id}.json`);
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n");
  return fp;
}

function readSkill(id) {
  return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, `${id}.json`), "utf8"));
}

function countOutbox(prefix) {
  if (!fs.existsSync(OUTBOX_DIR)) return 0;
  return fs.readdirSync(OUTBOX_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).length;
}

// ── schema unify ──────────────────────────────────────────────────

async function runSchemaTests() {
  console.log("\n--- F3: One skill schema ---\n");

  await test("normalizeSkill adapts lab selectors shape", () => {
    const lab = {
      id: "f3-lab",
      method: "dom",
      pricing_url: "http://127.0.0.1:3847/",
      selectors: {
        amount_attr: "data-amount",
        currency_attr: "data-currency",
        period_attr: "data-period",
      },
      normalize: {
        currency_field: "data-currency",
        period_field: "data-period",
      },
    };
    const s = normalizeSkill(lab);
    assert(s.method === "dom", "method");
    assert(s.selectors.amount_attr === "data-amount", "selectors");
    assert(s.normalize.currency_field === "data-currency", "normalize");
    assert(s.failure_count === 0, "failure_count default 0");
    assert(s.skill_status === "healthy", "healthy");
    assert(!isPlansSkill(s), "not plans");
  });

  await test("normalizeSkill adapts real-site regex shape", () => {
    const real = {
      id: "plausible-io-8e774063",
      method: "dom",
      pricing_url: "https://plausible.io/",
      site: "plausible.io",
      regex: "price\\(.*?'starter'.*?'monthly'\\).*?\\$(\\d+)",
      selector: "[x-text*=\"starter\"]",
      currency: "USD",
      period: "month",
      failure_count: 0,
    };
    const s = normalizeSkill(real);
    assert(s.method === "dom", "method");
    assert(s.regex, "regex kept");
    assert(s.normalize, "normalize present");
    assert(typeof s.failure_count === "number", "failure_count");
    // extract via regex works on sample HTML
    const html = `price(currency, volumeIndex, 'starter', 'monthly')"> $9 </span>`;
    const price = extractSinglePrice(html, s);
    assert(price.amount === 9, `amount=${price.amount}`);
  });

  await test("committed allowlist skills normalize + have failure_count", () => {
    for (const f of [
      "plausible-io.json",
      "vercel-com.json",
      "linear-app.json",
      "slack-com.json",
      "notion-com.json",
      "shopify-com.json",
    ]) {
      const raw = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
      const s = normalizeSkill(raw);
      assert(s.method, `${f} method`);
      assert(typeof s.failure_count === "number", `${f} failure_count`);
      assert(s.normalize, `${f} normalize`);
      assert(s.pricing_url, `${f} pricing_url`);
      // Real skills must be extractable via regex OR selectors after unify
      assert(s.regex || (s.selectors && s.selectors.amount_attr) || s.method === "api", `${f} extract hint`);
    }
  });
}

// ── failure_count ─────────────────────────────────────────────────

async function runFailureTests() {
  console.log("\n--- F3: failure_count + rediscovery ---\n");
  cleanTestArtifacts();

  const id = "f3-fail-skill";
  writeSkill(id, {
    id,
    method: "api",
    pricing_url: "http://127.0.0.1:9/nowhere",
    extract_mode: "single",
    failure_count: 0,
    skill_status: "healthy",
    normalize: { currency_field: "$.currency", period_field: "$.period" },
  });

  await test("recordFailure increments and persists", () => {
    const r1 = recordFailure(id, { reason: "fetch_fail" });
    assert(r1.failure_count === 1, `count=${r1.failure_count}`);
    assert(readSkill(id).failure_count === 1, "persisted");
  });

  await test("threshold marks unhealthy + queues rediscovery (step2-only)", () => {
    // bump to threshold
    let last;
    for (let i = readSkill(id).failure_count; i < FAILURE_THRESHOLD; i++) {
      last = recordFailure(id, { reason: "extract_fail" });
    }
    assert(last.failure_count >= FAILURE_THRESHOLD, "at threshold");
    assert(last.skill_status === "unhealthy", "unhealthy");
    assert(last.rediscoveryQueued, "rediscovery queued");
    const q = JSON.parse(fs.readFileSync(REDISCOVERY_FILE, "utf8"));
    const job = q.find((j) => j.skillId === id && j.status === "pending");
    assert(job, "job present");
    assert(job.step2Only === true, "step2Only");
    assert(job.llmTokens === 0, "0 LLM");
  });

  await test("recordSuccess resets failure_count", () => {
    const r = recordSuccess(id);
    assert(r.failure_count === 0, "reset");
    assert(readSkill(id).failure_count === 0, "persisted reset");
    assert(readSkill(id).skill_status === "healthy", "healthy again");
  });

  await test("runMonitorCheck fetch_fail bumps failure_count + ops_alert + no snapshot", async () => {
    cleanTestArtifacts();
    const sid = "f3-fetch-fail";
    writeSkill(sid, {
      id: sid,
      method: "api",
      pricing_url: "http://127.0.0.1:9/does-not-exist",
      failure_count: 0,
      skill_status: "healthy",
    });
    const beforeSnap = path.join(SNAPSHOTS_DIR, `${sid}.json`);
    rmQuiet(beforeSnap);
    const result = await runMonitorCheck(sid);
    assert(result.status === "fetch_fail", `status=${result.status}`);
    assert(result.opsAlertPath && fs.existsSync(result.opsAlertPath), "ops alert");
    assert(result.failure_count === 1, `failure_count=${result.failure_count}`);
    assert(!fs.existsSync(beforeSnap), "no snapshot written on fail");
  });
}

// ── empty extract never snapshots ─────────────────────────────────

async function runEmptyExtractTests() {
  console.log("\n--- F3: empty/invalid extract never snapshots ---\n");

  await test("isValidSinglePrice rejects empty/NaN", () => {
    assert(!isValidSinglePrice(null), "null");
    assert(!isValidSinglePrice({}), "empty obj");
    assert(!isValidSinglePrice({ amount: null }), "null amount");
    assert(!isValidSinglePrice({ amount: "x" }), "NaN");
    assert(isValidSinglePrice({ amount: 0 }), "zero ok");
    assert(isValidSinglePrice({ amount: 9.5 }), "number ok");
  });

  await test("saveSnapshot throws on invalid price", () => {
    let threw = false;
    try {
      saveSnapshot("f3-should-not-exist", { amount: null, currency: "USD", period: "month" });
    } catch {
      threw = true;
    }
    assert(threw, "should throw");
    assert(!fs.existsSync(path.join(SNAPSHOTS_DIR, "f3-should-not-exist.json")), "no file");
  });

  await test("DOM extract miss → extract_fail, no snapshot, failure_count++", async () => {
    cleanTestArtifacts();
    // Local HTTP server returning HTML without data-amount
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>No price here</h1></body></html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const sid = "f3-empty-dom";
    writeSkill(sid, {
      id: sid,
      method: "dom",
      pricing_url: `http://127.0.0.1:${port}/`,
      selectors: {
        amount_attr: "data-amount",
        currency_attr: "data-currency",
        period_attr: "data-period",
      },
      normalize: {
        currency_field: "data-currency",
        period_field: "data-period",
      },
      failure_count: 0,
    });
    const result = await runMonitorCheck(sid);
    server.close();
    assert(result.status === "extract_fail", `status=${result.status}`);
    assert(result.opsAlertPath, "ops alert");
    assert(!fs.existsSync(path.join(SNAPSHOTS_DIR, `${sid}.json`)), "no snapshot");
    assert(readSkill(sid).failure_count >= 1, "failure bumped");
  });

  await test("blocked challenge HTML → blocked, no snapshot", async () => {
    cleanTestArtifacts();
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><div id=\"cf-challenge-running\">Checking your browser...</div></body></html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const sid = "f3-blocked";
    writeSkill(sid, {
      id: sid,
      method: "api",
      pricing_url: `http://127.0.0.1:${port}/price.json`,
      failure_count: 0,
    });
    const result = await runMonitorCheck(sid);
    server.close();
    assert(result.status === "blocked", `status=${result.status}`);
    assert(result.opsAlertPath, "ops alert");
    assert(!fs.existsSync(path.join(SNAPSHOTS_DIR, `${sid}.json`)), "no fake price");
    assert(readSkill(sid).failure_count >= 1, "failure bumped");
  });
}

// ── kill switch on mailer ─────────────────────────────────────────

async function runKillMailerTests() {
  console.log("\n--- F3: mailer kill switch ---\n");
  cleanTestArtifacts();

  await test("isKilled true when PRICEWATCH_KILL=1", () => {
    const prev = process.env.PRICEWATCH_KILL;
    process.env.PRICEWATCH_KILL = "1";
    assert(isKilled() === true, "env kill");
    if (prev === undefined) delete process.env.PRICEWATCH_KILL;
    else process.env.PRICEWATCH_KILL = prev;
  });

  await test("isKilled true when data/KILL exists", () => {
    delete process.env.PRICEWATCH_KILL;
    fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
    fs.writeFileSync(KILL_FILE, "1\n");
    assert(isKilled() === true, "file kill");
    rmQuiet(KILL_FILE);
    assert(isKilled() === false, "cleared");
  });

  await test("drainOutbox no-ops under kill (sends nothing)", async () => {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const fake = path.join(OUTBOX_DIR, "f3-kill-test-mail.json");
    fs.writeFileSync(
      fake,
      JSON.stringify({
        type: "price_change",
        subject: "should not send",
        body: "nope",
        customer_email: "nobody@example.com",
      }) + "\n"
    );
    fs.writeFileSync(KILL_FILE, "1\n");
    const result = await drainOutbox();
    assert(result.killed === true, "killed flag");
    assert(result.sent === 0, "sent 0");
    assert(!fs.existsSync(fake + ".sent"), "no .sent marker");
    rmQuiet(KILL_FILE);
    rmQuiet(fake);
  });

  await test("CLI send-outbox with PRICEWATCH_KILL=1 exits 0 and prints kill", () => {
    const out = execSync("PRICEWATCH_KILL=1 node scripts/send-outbox.js", {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PRICEWATCH_KILL: "1" },
    });
    assert(/Kill switch/i.test(out), `output=${out}`);
  });
}

// ── noise gate + plans via Service C path ─────────────────────────

async function runPlansPathTests() {
  console.log("\n--- F3: plans/prices reachable from Service C + noise gate ---\n");

  const fixtureA = JSON.parse(
    fs.readFileSync(path.join(WEDGE_DIR, "fixture-a-price-bump.json"), "utf8")
  );
  const fixtureB = JSON.parse(
    fs.readFileSync(path.join(WEDGE_DIR, "fixture-b-banner-only.json"), "utf8")
  );

  await test("noise gate: price bump = signal", () => {
    const { hasSignal, changes } = diffPlanLadders(fixtureA.old_plans, fixtureA.new_plans);
    assert(hasSignal === true, "signal");
    assert(changes.some((c) => c.field === "price"), "price change");
  });

  await test("noise gate: banner/copy-only ≠ signal", () => {
    const { hasSignal, changes } = diffPlanLadders(fixtureB.old_plans, fixtureB.new_plans);
    assert(hasSignal === false, "no signal");
    assert(changes.length === 0, "no changes");
  });

  await test("Service C plans path: baseline then unchanged → 0 customer mail", async () => {
    cleanTestArtifacts();
    const plans = fixtureA.old_plans;
    const server = http.createServer((req, res) => {
      // Fake HTML that plan-ladder won't know — we stub via skill method plans
      // by monkeypatching extractPlanLadder through a local skill that uses
      // a custom approach: call runMonitorCheck with opts.skill that has method plans
      // and intercept by putting extract on a known site is hard.
      // Instead: unit-test runPlansMonitorCheck by injecting via require cache mock.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>f3 plans stub</html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    // Stub extractPlanLadder
    const planLadder = require("../src/plan-ladder");
    const original = planLadder.extractPlanLadder;
    planLadder.extractPlanLadder = async () => ({
      plans,
      method: "dom",
      tokens: 0,
      url: `http://127.0.0.1:${port}/pricing`,
      site: "f3test.example",
      error: null,
    });

    const sid = "f3-plans-skill";
    writeSkill(sid, {
      id: sid,
      method: "plans",
      extract_mode: "plans",
      pricing_url: `http://127.0.0.1:${port}/pricing`,
      site: "f3test.example",
      failure_count: 0,
      skill_status: "healthy",
    });

    const outBefore = countOutbox("plan-ladder_");
    const r1 = await runMonitorCheck(sid, {
      customerInfo: {
        customerId: "c-f3",
        customerEmail: "cust@example.com",
        customerName: "Cust",
      },
    });
    assert(r1.status === "no_email", `r1=${r1.status}`);
    assert(r1.reason === "first_run", `reason=${r1.reason}`);

    const r2 = await runMonitorCheck(sid, {
      customerInfo: {
        customerId: "c-f3",
        customerEmail: "cust@example.com",
        customerName: "Cust",
      },
    });
    assert(r2.status === "no_email", `r2=${r2.status}`);
    assert(r2.reason === "unchanged", `reason=${r2.reason}`);
    const outAfter = countOutbox("plan-ladder_");
    assert(outAfter === outBefore, "0 customer mail on unchanged");

    planLadder.extractPlanLadder = original;
    server.close();
  });

  await test("Service C plans path: price change → 1 outbox", async () => {
    cleanTestArtifacts();
    const planLadder = require("../src/plan-ladder");
    const original = planLadder.extractPlanLadder;
    let call = 0;
    planLadder.extractPlanLadder = async () => {
      call++;
      return {
        plans: call === 1 ? fixtureA.old_plans : fixtureA.new_plans,
        method: "dom",
        tokens: 0,
        url: "https://example-saas.com/pricing",
        site: "f3test.example",
        error: null,
      };
    };

    const sid = "f3-plans-change";
    writeSkill(sid, {
      id: sid,
      method: "plans",
      extract_mode: "plans",
      pricing_url: "https://example-saas.com/pricing",
      site: "f3test.example",
      failure_count: 0,
    });

    const r1 = await runMonitorCheck(sid, {
      customerInfo: { customerId: "c1", customerEmail: "a@b.com", customerName: "A" },
    });
    assert(r1.status === "no_email" && r1.reason === "first_run", "baseline");

    const beforeCount = fs
      .readdirSync(OUTBOX_DIR)
      .filter((f) => f.startsWith("plan-ladder_") && f.endsWith(".json")).length;

    const r2 = await runMonitorCheck(sid, {
      customerInfo: { customerId: "c1", customerEmail: "a@b.com", customerName: "A" },
    });
    assert(r2.status === "price_changed", `r2=${r2.status}`);
    assert(r2.emailPath && fs.existsSync(r2.emailPath), "email written");
    const email = JSON.parse(fs.readFileSync(r2.emailPath, "utf8"));
    assert(email.type === "plan_ladder_change" || email.changes, "plans email");
    const afterCount = fs
      .readdirSync(OUTBOX_DIR)
      .filter((f) => f.startsWith("plan-ladder_") && f.endsWith(".json")).length;
    assert(afterCount === beforeCount + 1, `exactly 1 new outbox, delta=${afterCount - beforeCount}`);

    planLadder.extractPlanLadder = original;
  });

  await test("Service C plans path: empty extract → ops_alert, no ladder snapshot used as current", async () => {
    cleanTestArtifacts();
    const planLadder = require("../src/plan-ladder");
    const original = planLadder.extractPlanLadder;
    planLadder.extractPlanLadder = async () => ({
      plans: null,
      method: null,
      tokens: 0,
      url: "https://example-saas.com/pricing",
      site: "f3test.example",
      error: "unsupported_site",
    });

    const sid = "f3-plans-empty";
    writeSkill(sid, {
      id: sid,
      method: "plans",
      extract_mode: "plans",
      pricing_url: "https://example-saas.com/pricing",
      site: "f3test.example",
      failure_count: 0,
    });

    const ladderSnap = path.join(SNAPSHOTS_DIR, "ladder", "f3test-example.json");
    rmQuiet(ladderSnap);
    const r = await runMonitorCheck(sid);
    assert(r.status === "extract_fail", `status=${r.status}`);
    assert(r.opsAlertPath, "ops alert");
    assert(!fs.existsSync(ladderSnap), "no ladder snapshot on empty");
    assert(readSkill(sid).failure_count >= 1, "failure bumped");

    planLadder.extractPlanLadder = original;
  });
}

// ── lab single-price path (optional if lab up) ────────────────────

function labUp() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:3847/price.json", (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function runLabOptional() {
  console.log("\n--- F3: lab single-price (optional) ---\n");
  if (!(await labUp())) {
    console.log("  SKIP  lab not running on :3847 (Chris: npm run lab)");
    return;
  }

  cleanTestArtifacts();
  const sid = "f3-lab-api";
  writeSkill(sid, {
    id: sid,
    version: 1,
    method: "api",
    extract_mode: "single",
    pricing_url: "http://127.0.0.1:3847/price.json",
    base_url: "http://127.0.0.1:3847/",
    target_price_description: "Acme Lab",
    json_path: "$.amount",
    normalize: { currency_field: "$.currency", period_field: "$.period" },
    failure_count: 0,
    skill_status: "healthy",
  });

  await test("lab unchanged → no_email (after baseline)", async () => {
    rmQuiet(path.join(SNAPSHOTS_DIR, `${sid}.json`));
    const r1 = await runMonitorCheck(sid, {
      customerInfo: { customerId: "lab", customerEmail: "lab@test.com", customerName: "Lab" },
    });
    assert(r1.status === "no_email" && r1.reason === "first_run", "baseline");
    const r2 = await runMonitorCheck(sid, {
      customerInfo: { customerId: "lab", customerEmail: "lab@test.com", customerName: "Lab" },
    });
    assert(r2.status === "no_email" && r2.reason === "unchanged", "unchanged");
    const changes = fs
      .readdirSync(OUTBOX_DIR)
      .filter((f) => f.startsWith(`price-change_${sid}`) && f.endsWith(".json"));
    assert(changes.length === 0, "0 customer mail");
  });
}

async function main() {
  console.log("\n=== F3 stabilize hard-fail tests ===\n");
  cleanTestArtifacts();
  await runSchemaTests();
  await runFailureTests();
  await runEmptyExtractTests();
  await runKillMailerTests();
  await runPlansPathTests();
  await runLabOptional();
  cleanTestArtifacts();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
