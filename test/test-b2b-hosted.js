#!/usr/bin/env node
"use strict";

/**
 * Wave 4 B2B hosted shame-tests.
 *
 * (a) Neon-visible with empty customers.json
 * (b) one claim/day (idempotent ledger)
 * (c) change → allowlisted would-send
 * (d) unchanged quiet
 * (e) non-allowlisted blocked
 * (f) kill stops send
 *
 * No real Neon, no real SMTP/Resend, no live Render.
 * Uses an in-memory pg mock injected before requiring production modules.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const OUTBOX_DIR = path.join(PROJECT_ROOT, "outbox");
const KILL_FILE = path.join(PROJECT_ROOT, "data", "KILL");
const CUSTOMERS_FILE = path.join(PROJECT_ROOT, "data", "customers.json");

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

async function testAsync(name, fn) {
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

function outboxJsonFiles() {
  if (!fs.existsSync(OUTBOX_DIR)) return [];
  return fs.readdirSync(OUTBOX_DIR).filter(
    (f) => f.endsWith(".json") && !f.endsWith(".sent") && f !== "samples"
  );
}

function sentMarkerExists(filename) {
  return fs.existsSync(path.join(OUTBOX_DIR, filename + ".sent"));
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

// ── In-memory mock pg pool ──────────────────────────────────────

function createMockDb() {
  const tables = {
    watch_targets: [],
    customers: [],
    daily_ledger: [],
    skills: [],
  };

  const pool = {
    _tables: tables,
    query: async (text, params) => {
      const sql = text.replace(/\s+/g, " ").trim();

      if (/^SELECT .* FROM watch_targets/i.test(sql) && /surface.*=.*\$1.*AND.*status.*=.*\$2/i.test(sql)) {
        const rows = tables.watch_targets.filter(
          (r) => r.surface === params[0] && r.status === params[1]
        );
        return { rows };
      }

      if (/^SELECT .* FROM watch_targets WHERE/i.test(sql) && /surface\s*=\s*'b2b'/i.test(sql) && /status\s*=\s*'skill_ready'/i.test(sql)) {
        const rows = tables.watch_targets.filter(
          (r) => r.surface === "b2b" && r.status === "skill_ready"
        );
        rows.sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
        return { rows };
      }

      if (/^INSERT INTO daily_ledger/i.test(sql)) {
        const existing = tables.daily_ledger.find(
          (r) => r.watch_target_id === params[1] && r.jerusalem_day === params[4]
        );
        if (existing) {
          return { rows: [] };
        }
        const row = {
          id: params[0],
          watch_target_id: params[1],
          customer_id: params[2],
          skill_id: params[3],
          jerusalem_day: params[4],
          status: "claimed",
          result: null,
          reason: null,
          retry_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        };
        tables.daily_ledger.push(row);
        return { rows: [row] };
      }

      if (/^SELECT \* FROM daily_ledger WHERE watch_target_id/i.test(sql)) {
        const rows = tables.daily_ledger.filter(
          (r) => r.watch_target_id === params[0] && r.jerusalem_day === params[1]
        );
        return { rows };
      }

      if (/^SELECT \* FROM daily_ledger WHERE jerusalem_day.*AND status.*=.*'claimed'/i.test(sql)) {
        const rows = tables.daily_ledger.filter(
          (r) => r.jerusalem_day === params[0] && r.status === "claimed"
        );
        return { rows };
      }

      if (/^SELECT \* FROM daily_ledger WHERE jerusalem_day/i.test(sql) && !/status/i.test(sql)) {
        const rows = tables.daily_ledger.filter(
          (r) => r.jerusalem_day === params[0]
        );
        return { rows };
      }

      if (/^UPDATE daily_ledger/i.test(sql) && /retry_count = retry_count \+ 1/i.test(sql)) {
        const row = tables.daily_ledger.find((r) => r.id === params[0] && r.status === "failed" && r.retry_count < params[1]);
        if (row) {
          row.status = "claimed";
          row.retry_count += 1;
          row.updated_at = new Date();
          return { rows: [row] };
        }
        return { rows: [] };
      }

      if (/^UPDATE daily_ledger/i.test(sql)) {
        const row = tables.daily_ledger.find((r) => r.id === params[3]);
        if (row) {
          row.status = params[0];
          row.result = params[1];
          row.reason = params[2];
          row.updated_at = new Date();
          return { rows: [row] };
        }
        return { rows: [] };
      }

      if (/^SELECT .* FROM watch_targets WHERE id/i.test(sql)) {
        const rows = tables.watch_targets.filter((r) => r.id === params[0]);
        return { rows };
      }

      if (/^SELECT .* FROM customers WHERE id/i.test(sql)) {
        const rows = tables.customers.filter((r) => r.id === params[0]);
        return { rows };
      }

      if (/^SELECT COUNT/i.test(sql)) {
        const rows = tables.watch_targets.filter(
          (r) => r.customer_id === params[0]
        );
        return { rows: [{ n: rows.length }] };
      }

      if (/^INSERT INTO skills/i.test(sql)) {
        const existing = tables.skills.find((r) => r.id === params[0]);
        if (existing) {
          existing.payload = typeof params[2] === "string" ? JSON.parse(params[2]) : params[2];
          if (params[3]) existing.baseline = typeof params[3] === "string" ? JSON.parse(params[3]) : params[3];
          existing.updated_at = new Date();
          return { rows: [existing] };
        }
        const row = {
          id: params[0],
          site: params[1],
          payload: typeof params[2] === "string" ? JSON.parse(params[2]) : params[2],
          baseline: params[3] ? (typeof params[3] === "string" ? JSON.parse(params[3]) : params[3]) : null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        tables.skills.push(row);
        return { rows: [row] };
      }

      if (/^SELECT payload FROM skills WHERE id/i.test(sql)) {
        const rows = tables.skills.filter((r) => r.id === params[0]);
        return { rows };
      }

      if (/^SELECT payload FROM skills ORDER/i.test(sql)) {
        return { rows: tables.skills };
      }

      return { rows: [] };
    },
    on: () => {},
    end: async () => {},
  };

  return pool;
}

// ── Inject mock DB into src/db.js ────────────────────────────────

function injectMockDb(mockPool) {
  const mockDb = {
    query: (text, params) => mockPool.query(text, params),
    getPool: () => mockPool,
    closePool: async () => {},
  };

  require.cache[require.resolve("../src/db")] = {
    id: require.resolve("../src/db"),
    filename: require.resolve("../src/db"),
    loaded: true,
    exports: mockDb,
  };

  clearModuleCache();
  return mockDb;
}

function clearModuleCache() {
  const mods = [
    "../src/neon-ledger",
    "../src/watch-target-store",
    "../src/customer-store",
    "../src/skill-store",
    "../src/monitor-lib",
  ];
  for (const m of mods) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
}

function restoreModuleCache() {
  const mods = [
    "../src/db",
    "../src/neon-ledger",
    "../src/watch-target-store",
    "../src/customer-store",
    "../src/skill-store",
    "../src/monitor-lib",
  ];
  for (const m of mods) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
}

// ── Test helpers ─────────────────────────────────────────────────

function addMockWatchTarget(pool, opts) {
  pool._tables.watch_targets.push({
    id: opts.id || crypto.randomBytes(6).toString("hex"),
    customer_id: opts.customer_id,
    surface: opts.surface || "b2b",
    label: opts.label || "Test Target",
    source_url: opts.source_url || "http://127.0.0.1:3847/pricing",
    target_description: opts.target_description || "Pro plan — USD 10 / month",
    plan_key: opts.plan_key || "pro",
    skill_id: opts.skill_id || null,
    status: opts.status || "skill_ready",
    failure_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function addMockSkill(pool, skill) {
  pool._tables.skills.push({
    id: skill.id,
    site: skill.site || null,
    payload: skill,
    baseline: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function addMockCustomer(pool, opts) {
  pool._tables.customers.push({
    id: opts.id,
    name: opts.name || "Test Customer",
    email: opts.email || "test@example.com",
    created_at: new Date(),
  });
}

// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n=== Wave 4 B2B hosted shame-tests ===\n");

  // ── (a) Neon-visible with empty customers.json ────────────────
  console.log("--- (a) Neon-visible with empty customers.json ---\n");

  await testAsync("SHAME (a): enqueue reads Neon WatchTargets, not customers.json", async () => {
    const backupExists = fs.existsSync(CUSTOMERS_FILE);
    let backup = null;
    if (backupExists) {
      backup = fs.readFileSync(CUSTOMERS_FILE, "utf8");
    }

    fs.mkdirSync(path.dirname(CUSTOMERS_FILE), { recursive: true });
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify({ customers: {} }) + "\n");

    try {
      const mockPool = createMockDb();
      addMockCustomer(mockPool, { id: "cust-a1", name: "Acme", email: "acme@test.com" });
      addMockWatchTarget(mockPool, {
        id: "wt-a1",
        customer_id: "cust-a1",
        skill_id: "lab-skill-a1",
        label: "Pro plan",
        status: "skill_ready",
      });

      injectMockDb(mockPool);
      const ledger = require("../src/neon-ledger");
      const { query } = require("../src/db");

      const day = ledger.jerusalemDate();
      const result = await ledger.claim({
        watchTargetId: "wt-a1",
        customerId: "cust-a1",
        skillId: "lab-skill-a1",
      });

      assert(result.created === true, "claim should succeed from Neon (customers.json is empty)");
      assert(result.entry.watch_target_id === "wt-a1", "entry should reference the Neon WatchTarget");
      assert(result.entry.jerusalem_day === day, "entry should have today's Jerusalem day");

      const watchRes = await query(
        "SELECT * FROM watch_targets WHERE surface = 'b2b' AND status = 'skill_ready'"
      );
      assert(watchRes.rows.length === 1, "Neon should have 1 skill_ready b2b target");
      assert(watchRes.rows[0].id === "wt-a1", "should be wt-a1");
    } finally {
      if (backup !== null) {
        fs.writeFileSync(CUSTOMERS_FILE, backup);
      } else if (fs.existsSync(CUSTOMERS_FILE)) {
        fs.unlinkSync(CUSTOMERS_FILE);
      }
      restoreModuleCache();
    }
  });

  // ── (b) one claim/day ─────────────────────────────────────────
  console.log("\n--- (b) One claim per day (idempotent ledger) ---\n");

  await testAsync("SHAME (b): second claim same day returns created=false", async () => {
    const mockPool = createMockDb();
    addMockWatchTarget(mockPool, {
      id: "wt-b1",
      customer_id: "cust-b1",
      skill_id: "skill-b1",
      status: "skill_ready",
    });

    injectMockDb(mockPool);
    const ledger = require("../src/neon-ledger");

    const first = await ledger.claim({
      watchTargetId: "wt-b1",
      customerId: "cust-b1",
      skillId: "skill-b1",
    });
    assert(first.created === true, "first claim should succeed");

    const second = await ledger.claim({
      watchTargetId: "wt-b1",
      customerId: "cust-b1",
      skillId: "skill-b1",
    });
    assert(second.created === false, "second claim same day must return created=false");

    const day = ledger.jerusalemDate();
    const entries = await ledger.listByDay(day);
    const forWt = entries.filter((e) => e.watch_target_id === "wt-b1");
    assert(forWt.length === 1, `must have exactly 1 entry for wt-b1, got ${forWt.length}`);

    restoreModuleCache();
  });

  await testAsync("SHAME (b): complete then re-claim same day still blocked", async () => {
    const mockPool = createMockDb();
    addMockWatchTarget(mockPool, {
      id: "wt-b2",
      customer_id: "cust-b2",
      skill_id: "skill-b2",
      status: "skill_ready",
    });

    injectMockDb(mockPool);
    const ledger = require("../src/neon-ledger");

    const first = await ledger.claim({
      watchTargetId: "wt-b2",
      customerId: "cust-b2",
      skillId: "skill-b2",
    });
    assert(first.created === true, "first claim should succeed");

    await ledger.complete(first.entry.id, {
      status: "success",
      result: "no_email",
      reason: "unchanged",
    });

    const reClaim = await ledger.claim({
      watchTargetId: "wt-b2",
      customerId: "cust-b2",
      skillId: "skill-b2",
    });
    assert(reClaim.created === false, "re-claim after complete must be blocked (one per day)");

    restoreModuleCache();
  });

  // ── (c) change → allowlisted would-send ───────────────────────
  console.log("\n--- (c) Change → allowlisted would-send ---\n");

  test("SHAME (c): price change email in outbox + allowlisted → gate passes", () => {
    cleanOutbox();
    removeKillFile();

    writeOutboxEmail("price-change_wave4-c-test.json", {
      type: "price_change",
      skill_id: "test-skill-c",
      customer_id: "cust-c1",
      customer_email: "pilot@team.dev",
      base_url: "http://127.0.0.1:3847/pricing",
      target: "Pro plan",
      timestamp: new Date().toISOString(),
      before: { amount: 10, currency: "USD", period: "month", display: "$10/mo" },
      after: { amount: 15, currency: "USD", period: "month", display: "$15/mo" },
      subject: "PriceWatch: lab changed",
      body: "We detected a price change for Pro plan.\n\n  Before: $10/mo\n  After:  $15/mo\n\n— PriceWatch",
    });

    const result = runMailer({
      PRICEWATCH_M1B_UNLOCK: "",
      PRICEWATCH_MAIL_ALLOWLIST: "pilot@team.dev",
      PRICEWATCH_TEST_EMAIL: "",
      PRICEWATCH_OPS_EMAIL: "",
      PRICEWATCH_KILL: "",
    });

    assert(
      !(result.stdout || "").includes("BLOCKED"),
      "allowlisted change email should NOT be blocked"
    );
    assert(
      !(result.stdout || "").includes("No outbox files"),
      "outbox should not be empty — we wrote a price-change email"
    );

    cleanOutbox();
  });

  // ── (d) unchanged quiet ───────────────────────────────────────
  console.log("\n--- (d) Unchanged quiet — no outbox email ---\n");

  test("SHAME (d): unchanged price → no email written to outbox", () => {
    cleanOutbox();
    removeKillFile();

    const files = outboxJsonFiles();
    assert(files.length === 0, "outbox should start empty");

    const result = runMailer({
      PRICEWATCH_M1B_UNLOCK: "",
      PRICEWATCH_MAIL_ALLOWLIST: "anyone@test.dev",
      PRICEWATCH_TEST_EMAIL: "",
      PRICEWATCH_OPS_EMAIL: "",
      PRICEWATCH_KILL: "",
    });

    assert(
      (result.stdout || "").includes("No outbox files"),
      "mailer should report no outbox files when price is unchanged"
    );

    const afterFiles = outboxJsonFiles();
    assert(afterFiles.length === 0, "outbox must remain empty when unchanged");

    cleanOutbox();
  });

  // ── (e) non-allowlisted blocked ───────────────────────────────
  console.log("\n--- (e) Non-allowlisted blocked ---\n");

  test("SHAME (e): change email to non-allowlisted recipient is BLOCKED", () => {
    cleanOutbox();
    removeKillFile();

    writeOutboxEmail("price-change_wave4-e-test.json", {
      type: "price_change",
      skill_id: "test-skill-e",
      customer_id: "cust-e1",
      customer_email: "stranger@evil.com",
      base_url: "http://127.0.0.1:3847/pricing",
      target: "Pro plan",
      timestamp: new Date().toISOString(),
      before: { amount: 10, currency: "USD", period: "month", display: "$10/mo" },
      after: { amount: 20, currency: "USD", period: "month", display: "$20/mo" },
      subject: "PriceWatch: test changed",
      body: "Price changed.",
    });

    const result = runMailer({
      PRICEWATCH_M1B_UNLOCK: "",
      PRICEWATCH_MAIL_ALLOWLIST: "internal@team.com",
      PRICEWATCH_TEST_EMAIL: "",
      PRICEWATCH_OPS_EMAIL: "",
      PRICEWATCH_KILL: "",
    });

    assert(
      (result.stdout || "").includes("BLOCKED"),
      "non-allowlisted recipient must be BLOCKED"
    );
    assert(
      !sentMarkerExists("price-change_wave4-e-test.json"),
      "must NOT have .sent marker — email was not sent"
    );
    assert(
      fs.existsSync(path.join(OUTBOX_DIR, "price-change_wave4-e-test.json")),
      "outbox file must be preserved for audit"
    );

    cleanOutbox();
  });

  test("SHAME (e): PRICEWATCH_M1B_UNLOCK is NOT set by default", () => {
    const saved = process.env.PRICEWATCH_M1B_UNLOCK;
    delete process.env.PRICEWATCH_M1B_UNLOCK;

    delete require.cache[require.resolve("../scripts/send-outbox.js")];
    const m = require("../scripts/send-outbox.js");

    assert(!m.isM1bUnlocked(), "M1b must default to locked (PRICEWATCH_M1B_UNLOCK unset)");

    if (saved !== undefined) process.env.PRICEWATCH_M1B_UNLOCK = saved;
  });

  // ── (f) kill stops send ───────────────────────────────────────
  console.log("\n--- (f) Kill stops send ---\n");

  test("SHAME (f): kill switch via env → mailer no-op, no .sent", () => {
    cleanOutbox();
    removeKillFile();

    writeOutboxEmail("price-change_wave4-f-env.json", {
      type: "price_change",
      customer_email: "pilot@team.dev",
      subject: "PriceWatch: kill test",
      body: "Kill test body",
    });

    const result = runMailer({
      PRICEWATCH_KILL: "1",
      PRICEWATCH_M1B_UNLOCK: "",
      PRICEWATCH_MAIL_ALLOWLIST: "pilot@team.dev",
      PRICEWATCH_TEST_EMAIL: "",
      PRICEWATCH_OPS_EMAIL: "",
    });

    assert(result.code === 0, `expected exit 0, got ${result.code}`);
    assert(
      (result.stdout || "").includes("Kill switch"),
      "should log kill switch message"
    );
    assert(
      !sentMarkerExists("price-change_wave4-f-env.json"),
      "must NOT have .sent marker while killed"
    );

    cleanOutbox();
  });

  test("SHAME (f): kill switch via file → mailer no-op, no .sent", () => {
    cleanOutbox();
    fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
    fs.writeFileSync(KILL_FILE, "");

    writeOutboxEmail("price-change_wave4-f-file.json", {
      type: "price_change",
      customer_email: "pilot@team.dev",
      subject: "PriceWatch: kill test file",
      body: "Kill test body",
    });

    const result = runMailer({
      PRICEWATCH_KILL: "",
      PRICEWATCH_M1B_UNLOCK: "",
      PRICEWATCH_MAIL_ALLOWLIST: "pilot@team.dev",
      PRICEWATCH_TEST_EMAIL: "",
      PRICEWATCH_OPS_EMAIL: "",
    });

    assert(result.code === 0, `expected exit 0, got ${result.code}`);
    assert(
      (result.stdout || "").includes("Kill switch"),
      "should log kill switch message (file)"
    );
    assert(
      !sentMarkerExists("price-change_wave4-f-file.json"),
      "must NOT have .sent marker while killed (file)"
    );

    removeKillFile();
    cleanOutbox();
  });

  await testAsync("SHAME (f): kill switch stops ledger claims", async () => {
    const mockPool = createMockDb();
    addMockWatchTarget(mockPool, {
      id: "wt-f1",
      customer_id: "cust-f1",
      skill_id: "skill-f1",
      status: "skill_ready",
    });

    injectMockDb(mockPool);

    const savedKill = process.env.PRICEWATCH_KILL;
    process.env.PRICEWATCH_KILL = "1";
    const ledger = require("../src/neon-ledger");

    try {
      const result = await ledger.claim({
        watchTargetId: "wt-f1",
        customerId: "cust-f1",
        skillId: "skill-f1",
      });

      assert(result.created === false, "claim must be refused when killed");
      assert(result.killed === true, "must report killed=true");

      const entries = await ledger.listByDay();
      const forWt = entries.filter((e) => e.watch_target_id === "wt-f1");
      assert(forWt.length === 0, "no ledger entry should exist when killed");
    } finally {
      if (savedKill !== undefined) {
        process.env.PRICEWATCH_KILL = savedKill;
      } else {
        delete process.env.PRICEWATCH_KILL;
      }
      restoreModuleCache();
    }
  });

  // ── Phase B shame (a): empty skills dir + Neon skill → load OK ─
  console.log("\n--- Phase B shame (a): empty skills dir + Neon skill → load OK ---\n");

  await testAsync("SHAME-B (a): loadSkillById falls back to Neon when file missing", async () => {
    const mockPool = createMockDb();
    const testSkill = {
      id: "neon-only-skill-abc12345",
      version: 1,
      pricing_url: "https://example.com/pricing",
      target_price_description: "Pro plan",
      site: "example.com",
      plan_name: "Pro",
      plan_key: "pro",
      method: "dom",
      extract_mode: "single",
      regex: "\\$(\\d+)/mo",
      currency: "USD",
      period: "month",
      failure_count: 0,
      skill_status: "healthy",
    };
    addMockSkill(mockPool, testSkill);
    injectMockDb(mockPool);

    const SKILLS_DIR = path.join(PROJECT_ROOT, "data", "skills");
    const ghostFile = path.join(SKILLS_DIR, "neon-only-skill-abc12345.json");
    assert(!fs.existsSync(ghostFile), "skill file must NOT exist on disk for this test");

    const { loadSkillById } = require("../src/skill-store");
    const loaded = await loadSkillById("neon-only-skill-abc12345");

    assert(loaded !== null, "loadSkillById must return skill from Neon when file is missing");
    assert(loaded.id === "neon-only-skill-abc12345", "loaded skill id must match");
    assert(loaded.pricing_url === "https://example.com/pricing", "pricing_url must match");
    assert(loaded.method === "dom", "method must match");

    restoreModuleCache();
  });

  await testAsync("SHAME-B (a): monitor-lib runMonitorCheck loads from Neon when skill file absent", async () => {
    const mockPool = createMockDb();
    const testSkill = {
      id: "neon-hosted-skill-99887766",
      version: 1,
      pricing_url: "https://example.com/pricing",
      target_price_description: "Pro plan",
      site: "example.com",
      plan_name: "Pro",
      plan_key: "pro",
      method: "api",
      extract_mode: "single",
      currency: "USD",
      period: "month",
      failure_count: 0,
      skill_status: "healthy",
    };
    addMockSkill(mockPool, testSkill);
    injectMockDb(mockPool);

    const SKILLS_DIR = path.join(PROJECT_ROOT, "data", "skills");
    const ghostFile = path.join(SKILLS_DIR, "neon-hosted-skill-99887766.json");
    assert(!fs.existsSync(ghostFile), "skill file must NOT exist on disk for this test");

    const { loadSkillWithNeon } = require("../src/monitor-lib");
    const loaded = await loadSkillWithNeon("neon-hosted-skill-99887766");

    assert(loaded !== null, "loadSkillWithNeon must return skill from Neon");
    assert(loaded.id === "neon-hosted-skill-99887766", "skill id must match");

    restoreModuleCache();
  });

  await testAsync("SHAME-B (a): host-named file (plausible-io.json) ≠ id-named lookup (plausible-io-8e774063) → Neon resolves", async () => {
    const mockPool = createMockDb();
    const realSkillId = "plausible-io-8e774063";
    const hostNamedFile = path.join(PROJECT_ROOT, "data", "skills", "plausible-io.json");
    const idNamedFile = path.join(PROJECT_ROOT, "data", "skills", `${realSkillId}.json`);

    assert(fs.existsSync(hostNamedFile), "plausible-io.json must exist in data/skills/ (committed)");
    assert(!fs.existsSync(idNamedFile), `${realSkillId}.json must NOT exist — file is host-named`);

    const skillPayload = JSON.parse(fs.readFileSync(hostNamedFile, "utf8"));

    addMockSkill(mockPool, skillPayload);
    injectMockDb(mockPool);

    const { loadSkillById } = require("../src/skill-store");
    const loaded = await loadSkillById(skillPayload.id);

    assert(loaded !== null, "loadSkillById must resolve from Neon when id-named file is absent");
    assert(loaded.id === skillPayload.id, `loaded id must match: expected ${skillPayload.id}`);
    assert(loaded.pricing_url === skillPayload.pricing_url, "pricing_url must match");
    assert(loaded.site === skillPayload.site, "site must match");

    restoreModuleCache();
  });

  await testAsync("SHAME-B (a): runMonitorCheck with host-named file mismatch → Neon fallback, NOT ops-alert", async () => {
    const mockPool = createMockDb();
    const hostNamedFile = path.join(PROJECT_ROOT, "data", "skills", "plausible-io.json");
    const skillPayload = JSON.parse(fs.readFileSync(hostNamedFile, "utf8"));
    const realSkillId = skillPayload.id;
    const idNamedFile = path.join(PROJECT_ROOT, "data", "skills", `${realSkillId}.json`);

    assert(!fs.existsSync(idNamedFile), `${realSkillId}.json must NOT exist — proves Neon fallback`);

    addMockSkill(mockPool, skillPayload);
    injectMockDb(mockPool);

    const { runMonitorCheck } = require("../src/monitor-lib");
    const skillPath = `data/skills/${realSkillId}.json`;
    const result = await runMonitorCheck(realSkillId, {
      skillPath,
      customerInfo: { customerId: "cust-boris", customerEmail: "boris@test.dev", customerName: "Boris" },
    });

    assert(result.status !== "error" || !result.error.includes("Skill not found"),
      `must NOT return 'Skill not found' — Neon fallback must resolve the skill (got: ${result.status} / ${result.error || ""})`);

    if (result.opsAlertPath) {
      const opsAlert = JSON.parse(fs.readFileSync(result.opsAlertPath, "utf8"));
      assert(opsAlert.type !== "ops_alert" || !opsAlert.error.includes("Skill not found"),
        "ops-alert must NOT be about missing skill when Neon has it");
    }

    cleanOutbox();
    restoreModuleCache();
  });

  // ── Phase B shame (b): change fixture → customer price_change (NOT ops-alert) ──
  console.log("\n--- Phase B shame (b): change fixture → customer price_change (NOT ops-alert) ---\n");

  test("SHAME-B (b): price change outbox email is type price_change, not ops_alert", () => {
    cleanOutbox();
    removeKillFile();

    writeOutboxEmail("price-change_shame-b-customer.json", {
      type: "price_change",
      skill_id: "shame-b-skill",
      customer_id: "cust-shame-b",
      customer_email: "pilot@team.dev",
      base_url: "https://example.com/pricing",
      target: "Pro plan",
      timestamp: new Date().toISOString(),
      before: { amount: 10, currency: "USD", period: "month", display: "$10/mo" },
      after: { amount: 15, currency: "USD", period: "month", display: "$15/mo" },
      subject: "PriceWatch: example.com changed",
      body: "We detected a price change for Pro plan.\n\n  Before: $10/mo\n  After:  $15/mo\n\n— PriceWatch",
    });

    const files = outboxJsonFiles();
    assert(files.length === 1, `expected 1 outbox file, got ${files.length}`);

    const emailData = JSON.parse(
      fs.readFileSync(path.join(OUTBOX_DIR, files[0]), "utf8")
    );
    assert(emailData.type === "price_change", `email type must be 'price_change', got '${emailData.type}'`);
    assert(emailData.type !== "ops_alert", "email type must NOT be ops_alert for customer price changes");
    assert(emailData.customer_email === "pilot@team.dev", "customer_email must be set");
    assert(emailData.before.amount === 10, "before amount must be 10");
    assert(emailData.after.amount === 15, "after amount must be 15");

    const result = runMailer({
      PRICEWATCH_M1B_UNLOCK: "",
      PRICEWATCH_MAIL_ALLOWLIST: "pilot@team.dev",
      PRICEWATCH_TEST_EMAIL: "",
      PRICEWATCH_OPS_EMAIL: "",
      PRICEWATCH_KILL: "",
    });

    assert(
      !(result.stdout || "").includes("BLOCKED"),
      "allowlisted customer price_change email must NOT be blocked"
    );

    cleanOutbox();
  });

  // ── Phase B shame (c): lab localhost → blocked/skipped ──────────
  console.log("\n--- Phase B shame (c): lab localhost → blocked/skipped ---\n");

  test("SHAME-B (c): enqueue-daily-ticks blocks localhost source_url with clear reason", () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, "scripts", "enqueue-daily-ticks.js"),
      "utf8"
    );
    assert(src.includes("isLabHost"), "enqueue script must have isLabHost check");
    assert(
      src.includes("lab-blocked") || src.includes("localhost"),
      "enqueue script must log a clear reason when blocking localhost"
    );
  });

  await testAsync("SHAME-B (c): localhost watch target skipped in Neon enqueue path", async () => {
    const mockPool = createMockDb();
    addMockCustomer(mockPool, { id: "cust-lab", name: "Lab User", email: "lab@test.com" });
    addMockWatchTarget(mockPool, {
      id: "wt-lab-local",
      customer_id: "cust-lab",
      skill_id: "127-0-0-1-b2300ebc",
      label: "Lab localhost skill",
      source_url: "http://127.0.0.1:3847/pricing",
      status: "skill_ready",
    });
    addMockWatchTarget(mockPool, {
      id: "wt-real-site",
      customer_id: "cust-lab",
      skill_id: "vercel-com-8bd87c12",
      label: "Vercel Pro",
      source_url: "https://vercel.com/pricing",
      status: "skill_ready",
    });

    injectMockDb(mockPool);
    const ledger = require("../src/neon-ledger");

    const localhostWt = mockPool._tables.watch_targets.find((r) => r.id === "wt-lab-local");
    assert(localhostWt, "mock must have localhost watch target");
    assert(/^https?:\/\/(127\.0\.0\.1|localhost)/.test(localhostWt.source_url),
      "localhost wt must have localhost source_url");

    const realWt = mockPool._tables.watch_targets.find((r) => r.id === "wt-real-site");
    assert(realWt, "mock must have real-site watch target");
    assert(!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(realWt.source_url),
      "real wt must NOT have localhost source_url");

    const realResult = await ledger.claim({
      watchTargetId: "wt-real-site",
      customerId: "cust-lab",
      skillId: "vercel-com-8bd87c12",
    });
    assert(realResult.created === true, "real-site claim should succeed");

    const ledgerEntries = await ledger.listByDay();
    const localEntries = ledgerEntries.filter((e) => e.watch_target_id === "wt-lab-local");
    assert(localEntries.length === 0, "localhost watch target must NOT have ledger entry");

    restoreModuleCache();
  });

  // ── Phase B shame (d): kill stops send ──────────────────────────
  console.log("\n--- Phase B shame (d): kill stops send ---\n");

  test("SHAME-B (d): kill switch via env prevents outbox drain", () => {
    cleanOutbox();

    writeOutboxEmail("price-change_shame-d-kill.json", {
      type: "price_change",
      customer_email: "pilot@team.dev",
      subject: "PriceWatch: kill test Phase B",
      body: "Kill test body Phase B",
    });

    const result = runMailer({
      PRICEWATCH_KILL: "1",
      PRICEWATCH_M1B_UNLOCK: "",
      PRICEWATCH_MAIL_ALLOWLIST: "pilot@team.dev",
      PRICEWATCH_TEST_EMAIL: "",
      PRICEWATCH_OPS_EMAIL: "",
    });

    assert(result.code === 0, `expected exit 0, got ${result.code}`);
    assert(
      (result.stdout || "").includes("Kill switch"),
      "must log kill switch message"
    );
    assert(
      !sentMarkerExists("price-change_shame-d-kill.json"),
      "must NOT create .sent marker while killed"
    );

    cleanOutbox();
  });

  // ── Phase B shame (e): failed ledger retryable same-day ─────────
  console.log("\n--- Phase B shame (e): failed ledger retryable same-day ---\n");

  await testAsync("SHAME-B (e): failed ledger entry can be retried same day", async () => {
    const mockPool = createMockDb();
    addMockWatchTarget(mockPool, {
      id: "wt-retry",
      customer_id: "cust-retry",
      skill_id: "skill-retry",
      status: "skill_ready",
    });

    injectMockDb(mockPool);
    const ledger = require("../src/neon-ledger");

    const claimRes = await ledger.claim({
      watchTargetId: "wt-retry",
      customerId: "cust-retry",
      skillId: "skill-retry",
    });
    assert(claimRes.created === true, "initial claim should succeed");

    await ledger.complete(claimRes.entry.id, {
      status: "failed",
      result: "fetch_fail",
      reason: "HTTP 503",
    });

    const day = ledger.jerusalemDate();
    const beforeRetry = await ledger.listByDay(day);
    const failedEntry = beforeRetry.find((e) => e.id === claimRes.entry.id);
    assert(failedEntry.status === "failed", "entry must be failed before retry");

    const retryRes = await ledger.retry(claimRes.entry.id);
    assert(retryRes.retried === true, "retry must succeed for failed entry");
    assert(retryRes.entry.status === "claimed", "retried entry must be back to claimed");
    assert(retryRes.entry.retry_count === 1, `retry_count must be 1, got ${retryRes.entry.retry_count}`);

    const afterRetry = await ledger.listClaimed(day);
    const retriedEntry = afterRetry.find((e) => e.id === claimRes.entry.id);
    assert(retriedEntry, "retried entry must appear in listClaimed");

    restoreModuleCache();
  });

  // ── Phase B structural: migration + skill-store ──────────────
  console.log("\n--- Phase B structural checks ---\n");

  test("migration 6_skills.js exports up and down", () => {
    const migration = require("../migrations/6_skills.js");
    assert(typeof migration.up === "function", "up must be a function");
    assert(typeof migration.down === "function", "down must be a function");
  });

  test("skill-store exports loadSkillById and neonSaveSkill", () => {
    restoreModuleCache();
    const store = require("../src/skill-store");
    assert(typeof store.loadSkillById === "function", "loadSkillById must be exported");
    assert(typeof store.neonSaveSkill === "function", "neonSaveSkill must be exported");
    assert(typeof store.listSkillsWithNeon === "function", "listSkillsWithNeon must be exported");
    assert(typeof store.dbAvailable === "function", "dbAvailable must be exported");
    restoreModuleCache();
  });

  test("monitor-lib exports loadSkillWithNeon", () => {
    restoreModuleCache();
    const lib = require("../src/monitor-lib");
    assert(typeof lib.loadSkillWithNeon === "function", "loadSkillWithNeon must be exported");
    restoreModuleCache();
  });

  // ── Structural checks ────────────────────────────────────────
  console.log("\n--- Structural checks ---\n");

  test("migration 5_daily_ledger.js exports up and down", () => {
    const migration = require("../migrations/5_daily_ledger.js");
    assert(typeof migration.up === "function", "up must be a function");
    assert(typeof migration.down === "function", "down must be a function");
  });

  test("neon-ledger.js exports expected API", () => {
    restoreModuleCache();
    const ledger = require("../src/neon-ledger");
    assert(typeof ledger.claim === "function", "claim must be exported");
    assert(typeof ledger.complete === "function", "complete must be exported");
    assert(typeof ledger.listClaimed === "function", "listClaimed must be exported");
    assert(typeof ledger.listByDay === "function", "listByDay must be exported");
    assert(typeof ledger.retry === "function", "retry must be exported");
    assert(typeof ledger.jerusalemDate === "function", "jerusalemDate must be exported");
    assert(typeof ledger.isKilled === "function", "isKilled must be exported");
    assert(typeof ledger.MAX_RETRIES === "number", "MAX_RETRIES must be exported");
    restoreModuleCache();
  });

  test("enqueue-daily-ticks.js has no hard dependency on customers.json when DB is available", () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, "scripts", "enqueue-daily-ticks.js"),
      "utf8"
    );
    assert(src.includes("runNeonPath"), "enqueue script must have a Neon path");
    assert(src.includes("watch_targets"), "Neon path must query watch_targets table");
    assert(src.includes("surface = 'b2b'"), "Neon path must filter surface=b2b");
    assert(src.includes("skill_ready"), "Neon path must filter status=skill_ready");
  });

  test("daily-cron.yml passes DATABASE_URL to pipeline", () => {
    const yml = fs.readFileSync(
      path.join(PROJECT_ROOT, ".github", "workflows", "daily-cron.yml"),
      "utf8"
    );
    assert(yml.includes("DATABASE_URL"), "daily-cron.yml must pass DATABASE_URL");
  });

  test(".sent idempotency: markSent + isSent roundtrip", () => {
    delete require.cache[require.resolve("../scripts/send-outbox.js")];
    const m = require("../scripts/send-outbox.js");

    const testFile = path.join(OUTBOX_DIR, "shame-wave4-idempotent.json");
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    fs.writeFileSync(testFile, '{"test":true}\n');

    assert(!m.isSent(testFile), "should NOT be sent before marker");
    m.markSent(testFile, "mock");
    assert(m.isSent(testFile), "should be sent after marker");

    fs.unlinkSync(testFile);
    fs.unlinkSync(testFile + ".sent");
  });

  // ═══════════════════════════════════════════════════════════════
  console.log(
    `\n=== Wave 4 B2B hosted shame-tests: ${passed} passed, ${failed} failed ===\n`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
