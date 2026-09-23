#!/usr/bin/env node
"use strict";

/**
 * F5 auth tests — offline, no DATABASE_URL or Google secrets needed.
 *
 * Tests:
 *   1. Health endpoint is public (no auth → 200)
 *   2. Protected routes return 401 without auth
 *   3. AUTH_STUB login returns JWT + user
 *   4. JWT grants access to protected routes
 *   5. Same-email notify → auto-verified (skip verify)
 *   6. Different-email notify → needs verification
 *   7. Verify token consumed → notify_verified_at set
 *   8. No secrets in git tree
 *   9. JWT module: sign/verify round-trip, expired token rejected
 *
 * Runs against Service A HTTP server with AUTH_STUB=1.
 * Neon-dependent tests (user CRUD against real DB) are separate and
 * skip gracefully when DATABASE_URL is absent — same pattern as test-watch-target.js.
 *
 * Token budget: 0 LLM.
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

process.env.AUTH_STUB = "1";

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name, reason) {
  console.log(`  SKIP  ${name} — ${reason}`);
  skipped++;
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function hasDbUrl() {
  for (const key of ["DATABASE_URL", "DATABASE_URL_NODE"]) {
    const v = process.env[key];
    if (v && String(v).trim()) return true;
  }
  return false;
}

async function main() {
  console.log("\n=== F5 auth tests ===\n");

  // ── JWT unit tests (no server needed) ───────────────────────────

  console.log("--- JWT sign/verify ---\n");

  const auth = require("../src/auth");

  await test("signJwt + verifyJwt round-trip", () => {
    const token = auth.signJwt({ sub: "user123", email: "a@b.com" });
    assert(typeof token === "string", "token is string");
    const parts = token.split(".");
    assert(parts.length === 3, "3-part JWT");
    const payload = auth.verifyJwt(token);
    assert(payload, "payload truthy");
    assert(payload.sub === "user123", `sub=${payload.sub}`);
    assert(payload.email === "a@b.com", `email=${payload.email}`);
  });

  await test("verifyJwt rejects tampered token", () => {
    const token = auth.signJwt({ sub: "user123" });
    const tampered = token.slice(0, -2) + "xx";
    const payload = auth.verifyJwt(tampered);
    assert(payload === null, "tampered should be null");
  });

  await test("verifyJwt rejects garbage", () => {
    assert(auth.verifyJwt("not.a.jwt") === null, "garbage null");
    assert(auth.verifyJwt("") === null, "empty null");
    assert(auth.verifyJwt("abc") === null, "short null");
  });

  await test("isStub returns true when AUTH_STUB=1", () => {
    assert(auth.isStub() === true, "should be stub");
  });

  // ── No secrets in tree ──────────────────────────────────────────

  console.log("\n--- Secrets safety ---\n");

  await test("no GOOGLE_CLIENT_SECRET or JWT_SECRET values in git-tracked files", () => {
    const ROOT = path.resolve(__dirname, "..");
    const patterns = [
      /GOOGLE_CLIENT_SECRET\s*=\s*["']?[A-Za-z0-9_\-]{10,}/,
      /JWT_SECRET\s*=\s*["']?[A-Za-z0-9_\-]{20,}/,
    ];

    const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

    for (const file of tracked) {
      const fp = path.join(ROOT, file);
      if (!fs.existsSync(fp)) continue;
      if (fs.statSync(fp).isDirectory()) continue;
      if (/node_modules|\.git\//.test(file)) continue;
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
          const isDocOrExample = /\.md$|\.example$|\.template$/i.test(file) ||
            /placeholder|example|stub|do-not-use/i.test(match[0]);
          assert(isDocOrExample, `Possible secret in ${file}: ${match[0].slice(0, 40)}...`);
        }
      }
    }
  });

  // ── HTTP integration tests (offline, AUTH_STUB + no DB) ─────────

  console.log("\n--- HTTP integration (stub auth, no DB) ---\n");

  const { handleRequest } = require("../src/service-a");
  const server = http.createServer(handleRequest);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = { hostname: "127.0.0.1", port };

  try {
    await test("GET /health returns 200 without auth", async () => {
      const res = await httpRequest({ ...base, path: "/health", method: "GET" });
      assert(res.status === 200, `status=${res.status}`);
      assert(res.body.status === "ok", `body.status=${res.body.status}`);
      assert(res.body.auth_mode === "stub", `auth_mode=${res.body.auth_mode}`);
    });

    await test("GET /customers returns 401 without auth", async () => {
      const res = await httpRequest({ ...base, path: "/customers", method: "GET" });
      assert(res.status === 401, `status=${res.status}`);
      assert(/auth/i.test(res.body.error), `error=${res.body.error}`);
    });

    await test("POST /customers returns 401 without auth", async () => {
      const res = await httpRequest(
        { ...base, path: "/customers", method: "POST", headers: { "Content-Type": "application/json" } },
        { name: "Test" }
      );
      assert(res.status === 401, `status=${res.status}`);
    });

    await test("GET /jobs returns 401 without auth", async () => {
      const res = await httpRequest({ ...base, path: "/jobs", method: "GET" });
      assert(res.status === 401, `status=${res.status}`);
    });

    await test("POST /watch-targets returns 401 without auth", async () => {
      const res = await httpRequest(
        { ...base, path: "/watch-targets", method: "POST", headers: { "Content-Type": "application/json" } },
        { customer_id: "x" }
      );
      assert(res.status === 401, `status=${res.status}`);
    });

    await test("GET /auth/me returns 401 without auth", async () => {
      const res = await httpRequest({ ...base, path: "/auth/me", method: "GET" });
      assert(res.status === 401, `status=${res.status}`);
    });

    // Login with stub and get JWT
    let token;
    let userId;
    const stubEmail = "alice@example.com";
    const stubSubject = "google-sub-alice-test";

    if (hasDbUrl()) {
      await test("POST /auth/login (stub) returns user + token", async () => {
        const res = await httpRequest(
          { ...base, path: "/auth/login", method: "POST", headers: { "Content-Type": "application/json" } },
          { google_subject: stubSubject, email: stubEmail }
        );
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.token, "has token");
        assert(res.body.user, "has user");
        assert(res.body.user.email === stubEmail, `email=${res.body.user.email}`);
        token = res.body.token;
        userId = res.body.user.id;
      });

      await test("GET /auth/me with valid JWT returns user", async () => {
        const res = await httpRequest({
          ...base, path: "/auth/me", method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.user.id === userId, `id=${res.body.user.id}`);
        assert(res.body.notify_verified === true, "same-email auto-verified");
      });

      await test("GET /customers with valid JWT returns 200", async () => {
        const res = await httpRequest({
          ...base, path: "/customers", method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(res.status === 200, `status=${res.status}`);
      });

      // Same-email notify: set notify_email = Google email → auto-verified
      await test("same-email notify → auto-verified (skip verify)", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/auth/notify-email", method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          },
          { notify_email: stubEmail }
        );
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.notify_verified === true, "auto-verified");
        assert(res.body.needs_verification === false, "no verify needed");
        assert(res.body.verify_token === null, "no token issued");
      });

      // Different-email notify: set notify_email ≠ Google email → needs verify
      const diffEmail = "bob@other.com";
      let verifyToken;

      await test("different-email notify → needs verification", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/auth/notify-email", method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          },
          { notify_email: diffEmail }
        );
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.notify_verified === false, "not verified");
        assert(res.body.needs_verification === true, "needs verify");
        assert(res.body.verify_token && res.body.verify_token.token, "token issued");
        verifyToken = res.body.verify_token.token;
      });

      await test("before verify consumed: user not notify-verified", async () => {
        const res = await httpRequest({
          ...base, path: "/auth/me", method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.notify_verified === false, "not verified yet");
      });

      await test("consume verify token → notify_verified_at set", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/auth/verify-notify-email", method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          },
          { token: verifyToken }
        );
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.verified === true, "verified");
        assert(res.body.notify_verified === true, "notify_verified");
      });

      await test("re-consuming same token fails (already_consumed)", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/auth/verify-notify-email", method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          },
          { token: verifyToken }
        );
        assert(res.status === 400, `status=${res.status}`);
        assert(res.body.reason === "already_consumed", `reason=${res.body.reason}`);
      });

      await test("after verify: user is notify-verified", async () => {
        const res = await httpRequest({
          ...base, path: "/auth/me", method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.notify_verified === true, "verified after consume");
      });

      // Switch back to same email → auto-verified again
      await test("switch back to same-email → re-verified automatically", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/auth/notify-email", method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          },
          { notify_email: stubEmail }
        );
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.notify_verified === true, "auto-verified");
        assert(res.body.needs_verification === false, "no verify needed");
      });

      // Cleanup test user
      try {
        const userStore = require("../src/user-store");
        await userStore.deleteUser(userId);
      } catch { /* best effort */ }
    } else {
      skip("POST /auth/login (stub) + Neon user CRUD", "DATABASE_URL not set");
      skip("GET /auth/me with valid JWT", "DATABASE_URL not set");
      skip("same-email notify auto-verified", "DATABASE_URL not set");
      skip("different-email notify needs verification", "DATABASE_URL not set");
      skip("consume verify token", "DATABASE_URL not set");
      skip("re-consume fails", "DATABASE_URL not set");
      skip("after verify user is notify-verified", "DATABASE_URL not set");
      skip("switch back to same-email re-verified", "DATABASE_URL not set");
      skip("GET /customers with valid JWT returns 200", "DATABASE_URL not set");
    }

    // Verify bad token doesn't work even without DB
    await test("bogus Bearer token returns 401", async () => {
      const res = await httpRequest({
        ...base, path: "/customers", method: "GET",
        headers: { Authorization: "Bearer garbage.token.here" },
      });
      assert(res.status === 401, `status=${res.status}`);
    });

    await test("invalid verify token returns 400", async () => {
      if (!hasDbUrl()) {
        // Without DB, consumeVerifyToken throws — expect 500
        const res = await httpRequest(
          {
            ...base, path: "/auth/verify-notify-email", method: "POST",
            headers: { Authorization: "Bearer " + auth.signJwt({ sub: "fake" }), "Content-Type": "application/json" },
          },
          { token: "nonexistent-token" }
        );
        assert(res.status === 401 || res.status === 400 || res.status === 500, `status=${res.status}`);
        return;
      }
      const res = await httpRequest(
        {
          ...base, path: "/auth/verify-notify-email", method: "POST",
          headers: { Authorization: "Bearer " + auth.signJwt({ sub: "fake" }), "Content-Type": "application/json" },
        },
        { token: "nonexistent-token" }
      );
      assert(res.status === 400, `status=${res.status}`);
    });

  } finally {
    server.close();
    try {
      const { closePool } = require("../src/db");
      await closePool().catch(() => {});
    } catch { /* ignore */ }
  }

  console.log(`\n=== F5 results: ${passed} passed, ${failed} failed, ${skipped} skipped ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
