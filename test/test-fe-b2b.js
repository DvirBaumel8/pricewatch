#!/usr/bin/env node
"use strict";

/**
 * Wave 7 Thin FE-B2B shame-tests (0 LLM).
 *
 * (a) missing auth → clear error (UI contract + API)
 * (b) preview→confirm happy path against stub/lab (in-memory Neon mock)
 * (c) Wave 4/5/6 API shame still wired in npm test
 * (d) no secrets in git
 *
 * Hard FAIL guards: FE server must not import intake/plan-ladder;
 * UI must not invent watches client-side only; AUTH_STUB labeled test-only.
 *
 * Offline / CI-safe. AUTH_STUB=1 for local/shame path.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const FE_HTML = path.join(PROJECT_ROOT, "public", "fe-b2b", "index.html");
const FE_SERVER = path.join(PROJECT_ROOT, "scripts", "fe-b2b-server.js");
const PKG = path.join(PROJECT_ROOT, "package.json");
const LAB_HTML = fs.readFileSync(
  path.join(__dirname, "fixtures", "lab-multiplan.html"),
  "utf8"
);

process.env.AUTH_STUB = "1";
// JWT_SECRET: rely on AUTH_STUB default in src/auth.js (test-only; never set a literal secret here).

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
            raw: data,
            headers: res.headers,
          });
        } catch {
          resolve({
            status: res.statusCode,
            body: data,
            raw: data,
            headers: res.headers,
          });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Mock Neon (users + customers + watches + skills) ─────────────

function createMockDb() {
  const tables = {
    watch_targets: [],
    customers: [],
    skills: [],
    user_packages: [],
    product_offers: [],
    users: [],
    email_verify_tokens: [],
  };

  const pool = {
    _tables: tables,
    query: async (text, params) => {
      const sql = text.replace(/\s+/g, " ").trim();

      if (/^SELECT \* FROM users WHERE google_subject/i.test(sql)) {
        return {
          rows: tables.users.filter((r) => r.google_subject === params[0]),
        };
      }
      if (/^SELECT \* FROM users WHERE id/i.test(sql)) {
        return { rows: tables.users.filter((r) => r.id === params[0]) };
      }
      if (/^INSERT INTO users/i.test(sql)) {
        const row = {
          id: params[0],
          google_subject: params[1],
          email: params[2],
          notify_email: params[2],
          notify_verified_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        };
        tables.users.push(row);
        return { rows: [row] };
      }
      if (/^UPDATE users SET email/i.test(sql)) {
        const user = tables.users.find((r) => r.id === params[1]);
        if (user) {
          user.email = params[0];
          user.updated_at = new Date();
          return { rows: [user] };
        }
        return { rows: [] };
      }
      if (/^UPDATE users/i.test(sql) && /notify_email/i.test(sql)) {
        const user = tables.users.find((r) => r.id === params[1]);
        if (user) {
          user.notify_email = params[0];
          user.updated_at = new Date();
          if (/notify_verified_at = now\(\)/i.test(sql)) {
            user.notify_verified_at = new Date();
          } else if (/notify_verified_at = NULL/i.test(sql)) {
            user.notify_verified_at = null;
          }
          return { rows: [user] };
        }
        return { rows: [] };
      }

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
      if (/^SELECT id FROM customers WHERE id/i.test(sql)) {
        return {
          rows: tables.customers
            .filter((r) => r.id === params[0])
            .map((r) => ({ id: r.id })),
        };
      }
      if (/^SELECT \* FROM customers ORDER BY/i.test(sql)) {
        return { rows: tables.customers.slice() };
      }

      if (/^SELECT COUNT\(\*\)::int AS n FROM watch_targets WHERE customer_id/i.test(sql)) {
        const rows = tables.watch_targets.filter((r) => r.customer_id === params[0]);
        return { rows: [{ n: rows.length }] };
      }
      if (
        /^SELECT COUNT\(\*\)::int AS n FROM watch_targets wt/i.test(sql) &&
        /surface = 'b2c'/i.test(sql)
      ) {
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
      if (/^SELECT id FROM user_packages WHERE user_id/i.test(sql)) {
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
  clearDependentCaches();
  return mockDb;
}

function clearDependentCaches() {
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

async function main() {
  console.log("\n=== Wave 7 Thin FE-B2B shame-tests ===\n");

  // ── Shell presence / hard FAIL guards ──────────────────────────
  console.log("--- Shell + hard-FAIL guards ---\n");

  await test("public/fe-b2b/index.html exists", () => {
    assert(fs.existsSync(FE_HTML), "missing public/fe-b2b/index.html");
  });

  await test("scripts/fe-b2b-server.js exists", () => {
    assert(fs.existsSync(FE_SERVER), "missing scripts/fe-b2b-server.js");
  });

  await test("npm script fe-b2b is wired", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
    assert(pkg.scripts && pkg.scripts["fe-b2b"], "package.json missing fe-b2b script");
    assert(/fe-b2b-server/.test(pkg.scripts["fe-b2b"]), "fe-b2b script should run fe-b2b-server");
  });

  await test("FE server does NOT import intake / plan-ladder (no second backend)", () => {
    const src = fs.readFileSync(FE_SERVER, "utf8");
    assert(!/require\(["'].*intake/.test(src), "must not require intake");
    assert(!/require\(["'].*plan-ladder/.test(src), "must not require plan-ladder");
    assert(!/require\(["'].*customer-store/.test(src), "must not require customer-store");
    assert(!/require\(["'].*watch-target/.test(src), "must not require watch-target");
    assert(/SERVICE_A_URL|proxy/i.test(src), "should proxy / document SERVICE_A_URL");
  });

  await test("FE HTML talks to Service A routes (not client-invented watches)", () => {
    const html = fs.readFileSync(FE_HTML, "utf8");
    assert(/\/auth\/login/.test(html), "must call /auth/login");
    assert(/\/b2b\/intake\/preview/.test(html), "must call preview");
    assert(/\/b2b\/intake\/confirm/.test(html), "must call confirm");
    assert(/\/customers/.test(html), "must use customers API");
    assert(
      /watches are not invented|not invented in the browser|Server owns allowlist/i.test(html),
      "must document server-owned watches"
    );
  });

  await test("FE HTML fail-closed for google_code_required + AUTH_STUB test-only", () => {
    const html = fs.readFileSync(FE_HTML, "utf8");
    assert(/google_code_required/.test(html), "must surface google_code_required");
    assert(/AUTH_STUB/.test(html), "must mention AUTH_STUB");
    assert(/test-only|TEST-ONLY|test \/ local/i.test(html), "stub labeled test-only");
    assert(/PARKED/i.test(html), "live Google noted as PARKED");
    assert(
      /will not pretend Google succeeded/i.test(html),
      "must not pretend Google succeeded without code"
    );
  });

  await test("docs/fe-b2b.md documents Service A + stub test-only", () => {
    const docs = path.join(PROJECT_ROOT, "docs", "fe-b2b.md");
    assert(fs.existsSync(docs), "docs/fe-b2b.md missing");
    const text = fs.readFileSync(docs, "utf8");
    assert(/SERVICE_A_URL|service-a/i.test(text), "docs how to run with Service A");
    assert(/AUTH_STUB/i.test(text), "docs AUTH_STUB");
    assert(/test-only|Never.*prod|never prod/i.test(text), "stub not prod");
    assert(/PARKED|Phase B/i.test(text), "OAuth parked noted");
  });

  // ── (a) missing auth → clear error ─────────────────────────────
  console.log("\n--- (a) Missing auth → clear error ---\n");

  restoreModuleCache();
  process.env.AUTH_STUB = "1";
  const { handleRequest: handleA } = require("../src/service-a");
  const apiA = http.createServer((req, res) => {
    Promise.resolve(handleA(req, res)).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
  });
  await new Promise((r) => apiA.listen(0, "127.0.0.1", r));
  const portA = apiA.address().port;

  try {
    await test("SHAME (a): POST /b2b/intake/confirm without auth → 401", async () => {
      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: portA,
          path: "/b2b/intake/confirm",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        {
          url: "http://127.0.0.1/pricing",
          selected: [{ plan_key: "pro" }],
          customer_id: "x",
        }
      );
      assert(res.status === 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(
        /auth|Authentication required/i.test(JSON.stringify(res.body || {})),
        "clear auth error"
      );
    });

    await test("SHAME (a): FE UI surfaces Authentication required / google_code_required", () => {
      const html = fs.readFileSync(FE_HTML, "utf8");
      assert(/Authentication required/i.test(html), "UI mentions Authentication required");
      assert(/google_code_required/.test(html), "UI mentions google_code_required");
      assert(
        /sign in first|Sign in before confirm|sign in before/i.test(html),
        "UI blocks confirm without auth"
      );
    });

    await test("SHAME (a): real-mode login without code → google_code_required", async () => {
      const prevStub = process.env.AUTH_STUB;
      delete process.env.AUTH_STUB;
      delete require.cache[require.resolve("../src/auth")];
      try {
        const auth = require("../src/auth");
        assert(auth.isStub() === false, "real mode");
        let threw = false;
        try {
          await auth.login({});
        } catch (e) {
          threw = true;
          assert(/authorization code/i.test(e.message), e.message);
        }
        assert(threw, "must throw without code");
      } finally {
        if (prevStub === undefined) delete process.env.AUTH_STUB;
        else process.env.AUTH_STUB = prevStub;
        delete require.cache[require.resolve("../src/auth")];
      }
    });
  } finally {
    await new Promise((r) => apiA.close(r));
    restoreModuleCache();
  }

  // ── (b) preview → confirm happy path ───────────────────────────
  console.log("\n--- (b) Preview → confirm happy path (stub + lab) ---\n");

  process.env.AUTH_STUB = "1";
  const mockPool = createMockDb();
  injectMockDb(mockPool);

  const labServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/pricing") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LAB_HTML);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  await new Promise((r) => labServer.listen(0, "127.0.0.1", r));
  const labPort = labServer.address().port;
  const labUrl = `http://127.0.0.1:${labPort}/pricing`;

  const serviceA = require("../src/service-a");
  const apiServer = http.createServer((req, res) => {
    Promise.resolve(serviceA.handleRequest(req, res)).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
  });
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  const apiPort = apiServer.address().port;

  const { isServiceAPath } = require("../scripts/fe-b2b-server.js");
  const feStatic = path.join(PROJECT_ROOT, "public", "fe-b2b");
  const feServer = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (isServiceAPath(u.pathname)) {
      const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` };
      const up = http.request(
        {
          hostname: "127.0.0.1",
          port: apiPort,
          path: u.pathname + u.search,
          method: req.method,
          headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(res);
        }
      );
      up.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "service_a_unreachable", message: err.message })
        );
      });
      req.pipe(up);
      return;
    }
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      const body = fs.readFileSync(path.join(feStatic, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  await new Promise((r) => feServer.listen(0, "127.0.0.1", r));
  const fePort = feServer.address().port;

  const labSkillFile = path.join(PROJECT_ROOT, "data", "skills", "lab-multiplan.json");
  const labHostSkillFile = path.join(PROJECT_ROOT, "data", "skills", "127-0-0-1.json");
  const snapshotFile = path.join(
    PROJECT_ROOT,
    "data",
    "snapshots",
    "ladder",
    "lab-multiplan.json"
  );

  try {
    await test("SHAME (b): FE serves index.html", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: fePort,
        path: "/",
        method: "GET",
      });
      assert(res.status === 200, `status=${res.status}`);
      assert(/PriceWatch/i.test(res.raw || ""), "HTML body");
      assert(/B2B/i.test(res.raw || ""), "B2B marker");
    });

    await test("SHAME (b): FE proxy health → auth_mode stub", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: fePort,
        path: "/health",
        method: "GET",
      });
      assert(res.status === 200, `status=${res.status}`);
      assert(
        res.body && res.body.auth_mode === "stub",
        `auth_mode=${res.body && res.body.auth_mode}`
      );
    });

    let token;
    let customerId;

    await test("SHAME (b): stub login via FE proxy → token", async () => {
      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: "/auth/login",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        { google_subject: "fe-b2b-shame", email: "fe-b2b-pilot@example.com" }
      );
      assert(res.status === 200, `status=${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.token, "token");
      assert(
        res.body.user && res.body.user.email === "fe-b2b-pilot@example.com",
        "user"
      );
      token = res.body.token;
    });

    await test("SHAME (b): create customer via FE proxy", async () => {
      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: "/customers",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
        },
        { name: "FE-B2B Pilot", email: "fe-b2b-pilot@example.com" }
      );
      assert(
        res.status === 201 || res.status === 200,
        `status=${res.status}: ${JSON.stringify(res.body)}`
      );
      assert(res.body && res.body.id, "customer id");
      customerId = res.body.id;
    });

    await test("SHAME (b): preview → confirm happy path via FE proxy", async () => {
      for (const f of [labSkillFile, labHostSkillFile, snapshotFile]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }

      const preview = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: "/b2b/intake/preview",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        { url: labUrl, intent_text: "Pro" }
      );
      assert(
        preview.status === 200,
        `preview status=${preview.status}: ${JSON.stringify(preview.body)}`
      );
      assert(
        preview.body.candidates && preview.body.candidates.length >= 1,
        "candidates"
      );
      const planKey = preview.body.candidates[0].plan_key;
      assert(planKey, "plan_key");

      const confirm = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: "/b2b/intake/confirm",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
        },
        {
          url: preview.body.url || labUrl,
          selected: [{ plan_key: planKey }],
          customer_id: customerId,
        }
      );
      assert(
        confirm.status === 201,
        `confirm status=${confirm.status}: ${JSON.stringify(confirm.body)}`
      );
      assert(
        confirm.body.watch_targets && confirm.body.watch_targets.length >= 1,
        "watch_targets created"
      );
      assert(confirm.body.first_learn === true, "first_learn");
    });

    await test("SHAME (b): confirm without token via FE proxy → 401 clear error", async () => {
      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: "/b2b/intake/confirm",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        {
          url: labUrl,
          selected: [{ plan_key: "pro" }],
          customer_id: customerId || "x",
        }
      );
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });
  } finally {
    for (const f of [labSkillFile, labHostSkillFile, snapshotFile]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => feServer.close(r));
    await new Promise((r) => apiServer.close(r));
    await new Promise((r) => labServer.close(r));
    restoreModuleCache();
  }

  // ── (c) Wave 4/5/6 still in npm test ───────────────────────────
  console.log("\n--- (c) Wave 4/5/6 API shame still wired ---\n");

  await test("SHAME (c): package.json test script still runs Wave 4/5/6 + fe-b2b", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
    const t = pkg.scripts.test || "";
    assert(/test-b2b-hosted/.test(t), "Wave 4 b2b-hosted in npm test");
    assert(/test-b2c-hosted/.test(t), "Wave 5 b2c-hosted in npm test");
    assert(/test-hosted-intake/.test(t), "Wave 6 hosted-intake in npm test");
    assert(/test-f5-auth/.test(t), "F5 auth in npm test");
    assert(/test-f4-intake/.test(t), "F4 intake in npm test");
    assert(/test-fe-b2b/.test(t), "FE-B2B shame in npm test");
  });

  // ── (d) no secrets in git ──────────────────────────────────────
  console.log("\n--- (d) No secrets in git ---\n");

  await test("SHAME (d): no GOOGLE_CLIENT_SECRET or JWT_SECRET values in tracked files", () => {
    const patterns = [
      /GOOGLE_CLIENT_SECRET\s*=\s*["']?[A-Za-z0-9_\-]{10,}/,
      /JWT_SECRET\s*=\s*["']?[A-Za-z0-9_\-]{20,}/,
    ];
    const tracked = execSync("git ls-files", { cwd: PROJECT_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const extras = [
      "public/fe-b2b/index.html",
      "scripts/fe-b2b-server.js",
      "docs/fe-b2b.md",
      "test/test-fe-b2b.js",
    ];
    const files = Array.from(new Set([...tracked, ...extras]));

    for (const file of files) {
      const fp = path.join(PROJECT_ROOT, file);
      if (!fs.existsSync(fp)) continue;
      if (fs.statSync(fp).isDirectory()) continue;
      if (/\.(png|jpg|gif|woff|ico|lock)$/i.test(file)) continue;
      let content;
      try {
        content = fs.readFileSync(fp, "utf8");
      } catch {
        continue;
      }
      for (const pat of patterns) {
        const match = pat.exec(content);
        if (match) {
          const isDocOrExample =
            /\.md$|\.example$|\.template$/i.test(file) ||
            /placeholder|example|stub|do-not-use|not-for-prod/i.test(match[0]);
          assert(
            isDocOrExample,
            `Possible secret in ${file}: ${match[0].slice(0, 40)}...`
          );
        }
      }
    }
  });

  console.log(`\n=== FE-B2B results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
