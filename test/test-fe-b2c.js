#!/usr/bin/env node
"use strict";

/**
 * Wave 9 Thin FE-B2C shame-tests (0 LLM).
 *
 * (a) missing auth → fail-closed clear error
 * (b) catalog → watch happy path (stub + mock Neon)
 * (c) free-3+1 blocked (b2c_slots_exhausted)
 * (d) Wave 4–8 shame still wired in npm test
 * (e) secrets CLEAN
 *
 * Host smoke: Service A /fe-b2c/ 200 + same-origin /health + path traversal.
 *
 * Hard FAIL: second backend; AUTH_STUB as prod; new paid service; invent watches client-side.
 * Offline / CI-safe. AUTH_STUB=1 for local/shame path.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const FE_HTML = path.join(PROJECT_ROOT, "public", "fe-b2c", "index.html");
const FE_SERVER = path.join(PROJECT_ROOT, "scripts", "fe-b2c-server.js");
const PKG = path.join(PROJECT_ROOT, "package.json");
const DOCS = path.join(PROJECT_ROOT, "docs", "fe-b2c.md");
const SERVICE_A = path.join(PROJECT_ROOT, "src", "service-a.js");

process.env.AUTH_STUB = "1";

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
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = raw;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          /* keep raw */
        }
        resolve({
          status: res.statusCode,
          body: parsed,
          raw,
          headers: res.headers,
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function createMockDb() {
  const tables = {
    watch_targets: [],
    customers: [],
    skills: [],
    user_packages: [],
    product_offers: [],
    users: [],
    email_verify_tokens: [],
    click_log: [],
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
          rows: tables.product_offers
            .filter((r) => r.active)
            .sort((a, b) => (a.created_at > b.created_at ? 1 : -1)),
        };
      }
      if (/^SELECT \* FROM product_offers ORDER/i.test(sql)) {
        return { rows: tables.product_offers };
      }

      if (/^INSERT INTO click_log/i.test(sql)) {
        const row = {
          id: params[0],
          product_offer_id: params[1],
          user_id: params[2],
          ip: params[3],
          user_agent: params[4],
          created_at: new Date(),
        };
        tables.click_log.push(row);
        return { rows: [row] };
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
      if (/^SELECT \* FROM user_packages WHERE user_id/i.test(sql)) {
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
  console.log("\n=== Wave 9 Thin FE-B2C shame-tests ===\n");

  // ── Shell presence / hard FAIL guards ──────────────────────────
  console.log("--- Shell + hard-FAIL guards ---\n");

  await test("public/fe-b2c/index.html exists", () => {
    assert(fs.existsSync(FE_HTML), "missing public/fe-b2c/index.html");
  });

  await test("scripts/fe-b2c-server.js exists", () => {
    assert(fs.existsSync(FE_SERVER), "missing scripts/fe-b2c-server.js");
  });

  await test("npm script fe-b2c is wired", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
    assert(pkg.scripts && pkg.scripts["fe-b2c"], "package.json missing fe-b2c script");
    assert(/fe-b2c-server/.test(pkg.scripts["fe-b2c"]), "fe-b2c script should run fe-b2c-server");
  });

  await test("FE server does NOT import stores (no second backend)", () => {
    const src = fs.readFileSync(FE_SERVER, "utf8");
    assert(!/require\(["'].*intake/.test(src), "must not require intake");
    assert(!/require\(["'].*product-offer/.test(src), "must not require product-offer-store");
    assert(!/require\(["'].*slot-store/.test(src), "must not require slot-store");
    assert(!/require\(["'].*customer-store/.test(src), "must not require customer-store");
    assert(!/require\(["'].*watch-target/.test(src), "must not require watch-target");
    assert(/SERVICE_A_URL|proxy/i.test(src), "should proxy / document SERVICE_A_URL");
  });

  await test("FE HTML talks to Service A routes (not client-invented watches)", () => {
    const html = fs.readFileSync(FE_HTML, "utf8");
    assert(/\/auth\/login/.test(html), "must call /auth/login");
    assert(/\/product-offers/.test(html), "must call /product-offers");
    assert(/\/b2c\/slots/.test(html), "must call /b2c/slots");
    assert(/watch-targets/.test(html), "must call watch-targets");
    assert(/surface:\s*["']b2c["']|surface=b2c/.test(html), "surface=b2c");
    assert(/product_offer_id/.test(html), "product_offer_id");
    assert(/\/r\//.test(html), "affiliate /r/:id CTA");
    assert(/DEFAULT_DISCLOSURE|disclosure/i.test(html), "disclosure present");
    assert(
      /watches are not invented|not invented in the browser|server-side/i.test(html),
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

  await test("FE happy path is same-origin (no ?api= required)", () => {
    const html = fs.readFileSync(FE_HTML, "utf8");
    assert(/API_BASE/.test(html), "API_BASE present");
    assert(/same origin|same-origin|same host/i.test(html), "documents same-origin");
    assert(
      /params\.get\(["']api["']\)\s*\|\|\s*["']["']/.test(html) ||
        /\(params\.get\(["']api["']\)\s*\|\|\s*["']["']\)/.test(html),
      "default API_BASE empty (same origin)"
    );
  });

  await test("docs/fe-b2c.md documents Service A + host /fe-b2c/ + stub test-only", () => {
    assert(fs.existsSync(DOCS), "docs/fe-b2c.md missing");
    const text = fs.readFileSync(DOCS, "utf8");
    assert(/SERVICE_A_URL|service-a/i.test(text), "docs how to run with Service A");
    assert(/\/fe-b2c\//.test(text), "docs mention /fe-b2c/");
    assert(/same-origin|same host/i.test(text), "same-origin documented");
    assert(/No new paid|no new paid/i.test(text), "no new paid service");
    assert(/AUTH_STUB/i.test(text) && /Never.*prod|never.*Render|not.*prod/i.test(text), "AUTH_STUB not prod");
    assert(/PARKED|Phase B/i.test(text), "OAuth parked");
    assert(/test-fe-b2c/i.test(text), "shame named in docs");
    assert(/free-3|b2c_slots_exhausted/i.test(text), "free-3 documented");
  });

  await test("service-a.js documents /fe-b2c static serve + path traversal guard", () => {
    const src = fs.readFileSync(SERVICE_A, "utf8");
    assert(/\/fe-b2c\//.test(src), "service-a must mention /fe-b2c/");
    assert(/resolveFeB2cStatic|FE_B2C_ROOT|public.*fe-b2c/i.test(src), "static helper present");
    assert(/path traversal|\.\.|Bad path/i.test(src), "path-traversal guard present");
  });

  // ── Host smoke ─────────────────────────────────────────────────
  console.log("\n--- Host smoke: /fe-b2c/ on Service A ---\n");

  restoreModuleCache();
  delete process.env.AUTH_STUB;
  const serviceAHost = require("../src/service-a");
  assert(typeof serviceAHost.resolveFeB2cStatic === "function", "resolveFeB2cStatic exported");

  const hostServer = http.createServer((req, res) => {
    Promise.resolve(serviceAHost.handleRequest(req, res)).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
  });
  await new Promise((r) => hostServer.listen(0, "127.0.0.1", r));
  const hostPort = hostServer.address().port;

  try {
    await test("HOST: GET /fe-b2c/ → 200 HTML index", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: hostPort,
        path: "/fe-b2c/",
        method: "GET",
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(/text\/html/i.test(res.headers["content-type"] || ""), "content-type html");
      assert(/PriceWatch/i.test(res.raw), "body looks like FE index");
      assert(/B2C thin|fe-b2c|Catalog/i.test(res.raw), "FE-B2C content markers");
    });

    await test("HOST: GET /fe-b2c → 200 (no trailing slash)", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: hostPort,
        path: "/fe-b2c",
        method: "GET",
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(/PriceWatch/i.test(res.raw), "index without trailing slash");
    });

    await test("HOST: path traversal blocked", async () => {
      const attempts = [
        "/fe-b2c/../package.json",
        "/fe-b2c/%2e%2e/package.json",
        "/fe-b2c/../../etc/passwd",
      ];
      for (const p of attempts) {
        const res = await httpRequest({
          hostname: "127.0.0.1",
          port: hostPort,
          path: p,
          method: "GET",
        });
        assert(
          res.status === 400 || res.status === 404,
          `traversal ${p} expected 400/404, got ${res.status}`
        );
        assert(
          !/"name"\s*:\s*"workspace"/.test(res.raw),
          `must not leak package.json via ${p}`
        );
      }
    });

    await test("HOST: GET /health → 200 same-origin alongside /fe-b2c/", async () => {
      const fe = await httpRequest({
        hostname: "127.0.0.1",
        port: hostPort,
        path: "/fe-b2c/",
        method: "GET",
      });
      assert(fe.status === 200, "fe still up");
      const health = await httpRequest({
        hostname: "127.0.0.1",
        port: hostPort,
        path: "/health",
        method: "GET",
      });
      assert(health.status === 200, `health expected 200, got ${health.status}`);
      assert(health.body && health.body.status === "ok", "health status ok");
    });

    await test("HOST: resolveFeB2cStatic unit — only /fe-b2c paths", () => {
      assert(serviceAHost.resolveFeB2cStatic("/health") === null, "/health not static");
      assert(serviceAHost.resolveFeB2cStatic("/fe-b2b/") === null, "/fe-b2b not fe-b2c");
      const ok = serviceAHost.resolveFeB2cStatic("/fe-b2c/");
      assert(ok && ok.filePath && ok.filePath.endsWith("index.html"), "maps to index.html");
      const bad = serviceAHost.resolveFeB2cStatic("/fe-b2c/../src/service-a.js");
      assert(bad && bad.bad === true, "traversal marked bad");
    });

    await test("HOST: Wave 8 /fe-b2b/ still serves alongside /fe-b2c/", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: hostPort,
        path: "/fe-b2b/",
        method: "GET",
      });
      assert(res.status === 200, `fe-b2b expected 200, got ${res.status}`);
      assert(/B2B/i.test(res.raw), "B2B still hosted");
    });
  } finally {
    await new Promise((r) => hostServer.close(r));
    restoreModuleCache();
  }

  // ── (a) missing auth fail-closed ───────────────────────────────
  console.log("\n--- (a) Missing auth → fail-closed ---\n");

  process.env.AUTH_STUB = "1";
  restoreModuleCache();
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
    await test("SHAME (a): POST /watch-targets without auth → 401", async () => {
      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: portA,
          path: "/watch-targets",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        {
          customer_id: "x",
          surface: "b2c",
          product_offer_id: "offer-linear-standard",
        }
      );
      assert(res.status === 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(
        /auth|Authentication required/i.test(JSON.stringify(res.body || {})),
        "clear auth error"
      );
    });

    await test("SHAME (a): GET /product-offers without auth → 401", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: portA,
        path: "/product-offers",
        method: "GET",
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await test("SHAME (a): GET /b2c/slots without auth → 401", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: portA,
        path: "/b2c/slots",
        method: "GET",
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await test("SHAME (a): FE UI surfaces Authentication required / google_code_required", () => {
      const html = fs.readFileSync(FE_HTML, "utf8");
      assert(/Authentication required/i.test(html), "UI mentions Authentication required");
      assert(/google_code_required/.test(html), "UI mentions google_code_required");
      assert(
        /sign in first|sign in before/i.test(html),
        "UI blocks watch without auth"
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

  // ── (b) catalog → watch happy + (c) free-3+1 ───────────────────
  console.log("\n--- (b)/(c) Catalog → watch happy + free-3+1 ---\n");

  process.env.AUTH_STUB = "1";
  const mockPool = createMockDb();
  injectMockDb(mockPool);

  const serviceA = require("../src/service-a");
  const productOffers = require("../src/product-offer-store");

  const apiServer = http.createServer((req, res) => {
    Promise.resolve(serviceA.handleRequest(req, res)).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
  });
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  const apiPort = apiServer.address().port;

  const { isServiceAPath } = require("../scripts/fe-b2c-server.js");
  const feStatic = path.join(PROJECT_ROOT, "public", "fe-b2c");
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

  let token;
  let customerId;
  let offerId;

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
      assert(/B2C/i.test(res.raw || ""), "B2C marker");
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

    await test("SHAME (b): stub login via FE proxy → token", async () => {
      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: "/auth/login",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        { google_subject: "fe-b2c-shame", email: "fe-b2c-pilot@example.com" }
      );
      assert(res.status === 200, `status=${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.token, "token");
      assert(
        res.body.user && res.body.user.email === "fe-b2c-pilot@example.com",
        "user"
      );
      token = res.body.token;
    });

    await test("SHAME (b): seed product offers + list catalog", async () => {
      const seeded = await productOffers.seedOffers();
      assert(seeded.length >= 1, "seeded offers");
      offerId = seeded[0].id;

      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: fePort,
        path: "/product-offers",
        method: "GET",
        headers: { Authorization: "Bearer " + token },
      });
      assert(res.status === 200, `status=${res.status}: ${JSON.stringify(res.body)}`);
      assert(Array.isArray(res.body) && res.body.length >= 1, "offers listed");
      assert(res.body[0].disclosure, "disclosure on offer");
      assert(res.body[0].merchant_url, "merchant_url");
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
        { name: "FE-B2C Pilot", email: "fe-b2c-pilot@example.com" }
      );
      assert(
        res.status === 201 || res.status === 200,
        `status=${res.status}: ${JSON.stringify(res.body)}`
      );
      assert(res.body && res.body.id, "customer id");
      customerId = res.body.id;
    });

    await test("SHAME (b): GET /b2c/slots shows free-3", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: fePort,
        path: "/b2c/slots",
        method: "GET",
        headers: { Authorization: "Bearer " + token },
      });
      assert(res.status === 200, `status=${res.status}`);
      assert(res.body.total_slots === 3, `total_slots=${res.body.total_slots}`);
      assert(res.body.remaining === 3, `remaining=${res.body.remaining}`);
      assert(res.body.allowed === true, "allowed");
    });

    await test("SHAME (b): catalog → watch happy (surface=b2c + product_offer_id)", async () => {
      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: `/customers/${customerId}/watch-targets`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
        },
        { surface: "b2c", product_offer_id: offerId }
      );
      assert(
        res.status === 201,
        `status=${res.status}: ${JSON.stringify(res.body)}`
      );
      assert(res.body.watch_target, "watch_target");
      assert(res.body.watch_target.surface === "b2c", "surface=b2c");
      assert(
        res.body.watch_target.product_offer_id === offerId,
        "product_offer_id linked"
      );
    });

    await test("SHAME (b): affiliate /r/:id reachable (302)", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: fePort,
        path: `/r/${offerId}`,
        method: "GET",
      });
      assert(res.status === 302, `expected 302, got ${res.status}`);
      assert(res.headers.location, "Location header");
    });

    await test("SHAME (b): FE HTML shows disclosure + CTA for offers", () => {
      const html = fs.readFileSync(FE_HTML, "utf8");
      assert(/Buy via affiliate CTA|affiliate CTA/i.test(html), "CTA label");
      assert(
        /We may earn a commission|DEFAULT_DISCLOSURE/i.test(html),
        "DEFAULT disclosure copy"
      );
      assert(/data-disclosure|class="disclosure"/i.test(html), "disclosure element");
    });

    // Fill remaining free slots (already used 1) → 2 more, then block +1
    for (let i = 2; i <= 3; i++) {
      await test(`SHAME (c): create B2C watch #${i} within free-3`, async () => {
        // Need distinct offers or allow same offer multiple watches — API allows same offer.
        const res = await httpRequest(
          {
            hostname: "127.0.0.1",
            port: fePort,
            path: `/customers/${customerId}/watch-targets`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
          },
          {
            surface: "b2c",
            product_offer_id: offerId,
            label: `Extra watch ${i}`,
            // When product_offer fills label/url, extra label still ok via create path
          }
        );
        // Same product_offer_id may reuse offer fields — should still create.
        assert(
          res.status === 201,
          `watch #${i} status=${res.status}: ${JSON.stringify(res.body)}`
        );
      });
    }

    await test("SHAME (c): free-3+1 blocked with b2c_slots_exhausted", async () => {
      const slots = await httpRequest({
        hostname: "127.0.0.1",
        port: fePort,
        path: "/b2c/slots",
        method: "GET",
        headers: { Authorization: "Bearer " + token },
      });
      assert(slots.body.used_slots === 3, `used=${slots.body.used_slots}`);
      assert(slots.body.allowed === false, "slots not allowed");

      const res = await httpRequest(
        {
          hostname: "127.0.0.1",
          port: fePort,
          path: `/customers/${customerId}/watch-targets`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
        },
        { surface: "b2c", product_offer_id: offerId, label: "Blocked +1" }
      );
      assert(res.status === 403, `expected 403, got ${res.status}`);
      assert(
        res.body && res.body.error === "b2c_slots_exhausted",
        `error=${res.body && res.body.error}`
      );
    });

    await test("SHAME (c): FE UI documents free-3+1 / b2c_slots_exhausted", () => {
      const html = fs.readFileSync(FE_HTML, "utf8");
      assert(/b2c_slots_exhausted/.test(html), "UI mentions b2c_slots_exhausted");
      assert(/free-3/i.test(html), "UI mentions free-3");
    });
  } finally {
    await new Promise((r) => feServer.close(r));
    await new Promise((r) => apiServer.close(r));
    restoreModuleCache();
  }

  // ── (d) Wave 4–8 still in npm test ─────────────────────────────
  console.log("\n--- (d) Wave 4–8 shame still wired ---\n");

  await test("SHAME (d): package.json test script still runs Wave 4–8 + fe-b2c", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
    const t = pkg.scripts.test || "";
    assert(/test-b2b-hosted/.test(t), "Wave 4 b2b-hosted in npm test");
    assert(/test-b2c-hosted/.test(t), "Wave 5 b2c-hosted in npm test");
    assert(/test-hosted-intake/.test(t), "Wave 6 hosted-intake in npm test");
    assert(/test-fe-b2b/.test(t), "Wave 7 FE-B2B in npm test");
    assert(/test-host-fe-b2b/.test(t), "Wave 8 host-fe-b2b in npm test");
    assert(/test-fe-b2c/.test(t), "Wave 9 FE-B2C in npm test");
    assert(pkg.scripts["test:fe-b2c"], "test:fe-b2c script present");
    assert(pkg.scripts["fe-b2c"], "fe-b2c script present");
  });

  // ── (e) secrets CLEAN ──────────────────────────────────────────
  console.log("\n--- (e) Secrets CLEAN ---\n");

  await test("SHAME (e): no GOOGLE_CLIENT_SECRET or JWT_SECRET values in tracked files", () => {
    const patterns = [
      /GOOGLE_CLIENT_SECRET\s*=\s*["']?[A-Za-z0-9_\-]{10,}/,
      /JWT_SECRET\s*=\s*["']?[A-Za-z0-9_\-]{20,}/,
    ];
    const tracked = execSync("git ls-files", { cwd: PROJECT_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const extras = [
      "public/fe-b2c/index.html",
      "scripts/fe-b2c-server.js",
      "docs/fe-b2c.md",
      "test/test-fe-b2c.js",
      "src/service-a.js",
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

  console.log(`\n=== FE-B2C results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
