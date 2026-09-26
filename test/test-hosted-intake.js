#!/usr/bin/env node
"use strict";

/**
 * Wave 6 hosted intake shame-tests (0 LLM).
 *
 * (a) missing Google code → clear structured fail (not opaque 500)
 * (b) B2B confirm path creates watch+skill+baseline when Neon schema stub
 * (c) B2C create blocked at free-3+1
 * (d) Wave 4/5 change-mail shame still wired in npm test
 * (e) AUTH_STUB is not the only host path — real mode requires code
 *
 * Offline / CI-safe: in-memory pg mock; no real Neon / Google / Render.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const PROJECT_ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
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

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null,
          });
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

// ── Mock Neon ────────────────────────────────────────────────────

function createMockDb() {
  const tables = {
    watch_targets: [],
    customers: [],
    skills: [],
    user_packages: [],
    product_offers: [],
    users: [],
  };

  const pool = {
    _tables: tables,
    query: async (text, params) => {
      const sql = text.replace(/\s+/g, " ").trim();

      if (/^INSERT INTO customers/i.test(sql)) {
        const existing = tables.customers.find((r) => r.id === params[0]);
        const row = {
          id: params[0],
          name: params[1],
          email: params[2],
          user_id: params[3],
          created_at: new Date(),
        };
        if (existing) {
          Object.assign(existing, row);
          return { rows: [existing] };
        }
        tables.customers.push(row);
        return { rows: [row] };
      }

      if (/^SELECT \* FROM customers WHERE id/i.test(sql)) {
        return { rows: tables.customers.filter((r) => r.id === params[0]) };
      }

      if (/^SELECT COUNT\(\*\)::int AS n FROM watch_targets WHERE customer_id/i.test(sql)) {
        const rows = tables.watch_targets.filter((r) => r.customer_id === params[0]);
        return { rows: [{ n: rows.length }] };
      }

      if (/^SELECT COUNT\(\*\)::int AS n FROM watch_targets wt/i.test(sql) && /surface = 'b2c'/i.test(sql)) {
        const rows = tables.watch_targets.filter((r) => {
          if (r.surface !== "b2c") return false;
          const cust = tables.customers.find((c) => c.id === r.customer_id);
          return cust && cust.user_id === params[0];
        });
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
          payload:
            typeof params[2] === "string" ? JSON.parse(params[2]) : params[2],
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
        return {
          rows: tables.skills
            .filter((r) => r.id === params[0])
            .map((r) => ({ payload: r.payload })),
        };
      }

      if (/^SELECT baseline FROM skills WHERE id/i.test(sql)) {
        return {
          rows: tables.skills
            .filter((r) => r.id === params[0])
            .map((r) => ({ baseline: r.baseline })),
        };
      }

      if (/^SELECT payload FROM skills ORDER/i.test(sql)) {
        return { rows: tables.skills.map((r) => ({ payload: r.payload })) };
      }

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
        return {
          rows: tables.user_packages.filter(
            (r) =>
              r.user_id === params[0] &&
              r.package_type === "free" &&
              r.active
          ),
        };
      }

      if (/^SELECT package_type, slot_count FROM user_packages/i.test(sql)) {
        return {
          rows: tables.user_packages.filter(
            (r) => r.user_id === params[0] && r.active
          ),
        };
      }

      if (/^SELECT .* FROM user_packages WHERE user_id/i.test(sql)) {
        return {
          rows: tables.user_packages.filter(
            (r) => r.user_id === params[0] && r.active
          ),
        };
      }

      if (/^SELECT \* FROM product_offers WHERE id/i.test(sql)) {
        return { rows: tables.product_offers.filter((r) => r.id === params[0]) };
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
    "../src/intake",
    "../src/service-a",
    "../src/auth",
    "../src/user-store",
  ];
  for (const m of mods) {
    try {
      delete require.cache[require.resolve(m)];
    } catch {
      /* ignore */
    }
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
    "../src/intake",
    "../src/service-a",
    "../src/auth",
    "../src/user-store",
  ];
  for (const m of mods) {
    try {
      delete require.cache[require.resolve(m)];
    } catch {
      /* ignore */
    }
  }
}

