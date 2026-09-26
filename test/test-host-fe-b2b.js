#!/usr/bin/env node
"use strict";

/**
 * Wave 8 — Host Thin FE-B2B on Service A shame-tests (0 LLM).
 *
 * (a) static path serves index (Service A handleRequest)
 * (b) health reachable same-origin
 * (c) prior FE + hosted shame still green (wired in npm test)
 * (d) secrets CLEAN
 *
 * Hard FAIL: new paid Render service; AUTH_STUB as prod login; second backend.
 * Offline / CI-safe — no live Render, no GCP, no LLM.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const PKG = path.join(PROJECT_ROOT, "package.json");
const FE_HTML = path.join(PROJECT_ROOT, "public", "fe-b2b", "index.html");
const DOCS = path.join(PROJECT_ROOT, "docs", "fe-b2b.md");
const SERVICE_A = path.join(PROJECT_ROOT, "src", "service-a.js");

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
          /* keep raw string */
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

function restoreModuleCache() {
  const mods = ["../src/service-a", "../src/auth", "../src/watch-target-store"];
  for (const m of mods) {
    try {
      delete require.cache[require.resolve(m)];
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log("\n=== Wave 8 Host FE-B2B shame-tests ===\n");

  // ── Presence / contract guards ─────────────────────────────────
  console.log("--- Contract guards ---\n");

  await test("public/fe-b2b/index.html exists", () => {
    assert(fs.existsSync(FE_HTML), "missing public/fe-b2b/index.html");
  });

  await test("service-a.js documents /fe-b2b static serve", () => {
    const src = fs.readFileSync(SERVICE_A, "utf8");
    assert(/\/fe-b2b\//.test(src), "service-a must mention /fe-b2b/");
    assert(/resolveFeB2bStatic|FE_B2B_ROOT|public.*fe-b2b/i.test(src), "static helper present");
    assert(/path traversal|\.\.|Bad path/i.test(src), "path-traversal guard present");
  });

  await test("FE happy path is same-origin (no ?api= required)", () => {
    const html = fs.readFileSync(FE_HTML, "utf8");
    assert(/API_BASE/.test(html), "API_BASE present");
    assert(
      /same origin|same-origin|same host/i.test(html),
      "documents same-origin happy path"
    );
    assert(
      /params\.get\(["']api["']\)\s*\|\|\s*["']["']/.test(html) ||
        /\(params\.get\(["']api["']\)\s*\|\|\s*["']["']\)/.test(html),
      "default API_BASE empty (same origin)"
    );
    // Absolute API paths so /fe-b2b/ page hits host-root /health etc.
    assert(/["']\/health["']|\/health/.test(html), "calls /health");
    assert(/\/auth\/login/.test(html), "calls /auth/login");
    assert(/\/b2b\/intake\/preview/.test(html), "calls /b2b/intake/preview");
    assert(/\/customers/.test(html), "calls /customers");
  });

  await test("docs/fe-b2b.md documents hosted /fe-b2b/ + same-origin", () => {
    assert(fs.existsSync(DOCS), "docs/fe-b2b.md missing");
    const text = fs.readFileSync(DOCS, "utf8");
    assert(/\/fe-b2b\//.test(text), "docs mention /fe-b2b/");
    assert(/pricewatch-9cja\.onrender\.com|Service A/i.test(text), "hosted Service A URL/path");
    assert(/same-origin|same host/i.test(text), "same-origin documented");
    assert(/No new paid|no new paid/i.test(text), "no new paid service");
    assert(/AUTH_STUB/i.test(text) && /Never.*prod|never.*Render|not.*prod/i.test(text), "AUTH_STUB not prod");
    assert(/PARKED|Phase B/i.test(text), "OAuth parked");
    assert(/test-host-fe-b2b/i.test(text), "Wave 8 shame named in docs");
  });

  await test("no second backend / no new Render service claimed in wave files", () => {
    const src = fs.readFileSync(SERVICE_A, "utf8");
    // Static serve only — must not spawn a second HTTP server for FE.
    assert(
      !/createServer\(.*fe-b2b|listen\(.*fe.?b2b/i.test(src),
      "Service A must not start a second FE server"
    );
    const docs = fs.readFileSync(DOCS, "utf8");
    // Prohibition phrasing is OK; claiming we added a paid host is not.
    assert(
      /No new paid Render service/i.test(docs),
      "docs must forbid new paid Render service"
    );
    assert(
      !/created a new paid|spin up a paid|new paid web service/i.test(docs),
      "must not claim a new paid service was created"
    );
  });

  // ── (a) static path serves index ───────────────────────────────
  console.log("\n--- (a) Static /fe-b2b/ serves index ---\n");

  restoreModuleCache();
  // Do NOT set AUTH_STUB=1 for host static tests — prod path is fail-closed google.
  // Health still works without stub; static needs no auth.
  delete process.env.AUTH_STUB;

  const serviceA = require("../src/service-a");
  assert(typeof serviceA.resolveFeB2bStatic === "function", "resolveFeB2bStatic exported");
  assert(typeof serviceA.handleRequest === "function", "handleRequest exported");

  const server = http.createServer((req, res) => {
    Promise.resolve(serviceA.handleRequest(req, res)).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    await test("SHAME (a): GET /fe-b2b/ → 200 HTML index", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/fe-b2b/",
        method: "GET",
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(
        /text\/html/i.test(res.headers["content-type"] || ""),
        `content-type html, got ${res.headers["content-type"]}`
      );
      assert(/PriceWatch/i.test(res.raw), "body looks like FE index");
      assert(/B2B thin|fe-b2b|Login/i.test(res.raw), "FE content markers");
    });

    await test("SHAME (a): GET /fe-b2b → 200 (no trailing slash)", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/fe-b2b",
        method: "GET",
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(/PriceWatch/i.test(res.raw), "index without trailing slash");
    });

    await test("SHAME (a): GET /fe-b2b/index.html → 200", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/fe-b2b/index.html",
        method: "GET",
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(/PriceWatch/i.test(res.raw), "explicit index.html");
    });

    await test("SHAME (a): path traversal blocked", async () => {
      const attempts = [
        "/fe-b2b/../package.json",
        "/fe-b2b/%2e%2e/package.json",
        "/fe-b2b/../../etc/passwd",
      ];
      for (const p of attempts) {
        const res = await httpRequest({
          hostname: "127.0.0.1",
          port,
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

    // ── (b) health same-origin ───────────────────────────────────
    console.log("\n--- (b) Health reachable same-origin ---\n");

    await test("SHAME (b): GET /health → 200 on same server as /fe-b2b/", async () => {
      const fe = await httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/fe-b2b/",
        method: "GET",
      });
      assert(fe.status === 200, "fe still up");
      const health = await httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
      });
      assert(health.status === 200, `health expected 200, got ${health.status}`);
      assert(health.body && health.body.status === "ok", "health status ok");
      assert(health.body.service === "pricewatch-api", "service name");
      // Without AUTH_STUB, auth_mode should be google (fail-closed prod posture).
      assert(
        health.body.auth_mode === "google" || health.body.auth_mode === "stub",
        `auth_mode present: ${health.body.auth_mode}`
      );
    });

    await test("SHAME (b): existing API routes not broken by static mount", async () => {
      const missing = await httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/customers",
        method: "GET",
      });
      // Unauthenticated → 401 (route still matched), not 404 from static.
      assert(
        missing.status === 401,
        `GET /customers without auth expected 401, got ${missing.status}`
      );

      const preview = await httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/b2b/intake/preview",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        {}
      );
      // Public route, missing url → 400 (still routed).
      assert(
        preview.status === 400,
        `POST /b2b/intake/preview expected 400, got ${preview.status}`
      );
    });

    await test("SHAME (b): resolveFeB2bStatic unit — only /fe-b2b paths", () => {
      assert(serviceA.resolveFeB2bStatic("/health") === null, "/health not static");
      assert(serviceA.resolveFeB2bStatic("/auth/login") === null, "/auth not static");
      const ok = serviceA.resolveFeB2bStatic("/fe-b2b/");
      assert(ok && ok.filePath && ok.filePath.endsWith("index.html"), "maps to index.html");
      const bad = serviceA.resolveFeB2bStatic("/fe-b2b/../src/service-a.js");
      assert(bad && bad.bad === true, "traversal marked bad");
    });
  } finally {
    await new Promise((r) => server.close(r));
    restoreModuleCache();
  }

  // ── (c) prior FE + hosted shame still wired ────────────────────
  console.log("\n--- (c) Prior FE + hosted shame still green (wired) ---\n");

  await test("SHAME (c): npm test still runs Wave 4–7 + host-fe-b2b", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
    const t = pkg.scripts.test || "";
    assert(/test-b2b-hosted/.test(t), "Wave 4 b2b-hosted in npm test");
    assert(/test-b2c-hosted/.test(t), "Wave 5 b2c-hosted in npm test");
    assert(/test-hosted-intake/.test(t), "Wave 6 hosted-intake in npm test");
    assert(/test-fe-b2b/.test(t), "Wave 7 FE-B2B in npm test");
    assert(/test-host-fe-b2b/.test(t), "Wave 8 host-fe-b2b in npm test");
    assert(pkg.scripts["test:host-fe-b2b"], "test:host-fe-b2b script present");
  });

  // ── (d) secrets CLEAN ──────────────────────────────────────────
  console.log("\n--- (d) Secrets CLEAN ---\n");

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
      "src/service-a.js",
      "docs/fe-b2b.md",
      "test/test-host-fe-b2b.js",
      "scripts/fe-b2b-server.js",
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

  console.log(`\n=== Host FE-B2B results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
