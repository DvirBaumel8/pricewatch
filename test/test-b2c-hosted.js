#!/usr/bin/env node
"use strict";

/**
 * Wave 5 B2C hosted shame-tests (0 LLM).
 *
 * (a) slot block at free-3+1
 * (b) empty local skills/snapshots + Neon skill/baseline → load OK
 * (c) baseline≠live → would-send allowlisted B2C price_change with CTA+disclosure (NOT ops-alert)
 * (d) kill stops send
 * (e) B2B path still green (no affiliate pollution; enqueue still claims b2b)
 *
 * No real Neon, no real SMTP/Resend, no live Render.
 * Uses an in-memory pg mock injected before requiring production modules.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
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
    users: [],
    user_packages: [],
    product_offers: [],
    daily_ledger: [],
    skills: [],
    click_log: [],
  };

  const pool = {
    _tables: tables,
    query: async (text, params) => {
      const sql = text.replace(/\s+/g, " ").trim();

      if (/^INSERT INTO user_packages/i.test(sql)) {
        const row = {
          id: params[0],
          user_id: params[1],
          package_type: params[2],
          slot_count: params[3],
          granted_via: params[4],
          active: true,
          created_at: new Date(),
        };
        tables.user_packages.push(row);
        return { rows: [row] };
      }

      if (/^SELECT id FROM user_packages WHERE user_id/i.test(sql) && /package_type = 'free'/i.test(sql)) {
        const rows = tables.user_packages.filter(
          (r) => r.user_id === params[0] && r.package_type === "free" && r.active
        );
        return { rows };
      }

      if (/^SELECT package_type, slot_count FROM user_packages/i.test(sql)) {
        const rows = tables.user_packages.filter(
          (r) => r.user_id === params[0] && r.active
        );
        return { rows };
      }

      if (/^SELECT \* FROM user_packages WHERE user_id/i.test(sql)) {
        const rows = tables.user_packages.filter(
          (r) => r.user_id === params[0] && r.active
        );
        return { rows };
      }

      if (/^SELECT COUNT\(\*\)::int AS n FROM watch_targets wt/i.test(sql) && /surface = 'b2c'/i.test(sql)) {
        const rows = tables.watch_targets.filter((r) => {
          if (r.surface !== "b2c") return false;
          const cust = tables.customers.find((c) => c.id === r.customer_id);
          return cust && cust.user_id === params[0];
        });
        return { rows: [{ n: rows.length }] };
      }

      if (/^SELECT COUNT\(\*\)::int AS n FROM watch_targets WHERE customer_id/i.test(sql)) {
        const rows = tables.watch_targets.filter((r) => r.customer_id === params[0]);
        return { rows: [{ n: rows.length }] };
      }

      if (/^INSERT INTO watch_targets/i.test(sql)) {
        const row = {
          id: params[0],
          customer_id: params[1],
          surface: params[2],
          label: params[3],
          source_url: params[4],
          target_description: params[5],
          plan_key: params[6],
          skill_id: params[7],
          product_offer_id: params[8],
          status: params[9],
          failure_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        tables.watch_targets.push(row);
        return { rows: [row] };
      }

      if (/^SELECT .* FROM watch_targets WHERE id/i.test(sql)) {
        return { rows: tables.watch_targets.filter((r) => r.id === params[0]) };
      }

      if (/^SELECT .* FROM watch_targets WHERE customer_id/i.test(sql)) {
        let rows = tables.watch_targets.filter((r) => r.customer_id === params[0]);
        if (params[1]) rows = rows.filter((r) => r.surface === params[1]);
        return { rows };
      }

      if (/^SELECT .* FROM watch_targets/i.test(sql) && /surface IN/i.test(sql) && /skill_ready/i.test(sql)) {
        const rows = tables.watch_targets.filter(
          (r) => (r.surface === "b2b" || r.surface === "b2c") && r.status === "skill_ready"
        );
        return { rows };
      }

      if (/^SELECT .* FROM watch_targets/i.test(sql) && /status = 'skill_ready'/i.test(sql)) {
        let rows = tables.watch_targets.filter((r) => r.status === "skill_ready");
        if (params[0]) rows = rows.filter((r) => r.surface === params[0]);
        return { rows };
      }

      if (/^INSERT INTO product_offers/i.test(sql)) {
        const existing = tables.product_offers.find((r) => r.id === params[0]);
        const row = {
          id: params[0],
          merchant_url: params[1],
          affiliate_url: params[2],
          affiliate_program_id: params[3],
          disclosure: params[4],
          skill_id: params[5],
          active: params[6],
          label: params[7],
          created_at: new Date(),
          updated_at: new Date(),
        };
        if (existing) {
          Object.assign(existing, row);
          return { rows: [existing] };
        }
        tables.product_offers.push(row);
        return { rows: [row] };
      }

      if (/^SELECT \* FROM product_offers WHERE id/i.test(sql)) {
        return { rows: tables.product_offers.filter((r) => r.id === params[0]) };
      }

      if (/^SELECT \* FROM product_offers WHERE active/i.test(sql)) {
        return {
          rows: tables.product_offers.filter((r) => r.active).sort((a, b) =>
            a.created_at > b.created_at ? 1 : -1
          ),
        };
      }

      if (/^SELECT \* FROM product_offers ORDER/i.test(sql)) {
        return { rows: tables.product_offers };
      }

      if (/^INSERT INTO daily_ledger/i.test(sql)) {
        const existing = tables.daily_ledger.find(
          (r) => r.watch_target_id === params[1] && r.jerusalem_day === params[4]
        );
        if (existing) return { rows: [] };
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
        return {
          rows: tables.daily_ledger.filter(
            (r) => r.watch_target_id === params[0] && r.jerusalem_day === params[1]
          ),
        };
      }

      if (/^SELECT \* FROM daily_ledger WHERE jerusalem_day/i.test(sql)) {
        return {
          rows: tables.daily_ledger.filter((r) => r.jerusalem_day === params[0]),
        };
      }

      if (/^SELECT .* FROM customers WHERE id/i.test(sql)) {
        return { rows: tables.customers.filter((r) => r.id === params[0]) };
      }

      if (/^INSERT INTO skills/i.test(sql)) {
        const existing = tables.skills.find((r) => r.id === params[0]);
        if (existing) {
          existing.payload =
            typeof params[2] === "string" ? JSON.parse(params[2]) : params[2];
          if (params[3]) {
            existing.baseline =
              typeof params[3] === "string" ? JSON.parse(params[3]) : params[3];
          }
          existing.updated_at = new Date();
          return { rows: [existing] };
        }
        const row = {
          id: params[0],
          site: params[1],
          payload: typeof params[2] === "string" ? JSON.parse(params[2]) : params[2],
          baseline: params[3]
            ? typeof params[3] === "string"
              ? JSON.parse(params[3])
              : params[3]
            : null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        tables.skills.push(row);
        return { rows: [row] };
      }

      if (/^SELECT payload FROM skills WHERE id/i.test(sql)) {
        return { rows: tables.skills.filter((r) => r.id === params[0]) };
      }

      if (/^SELECT baseline FROM skills WHERE id/i.test(sql)) {
        return {
          rows: tables.skills
            .filter((r) => r.id === params[0])
            .map((r) => ({ baseline: r.baseline })),
        };
      }

      if (/^UPDATE skills/i.test(sql) && /SET baseline/i.test(sql)) {
        const row = tables.skills.find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.baseline =
          typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        row.updated_at = new Date();
        return { rows: [{ id: row.id }] };
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
    "../src/slot-store",
    "../src/product-offer-store",
  ];
  for (const m of mods) {
    try {
      delete require.cache[require.resolve(m)];
    } catch {}
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
    "../src/slot-store",
    "../src/product-offer-store",
  ];
  for (const m of mods) {
    try {
      delete require.cache[require.resolve(m)];
    } catch {}
  }
}

function addMockCustomer(pool, opts) {
  pool._tables.customers.push({
    id: opts.id,
    name: opts.name || "Test Customer",
    email: opts.email || "test@example.com",
    user_id: opts.user_id || null,
    created_at: new Date(),
  });
}

function addMockOffer(pool, opts) {
  pool._tables.product_offers.push({
    id: opts.id,
    merchant_url: opts.merchant_url || "https://linear.app/pricing",
    affiliate_url: opts.affiliate_url || "https://aff.example.com/x?ref=pricewatch",
    affiliate_program_id: opts.affiliate_program_id || "aff-001",
    disclosure:
      opts.disclosure ||
      "We may earn a commission if you buy via this link.",
    skill_id: opts.skill_id || null,
    active: opts.active !== false,
    label: opts.label || "Test Offer",
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function addMockWatchTarget(pool, opts) {
  pool._tables.watch_targets.push({
    id: opts.id || crypto.randomBytes(6).toString("hex"),
    customer_id: opts.customer_id,
    surface: opts.surface || "b2c",
    label: opts.label || "Test Target",
    source_url: opts.source_url || "https://linear.app/pricing",
    target_description: opts.target_description || "Basic plan",
    plan_key: opts.plan_key || null,
    skill_id: opts.skill_id || null,
    product_offer_id: opts.product_offer_id || null,
    status: opts.status || "skill_ready",
    failure_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function addMockSkill(pool, skill, baseline = null) {
  pool._tables.skills.push({
    id: skill.id,
    site: skill.site || null,
    payload: skill,
    baseline:
      baseline != null
        ? baseline
        : skill.baseline != null
          ? skill.baseline
          : null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n=== Wave 5 B2C hosted shame-tests ===\n");

  // ── Catalog seed structural ───────────────────────────────────
  console.log("--- Catalog seed (structural) ---\n");

  test("SEED_OFFERS use honest public https merchant URLs (not invented localhost)", () => {
    restoreModuleCache();
    const { SEED_OFFERS } = require("../src/product-offer-store");
    assert(SEED_OFFERS.length >= 1, "at least one seed offer");
    for (const o of SEED_OFFERS) {
      assert(/^https:\/\//.test(o.merchant_url), `${o.id} merchant_url must be https`);
      assert(!/127\.0\.0\.1|localhost/.test(o.merchant_url), `${o.id} must not be localhost`);
      assert(o.disclosure && o.disclosure.length > 0, `${o.id} disclosure required`);
      assert(
        o.affiliate_url || o.affiliate_program_id,
        `${o.id} needs affiliate_url or program id stub`
      );
      assert(o.active === true, `${o.id} should be active`);
    }
    restoreModuleCache();
  });

  test("affiliateFieldsForEmail returns /r/:id CTA + disclosure_flag", () => {
    restoreModuleCache();
    const {
      affiliateFieldsForEmail,
      trackedClickPath,
      DEFAULT_DISCLOSURE,
    } = require("../src/product-offer-store");
    const fields = affiliateFieldsForEmail({
      id: "offer-linear-standard",
      disclosure: DEFAULT_DISCLOSURE,
    });
    assert(fields.affiliate_click_url === "/r/offer-linear-standard", "CTA path");
    assert(fields.disclosure_flag === true, "disclosure_flag");
    assert(
      /commission/i.test(fields.disclosure_snippet),
      "disclosure must mention commission"
    );
    assert(trackedClickPath("x") === "/r/x", "trackedClickPath helper");
    restoreModuleCache();
  });

  test("migration 7_b2c_hosted_e2e.js exports up/down", () => {
    const migration = require("../migrations/7_b2c_hosted_e2e.js");
    assert(typeof migration.up === "function", "up");
    assert(typeof migration.down === "function", "down");
  });

  // ── (a) slot block at free-3+1 ─────────────────────────────────
  console.log("\n--- (a) Slot block at free-3+1 ---\n");

  await testAsync("SHAME (a): free-3 exhausted → 4th B2C watch blocked; package stub unlocks", async () => {
    const mockPool = createMockDb();
    const userId = "user-slot-a";
    addMockCustomer(mockPool, {
      id: "cust-slot-a",
      user_id: userId,
      email: "pilot@team.dev",
    });

    injectMockDb(mockPool);
    const slotStore = require("../src/slot-store");
    const watchTargets = require("../src/watch-target-store");

    await slotStore.ensureFreePackage(userId);

    for (let i = 0; i < 3; i++) {
      const check = await slotStore.canCreateWatch(userId);
      assert(check.allowed === true, `watch ${i + 1} should be allowed (free-3)`);
      const created = await watchTargets.create({
        customer_id: "cust-slot-a",
        surface: "b2c",
        label: `Offer ${i + 1}`,
        source_url: "https://linear.app/pricing",
        target_description: `Plan ${i + 1}`,
        status: "skill_ready",
        skill_id: `skill-slot-${i}`,
      });
      assert(!created.error, `create ${i + 1} should succeed`);
    }

    const blocked = await slotStore.canCreateWatch(userId);
    assert(blocked.allowed === false, "4th watch must be blocked");
    assert(
      blocked.reason === "slots_exhausted",
      `reason should be slots_exhausted, got ${blocked.reason}`
    );
    assert(blocked.used_slots === 3, `used_slots=${blocked.used_slots}`);
    assert(blocked.total_slots === 3, `total_slots=${blocked.total_slots}`);

    await slotStore.grantPackage(userId, "pkg_1", "payment_stub");
    const unlocked = await slotStore.canCreateWatch(userId);
    assert(unlocked.allowed === true, "after pkg_1 stub, 4th watch must be allowed");
    assert(unlocked.remaining >= 1, "remaining slots after unlock");

    restoreModuleCache();
  });

  await testAsync("SHAME (a): B2B watches do not consume B2C free-3 slots", async () => {
    const mockPool = createMockDb();
    const userId = "user-slot-b2b";
    addMockCustomer(mockPool, {
      id: "cust-slot-b2b",
      user_id: userId,
      email: "pilot@team.dev",
    });

    injectMockDb(mockPool);
    const slotStore = require("../src/slot-store");
    const watchTargets = require("../src/watch-target-store");

    await slotStore.ensureFreePackage(userId);

    for (let i = 0; i < 5; i++) {
      await watchTargets.create({
        customer_id: "cust-slot-b2b",
        surface: "b2b",
        label: `Competitor ${i + 1}`,
        source_url: "https://vercel.com/pricing",
        target_description: `Pro ${i + 1}`,
        status: "skill_ready",
        skill_id: `skill-b2b-${i}`,
      });
    }

    const check = await slotStore.canCreateWatch(userId);
    assert(check.allowed === true, "B2C slots unused after B2B creates");
    assert(check.used_slots === 0, `B2C used_slots must be 0, got ${check.used_slots}`);
    assert(check.remaining === 3, `remaining must be 3, got ${check.remaining}`);

    restoreModuleCache();
  });

  // ── (b) empty local + Neon skill/baseline → load OK ───────────
  console.log("\n--- (b) Empty local skills/snapshots + Neon skill/baseline → load OK ---\n");

  await testAsync("SHAME (b): empty local skill file + Neon skill+baseline → load OK", async () => {
    const mockPool = createMockDb();
    const skillId = "b2c-neon-skill-wave5aaaa";
    const skillFile = path.join(PROJECT_ROOT, "data", "skills", `${skillId}.json`);
    const snapFile = path.join(PROJECT_ROOT, "data", "snapshots", `${skillId}.json`);
    assert(!fs.existsSync(skillFile), "skill file must be absent");
    if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile);

    const testSkill = {
      id: skillId,
      version: 1,
      pricing_url: "https://example.com/pricing",
      target_price_description: "Starter",
      site: "example.com",
      method: "api",
      extract_mode: "single",
      currency: "USD",
      period: "month",
      failure_count: 0,
      skill_status: "healthy",
    };
    addMockSkill(mockPool, testSkill, {
      price: { amount: 5, currency: "USD", period: "month" },
    });
    injectMockDb(mockPool);

    const { loadSkillById, loadBaseline } = require("../src/skill-store");
    const loaded = await loadSkillById(skillId);
    assert(loaded !== null, "must load skill from Neon");
    assert(loaded.id === skillId, "id match");

    const baseline = await loadBaseline(skillId);
    assert(baseline && baseline.price, "must load Neon baseline");
    assert(Number(baseline.price.amount) === 5, "baseline amount 5");

    restoreModuleCache();
  });

  // ── (c) baseline≠live → B2C price_change with CTA+disclosure ──
  console.log("\n--- (c) baseline≠live → allowlisted B2C price_change with CTA+disclosure ---\n");

  await testAsync("SHAME (c): B2C change email has /r/:id CTA + commission disclosure, NOT ops-alert", async () => {
    cleanOutbox();
    removeKillFile();

    const livePrice = { amount: 9, currency: "USD", period: "month" };
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(livePrice));
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = server.address().port;
    const pricingUrl = `http://127.0.0.1:${port}/pricing`;

    const skillId = "b2c-hosted-change-cccc1111";
    const snapshotFile = path.join(PROJECT_ROOT, "data", "snapshots", `${skillId}.json`);
    if (fs.existsSync(snapshotFile)) fs.unlinkSync(snapshotFile);

    const mockPool = createMockDb();
    addMockOffer(mockPool, {
      id: "offer-linear-standard",
      merchant_url: "https://linear.app/pricing",
      skill_id: skillId,
      label: "Linear — Basic",
    });
    const testSkill = {
      id: skillId,
      version: 1,
      pricing_url: pricingUrl,
      target_price_description: "Basic plan",
      site: "linear.app",
      plan_name: "Basic",
      method: "api",
      extract_mode: "single",
      currency: "USD",
      period: "month",
      failure_count: 0,
      skill_status: "healthy",
    };
    addMockSkill(mockPool, testSkill, {
      price: { amount: 1, currency: "USD", period: "month" },
    });
    injectMockDb(mockPool);

    try {
      const { runMonitorCheck } = require("../src/monitor-lib");
      assert(!fs.existsSync(snapshotFile), "local snapshot must be absent");

      const result = await runMonitorCheck(skillId, {
        customerInfo: {
          customerId: "cust-b2c-c",
          customerEmail: "pilot@team.dev",
          customerName: "Pilot",
          surface: "b2c",
          productOfferId: "offer-linear-standard",
          affiliateClickUrl: "/r/offer-linear-standard",
          disclosureSnippet:
            "We may earn a commission if you buy via this link.",
        },
      });

      assert(
        result.status === "price_changed",
        `expected price_changed, got ${result.status} / ${result.reason || result.error || ""}`
      );
      assert(result.reason !== "first_run", "must NOT soft-pass as first_run");
      assert(result.emailPath, "must write customer price_change");
      assert(fs.existsSync(result.emailPath), "email path exists");

      const email = JSON.parse(fs.readFileSync(result.emailPath, "utf8"));
      assert(email.type === "price_change", `type must be price_change, got ${email.type}`);
      assert(email.type !== "ops_alert", "must NOT be ops-alert");
      assert(email.surface === "b2c", "surface=b2c");
      assert(
        email.affiliate_click_url === "/r/offer-linear-standard",
        `CTA must be /r/:id, got ${email.affiliate_click_url}`
      );
      assert(
        email.disclosure_flag === true,
        "disclosure_flag must be true"
      );
      assert(
        /commission/i.test(email.disclosure_snippet || ""),
        "disclosure_snippet must mention commission"
      );
      assert(
        /Buy \/ see deal:\s*\/r\/offer-linear-standard/.test(email.body),
        "body must include Buy/see deal CTA with /r/:id"
      );
      assert(
        /commission/i.test(email.body),
        "body must include commission disclosure line"
      );
      assert(Number(email.before.amount) === 1, "before = Neon baseline $1");
      assert(Number(email.after.amount) === 9, "after = live $9");

      const mailer = runMailer({
        PRICEWATCH_M1B_UNLOCK: "",
        PRICEWATCH_MAIL_ALLOWLIST: "pilot@team.dev",
        PRICEWATCH_TEST_EMAIL: "",
        PRICEWATCH_OPS_EMAIL: "",
        PRICEWATCH_KILL: "",
      });
      assert(
        !(mailer.stdout || "").includes("BLOCKED"),
        "allowlisted B2C price_change must NOT be blocked"
      );
    } finally {
      server.close();
      if (fs.existsSync(snapshotFile)) fs.unlinkSync(snapshotFile);
      cleanOutbox();
      restoreModuleCache();
    }
  });

  // ── (d) kill stops send ───────────────────────────────────────
  console.log("\n--- (d) Kill stops send ---\n");

  test("SHAME (d): kill switch stops allowlisted B2C price_change send", () => {
    cleanOutbox();
    removeKillFile();

    writeOutboxEmail("price-change_wave5-d-kill.json", {
      type: "price_change",
      surface: "b2c",
      customer_email: "pilot@team.dev",
      affiliate_click_url: "/r/offer-linear-standard",
      disclosure_snippet: "We may earn a commission if you buy via this link.",
      disclosure_flag: true,
      subject: "PriceWatch: kill test B2C",
      body: "Buy / see deal: /r/offer-linear-standard\nWe may earn a commission if you buy via this link.",
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
      "must log kill switch"
    );
    assert(
      !sentMarkerExists("price-change_wave5-d-kill.json"),
      "must NOT create .sent while killed"
    );

    cleanOutbox();
  });

  test("SHAME (d): M1b remains unset (no stranger-mail unlock)", () => {
    assert(
      !process.env.PRICEWATCH_M1B_UNLOCK ||
        process.env.PRICEWATCH_M1B_UNLOCK === "",
      "PRICEWATCH_M1B_UNLOCK must be unset"
    );
  });

  // ── (e) B2B path still green ──────────────────────────────────
  console.log("\n--- (e) B2B path still green ---\n");

  test("SHAME (e): B2B writePriceChangeEmail has NO affiliate CTA / disclosure fields", () => {
    cleanOutbox();
    restoreModuleCache();
    const { writePriceChangeEmail } = require("../src/monitor-lib");
    const emailPath = writePriceChangeEmail(
      {
        id: "b2b-skill-e",
        pricing_url: "https://vercel.com/pricing",
        target_price_description: "Pro plan",
        site: "vercel.com",
      },
      { amount: 10, currency: "USD", period: "month" },
      { amount: 20, currency: "USD", period: "month" },
      {
        customerId: "cust-b2b-e",
        customerEmail: "pilot@team.dev",
        customerName: "Pilot",
        surface: "b2b",
        // Even if mistakenly passed, B2B must ignore affiliate fields:
        affiliateClickUrl: "/r/should-not-appear",
        disclosureSnippet: "We may earn a commission",
        productOfferId: "offer-should-not-appear",
      }
    );
    const email = JSON.parse(fs.readFileSync(emailPath, "utf8"));
    assert(email.type === "price_change", "B2B still writes price_change");
    assert(!email.affiliate_click_url, "B2B must not set affiliate_click_url");
    assert(!email.disclosure_snippet, "B2B must not set disclosure_snippet");
    assert(!email.disclosure_flag, "B2B must not set disclosure_flag");
    assert(
      !/Buy \/ see deal/.test(email.body),
      "B2B body must not include Buy/see deal CTA"
    );
    assert(
      !/commission/i.test(email.body),
      "B2B body must not include commission disclosure"
    );
    cleanOutbox();
    restoreModuleCache();
  });

  test("SHAME (e): enqueue Neon path still includes b2b skill_ready watches", () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, "scripts", "enqueue-daily-ticks.js"),
      "utf8"
    );
    assert(src.includes("runNeonPath"), "must have Neon path");
    assert(src.includes("watch_targets"), "must query watch_targets");
    assert(
      src.includes("surface IN ('b2b', 'b2c')") || src.includes("'b2b'"),
      "must still enqueue b2b"
    );
    assert(src.includes("skill_ready"), "must filter skill_ready");
    assert(src.includes("isLabHost"), "must still block lab hosts");
  });

  await testAsync("SHAME (e): claim still works for surface=b2b skill_ready", async () => {
    const mockPool = createMockDb();
    addMockCustomer(mockPool, { id: "cust-e-b2b", email: "pilot@team.dev" });
    addMockWatchTarget(mockPool, {
      id: "wt-e-b2b",
      customer_id: "cust-e-b2b",
      surface: "b2b",
      skill_id: "skill-e-b2b",
      status: "skill_ready",
      source_url: "https://vercel.com/pricing",
    });
    injectMockDb(mockPool);
    const ledger = require("../src/neon-ledger");
    const result = await ledger.claim({
      watchTargetId: "wt-e-b2b",
      customerId: "cust-e-b2b",
      skillId: "skill-e-b2b",
    });
    assert(result.created === true, "B2B claim must succeed");
    restoreModuleCache();
  });

  test("SHAME (e): soft-cap 50 still exported; FREE_SLOTS=3", () => {
    restoreModuleCache();
    const slotStore = require("../src/slot-store");
    assert(slotStore.FREE_SLOTS === 3, "FREE_SLOTS=3");
    assert(slotStore.UNLIMITED_SOFT_CAP === 50, "soft-cap 50");
    restoreModuleCache();
  });

  // ── Structural: Service A routes ──────────────────────────────
  console.log("\n--- Structural: Service A B2C routes ---\n");

  test("Service A exposes product-offers list/create/seed + /r/:id + slots", () => {
    const { matchRoute } = require("../src/service-a");
    assert(matchRoute("GET", "/product-offers").handler === "listProductOffers");
    assert(matchRoute("POST", "/product-offers").handler === "createProductOffer");
    assert(matchRoute("POST", "/product-offers/seed").handler === "seedProductOffers");
    assert(matchRoute("GET", "/r/offer-x").handler === "affiliateRedirect");
    assert(matchRoute("GET", "/b2c/slots").handler === "b2cSlots");
    assert(matchRoute("POST", "/b2c/payment-stub").handler === "b2cPaymentStub");
  });

  // ═══════════════════════════════════════════════════════════════
  console.log(
    `\n=== Wave 5 B2C hosted shame-tests: ${passed} passed, ${failed} failed ===\n`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