function loadAuthRealMode() {
  const prevStub = process.env.AUTH_STUB;
  const prevJwt = process.env.JWT_SECRET;
  delete process.env.AUTH_STUB;
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "wave6-test-jwt-secret-not-for-prod";
  delete require.cache[require.resolve("../src/auth")];
  const auth = require("../src/auth");
  return {
    auth,
    restore() {
      if (prevStub === undefined) delete process.env.AUTH_STUB;
      else process.env.AUTH_STUB = prevStub;
      if (prevJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevJwt;
      delete require.cache[require.resolve("../src/auth")];
    },
  };
}

async function main() {
  console.log("\n=== Wave 6 hosted intake shame-tests ===\n");

  // ── (a) missing Google code → clear fail ───────────────────────
  console.log("--- (a) Missing Google code → clear structured fail ---\n");

  await testAsync("SHAME (a): real mode login without code → 400 google_code_required", async () => {
    const { auth, restore } = loadAuthRealMode();
    try {
      assert(auth.isStub() === false, "AUTH_STUB must be off for real mode");

      // Direct module contract
      let threw = false;
      try {
        await auth.login({});
      } catch (e) {
        threw = true;
        assert(
          /authorization code is required/i.test(e.message),
          `unexpected message: ${e.message}`
        );
      }
      assert(threw, "auth.login must throw when code missing");

      // HTTP structured JSON (not opaque 500)
      delete require.cache[require.resolve("../src/service-a")];
      const { handleRequest } = require("../src/service-a");
      const server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      try {
        const res = await httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/auth/login",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          { email: "nobody@example.com" }
        );
        assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(
          res.body && res.body.error === "google_code_required",
          `error=${res.body && res.body.error}`
        );
        assert(
          res.body.message && /authorization code/i.test(res.body.message),
          "message must mention authorization code"
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      restore();
      restoreModuleCache();
    }
  });

  // ── (e) AUTH_STUB not the only host path ───────────────────────
  console.log("\n--- (e) AUTH_STUB not the only host path ---\n");

  await testAsync("SHAME (e): real mode requires code; stub is not the host path", async () => {
    const { auth, restore } = loadAuthRealMode();
    try {
      assert(auth.isStub() === false, "real mode isStub() === false");
      let threw = false;
      try {
        await auth.login({ google_subject: "x", email: "y@z.com" });
      } catch (e) {
        threw = true;
        assert(
          /authorization code is required/i.test(e.message),
          `stub-shaped body must still require code in real mode: ${e.message}`
        );
      }
      assert(threw, "real mode must reject stub-shaped body without code");

      const docs = fs.readFileSync(
        path.join(PROJECT_ROOT, "docs", "f5-auth.md"),
        "utf8"
      );
      assert(/GOOGLE_CLIENT_ID/.test(docs), "docs name GOOGLE_CLIENT_ID");
      assert(/GOOGLE_CLIENT_SECRET/.test(docs), "docs name GOOGLE_CLIENT_SECRET");
      assert(/GOOGLE_REDIRECT_URI/.test(docs), "docs name GOOGLE_REDIRECT_URI");
      assert(/JWT_SECRET/.test(docs), "docs name JWT_SECRET");
      assert(
        /AUTH_STUB must stay unset|AUTH_STUB.*off on production|do \*\*not\*\* set `AUTH_STUB/i.test(
          docs
        ),
        "docs must forbid AUTH_STUB on prod"
      );
      assert(/Authorized redirect URIs|redirect URI/i.test(docs), "docs cover redirect URI steps");
    } finally {
      restore();
      restoreModuleCache();
    }
  });

  // ── (b) B2B confirm → watch + skill + baseline (Neon stub) ─────
  console.log("\n--- (b) B2B confirm creates watch+skill+baseline (Neon stub) ---\n");

  await testAsync("SHAME (b): saveSkill awaits Neon write (not fire-and-forget)", async () => {
    const mockPool = createMockDb();
    let insertResolved = false;
    const origQuery = mockPool.query.bind(mockPool);
    mockPool.query = async (text, params) => {
      const result = await origQuery(text, params);
      if (/^INSERT INTO skills/i.test(text.replace(/\s+/g, " ").trim())) {
        // Simulate network latency — awaiting saveSkill must wait for this.
        await new Promise((r) => setTimeout(r, 30));
        insertResolved = true;
      }
      return result;
    };
    injectMockDb(mockPool);

    const skillStore = require("../src/skill-store");
    const skillFile = path.join(PROJECT_ROOT, "data", "skills", "wave6-intake-test-example.json");
    if (fs.existsSync(skillFile)) fs.unlinkSync(skillFile);

    try {
      const skillPath = await skillStore.saveSkill({
        url: "https://wave6-intake-test.example/pricing",
        target: "business",
        site: "wave6-intake-test.example",
        planName: "Business",
        planKey: "business",
        method: "plans",
        extract_mode: "plans",
        step: "step2-http-dom",
        price: 19,
        currency: "USD",
        period: "month",
        baseline: [
          {
            plan: "Business",
            plan_key: "business",
            price: 19,
            currency: "USD",
            billing: "month",
            selected: true,
          },
        ],
      });

      assert(insertResolved, "Neon INSERT must complete before saveSkill returns");
      assert(typeof skillPath === "string" && skillPath.length > 0, "file path returned");
      assert(mockPool._tables.skills.length === 1, "skills row present");
      const row = mockPool._tables.skills[0];
      assert(row.payload && row.payload.id, "payload present");
      assert(row.baseline && Array.isArray(row.baseline), "baseline present on Neon row");
      assert(row.baseline[0].plan_key === "business", "baseline plan_key");
    } finally {
      if (fs.existsSync(skillFile)) fs.unlinkSync(skillFile);
      restoreModuleCache();
    }
  });

  await testAsync("SHAME (b): intake.confirm with Neon stub → skill_ready + skill + baseline", async () => {
    const mockPool = createMockDb();
    injectMockDb(mockPool);

    const customers = require("../src/customer-store");
    const intake = require("../src/intake");
    const skillStore = require("../src/skill-store");

    const cust = await customers.createCustomer({
      name: "Wave6 B2B Pilot",
      email: "pilot@example.com",
      user_id: "user-w6-b2b",
    });

    const labUrl = "http://127.0.0.1/pricing";
    const labSkillFile = path.join(PROJECT_ROOT, "data", "skills", "lab-multiplan.json");
    const labHostSkillFile = path.join(PROJECT_ROOT, "data", "skills", "127-0-0-1.json");
    const snapshotFile = path.join(
      PROJECT_ROOT,
      "data",
      "snapshots",
      "ladder",
      "lab-multiplan.json"
    );
    for (const f of [labSkillFile, labHostSkillFile, snapshotFile]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    try {
      const previewResult = {
        candidates: [
          {
            plan_key: "pro",
            name: "Pro",
            price: 10,
            currency: "USD",
            period: "month",
          },
          {
            plan_key: "business",
            name: "Business",
            price: 19,
            currency: "USD",
            period: "month",
          },
        ],
        url: labUrl,
        site: "lab-multiplan",
        method: "plans",
        tokens: 0,
      };

      const result = await intake.confirm(
        labUrl,
        [{ plan_key: "pro" }],
        "user-w6-b2b",
        cust.id,
        previewResult
      );

      assert(!result.error, `confirm error: ${result.error}`);
      assert(result.watch_targets && result.watch_targets.length === 1, "one watch");
      const wt = result.watch_targets[0];
      assert(wt.surface === "b2b", `surface=${wt.surface}`);
      assert(wt.status === "skill_ready", `status=${wt.status}`);
      assert(wt.skill_id, "skill_id set");
      assert(wt.plan_key === "pro", `plan_key=${wt.plan_key}`);

      assert(mockPool._tables.skills.length >= 1, "Neon skills row written");
      const skillRow = mockPool._tables.skills.find((r) => r.id === wt.skill_id);
      assert(skillRow, "skill row id matches watch skill_id");
      assert(skillRow.payload, "skill payload");
      assert(skillRow.baseline, "skill baseline on Neon");

      const loaded = await skillStore.loadSkillById(wt.skill_id);
      assert(loaded && loaded.id === wt.skill_id, "loadSkillById from Neon");
      const baseline = await skillStore.loadBaseline(wt.skill_id);
      assert(baseline, "loadBaseline from Neon");
    } finally {
      for (const f of [labSkillFile, labHostSkillFile, snapshotFile]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      restoreModuleCache();
    }
  });

  // ── (c) B2C free-3+1 blocked ───────────────────────────────────
  console.log("\n--- (c) B2C create blocked at free-3+1 ---\n");

  await testAsync("SHAME (c): free-3 exhausted → 4th B2C watch blocked", async () => {
    const mockPool = createMockDb();
    injectMockDb(mockPool);

    const slotStore = require("../src/slot-store");
    const { createWatchTargetInternal } = require("../src/service-a");
    const skillStore = require("../src/skill-store");

    const userId = "user-w6-slots";
    await slotStore.ensureFreePackage(userId);

    mockPool._tables.customers.push({
      id: "cust-slots",
      name: "Slots Cust",
      email: "slots@example.com",
      user_id: userId,
      created_at: new Date(),
    });

    // Seed a catalog offer pointing at a committed skill
    const seedSkillId = "linear-app-ee93dab8";
    mockPool._tables.product_offers.push({
      id: "offer-linear-standard",
      merchant_url: "https://linear.app/pricing",
      affiliate_url: "https://aff.example.com/linear?ref=pricewatch",
      affiliate_program_id: "linear-partner-002",
      disclosure: "We may earn a commission if you buy via this link.",
      skill_id: seedSkillId,
      active: true,
      label: "Linear — Basic",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const reqUser = { id: userId, email: "slots@example.com" };

    for (let i = 0; i < 3; i++) {
      const check = await slotStore.canCreateWatch(userId);
      assert(check.allowed === true, `watch ${i + 1} should be allowed`);
      // Directly plant watches to consume slots (same as Wave 5 shame)
      mockPool._tables.watch_targets.push({
        id: crypto.randomBytes(4).toString("hex"),
        customer_id: "cust-slots",
        surface: "b2c",
        label: `Watch ${i + 1}`,
        source_url: "https://linear.app/pricing",
        target_description: "Basic",
        plan_key: null,
        skill_id: seedSkillId,
        product_offer_id: "offer-linear-standard",
        status: "skill_ready",
        failure_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    const blocked = await slotStore.canCreateWatch(userId);
    assert(blocked.allowed === false, "4th must be blocked");
    assert(blocked.used_slots === 3, `used_slots=${blocked.used_slots}`);

    const createRes = await createWatchTargetInternal(
      "cust-slots",
      {
        surface: "b2c",
        product_offer_id: "offer-linear-standard",
      },
      reqUser
    );
    assert(createRes.status === 403, `expected 403, got ${createRes.status}`);
    assert(
      createRes.body.error === "b2c_slots_exhausted",
      `error=${createRes.body.error}`
    );

    // Positive path: catalog create is skill_ready + Neon skill when slots free
    restoreModuleCache();
    const mockPool2 = createMockDb();
    injectMockDb(mockPool2);
    const slotStore2 = require("../src/slot-store");
    const { createWatchTargetInternal: create2 } = require("../src/service-a");
    const skillStore2 = require("../src/skill-store");

    await slotStore2.ensureFreePackage("user-w6-catalog");
    mockPool2._tables.customers.push({
      id: "cust-cat",
      name: "Catalog Cust",
      email: "cat@example.com",
      user_id: "user-w6-catalog",
      created_at: new Date(),
    });
    mockPool2._tables.product_offers.push({
      id: "offer-linear-standard",
      merchant_url: "https://linear.app/pricing",
      affiliate_url: "https://aff.example.com/linear?ref=pricewatch",
      affiliate_program_id: "linear-partner-002",
      disclosure: "We may earn a commission if you buy via this link.",
      skill_id: seedSkillId,
      active: true,
      label: "Linear — Basic",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const ok = await create2(
      "cust-cat",
      { surface: "b2c", product_offer_id: "offer-linear-standard" },
      { id: "user-w6-catalog", email: "cat@example.com" }
    );
    assert(ok.status === 201, `expected 201, got ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert(ok.body.watch_target.status === "skill_ready", "catalog create → skill_ready");
    assert(ok.body.watch_target.skill_id === seedSkillId, "skill_id from offer");
    assert(ok.body.watch_target.surface === "b2c", "surface b2c");
    assert(mockPool2._tables.skills.length >= 1, "Neon skill written on catalog create");
    const neonSkill = mockPool2._tables.skills.find((r) => r.id === seedSkillId);
    assert(neonSkill, "skill id in Neon");
    assert(neonSkill.baseline && neonSkill.baseline.price, "baseline with price");
    const bl = await skillStore2.loadBaseline(seedSkillId);
    assert(bl && bl.price, "loadBaseline works after catalog create");

    restoreModuleCache();
  });

  // ── (d) Wave 4/5 change-mail shame still wired ─────────────────
  console.log("\n--- (d) Wave 4/5 change-mail shame still green (wired) ---\n");

  test("SHAME (d): package.json test script still runs Wave 4/5 hosted suites", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
    );
    const script = pkg.scripts && pkg.scripts.test;
    assert(script, "npm test script exists");
    assert(/test-b2b-hosted\.js/.test(script), "Wave 4 B2B hosted in npm test");
    assert(/test-b2c-hosted\.js/.test(script), "Wave 5 B2C hosted in npm test");
    assert(
      fs.existsSync(path.join(PROJECT_ROOT, "test", "test-b2b-hosted.js")),
      "test-b2b-hosted.js present"
    );
    assert(
      fs.existsSync(path.join(PROJECT_ROOT, "test", "test-b2c-hosted.js")),
      "test-b2c-hosted.js present"
    );
  });

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
