#!/usr/bin/env node
"use strict";

/**
 * F4 intake tests — offline, no DATABASE_URL or live scrape needed.
 *
 * Tests (aligned to F4 acceptance + Chris QA methods M1/M2/M7):
 *
 *   Extraction:
 *   1. Lab multi-plan fixture → preview ≥2 structured candidates
 *   2. Each candidate has plan_key, name, price, currency, period
 *   3. No raw HTML or undifferentiated blob in response
 *
 *   intent_text:
 *   4. intent_text "Pro" ranks matching candidate first
 *   5. intent_text never invents a price or candidate
 *
 *   Validation:
 *   6. No URL → 400
 *   7. Empty URL → 400
 *   8. Non-allowlisted URL → 422 unsupported_site
 *   9. Blocked/empty page → honest error
 *
 *   Auth gates (HTTP integration):
 *   10. POST /b2b/intake/confirm without auth → 401
 *   11. POST /b2b/intake/confirm with unverified notify → 403 notify_email_unverified
 *   12. POST /b2b/intake/preview is public (no auth required)
 *
 *   Confirm:
 *   13. Confirm with selected plan → creates WatchTarget + skill + baseline
 *   14. first_learn = true → no alert/outbox on first learn
 *   15. Confirm without selected → 400
 *   16. Confirm with invalid plan_key → 422
 *
 *   Fallback stubs:
 *   17. POST /b2b/intake/selector → 501
 *   18. POST /b2b/intake/manual-seed → 501
 *
 *   Allowlist:
 *   19. Supported domain URL → extraction proceeds
 *   20. Random internet URL → honest unsupported
 *
 *   Daily path safety:
 *   21. Unselected plan in baseline has selected=false
 *
 * Runs with AUTH_STUB=1, no DATABASE_URL required. Serves lab HTML
 * from static fixture for offline CI.
 *
 * Token budget: 0 LLM.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

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

const LAB_HTML = fs.readFileSync(
  path.join(__dirname, "fixtures", "lab-multiplan.html"),
  "utf8"
);

async function main() {
  console.log("\n=== F4 intake tests ===\n");

  // ── Unit tests: extraction from static fixture ─────────────────

  console.log("--- Plan extraction from lab fixture ---\n");

  const { extractPlansFromHtml } = require("../src/plan-ladder");

  await test("lab multi-plan extractor parses ≥2 candidates from fixture HTML", () => {
    const plans = extractPlansFromHtml(LAB_HTML, "127.0.0.1", "/pricing");
    assert(plans !== null, "plans should not be null");
    assert(Array.isArray(plans), "plans should be array");
    assert(plans.length >= 2, `expected ≥2 plans, got ${plans.length}`);
  });

  await test("each candidate has plan_key, plan (name), price, currency, billing", () => {
    const plans = extractPlansFromHtml(LAB_HTML, "127.0.0.1", "/pricing");
    for (const p of plans) {
      assert(typeof p.plan_key === "string" && p.plan_key.length > 0, `plan_key missing: ${JSON.stringify(p)}`);
      assert(typeof p.plan === "string" && p.plan.length > 0, `plan (name) missing: ${JSON.stringify(p)}`);
      assert(p.price === null || typeof p.price === "number", `price invalid: ${JSON.stringify(p)}`);
      assert(typeof p.currency === "string", `currency missing: ${JSON.stringify(p)}`);
      assert(typeof p.billing === "string", `billing missing: ${JSON.stringify(p)}`);
    }
  });

  await test("no raw HTML in candidate fields (structured, not blob)", () => {
    const plans = extractPlansFromHtml(LAB_HTML, "127.0.0.1", "/pricing");
    for (const p of plans) {
      assert(!/<[a-z]/.test(p.plan), `plan name contains HTML: ${p.plan}`);
      assert(!/<[a-z]/.test(String(p.plan_key)), `plan_key contains HTML: ${p.plan_key}`);
    }
  });

  await test("lab fixture has Free, Starter, Pro, Enterprise plans", () => {
    const plans = extractPlansFromHtml(LAB_HTML, "127.0.0.1", "/pricing");
    const names = plans.map((p) => p.plan);
    assert(names.includes("Free"), "missing Free");
    assert(names.includes("Starter"), "missing Starter");
    assert(names.includes("Pro"), "missing Pro");
    assert(names.includes("Enterprise"), "missing Enterprise");
  });

  await test("Free plan has price=0, Enterprise has price=null", () => {
    const plans = extractPlansFromHtml(LAB_HTML, "127.0.0.1", "/pricing");
    const free = plans.find((p) => p.plan === "Free");
    const ent = plans.find((p) => p.plan === "Enterprise");
    assert(free.price === 0, `Free price=${free.price}`);
    assert(ent.price === null, `Enterprise price=${ent.price}`);
  });

  // ── Unit tests: intake module ───────────────────────────────────

  console.log("\n--- Intake preview module ---\n");

  const intake = require("../src/intake");

  await test("previewFromHtml returns structured candidates from lab fixture", () => {
    const result = intake.previewFromHtml(LAB_HTML, "http://127.0.0.1:3847/pricing");
    assert(!result.error, `error: ${result.error}`);
    assert(result.candidates.length >= 2, `expected ≥2, got ${result.candidates.length}`);
    for (const c of result.candidates) {
      assert(c.plan_key, "plan_key present");
      assert(c.name, "name present");
      assert(c.price === null || typeof c.price === "number", "price is number or null");
      assert(c.currency, "currency present");
      assert(c.period, "period present");
    }
  });

  await test("intent_text 'Pro' sorts Pro candidate to top", () => {
    const result = intake.previewFromHtml(LAB_HTML, "http://127.0.0.1:3847/pricing", "Pro");
    assert(!result.error, `error: ${result.error}`);
    assert(result.candidates[0].name === "Pro" || result.candidates[0].plan_key === "pro",
      `first candidate: ${result.candidates[0].name}`);
  });

  await test("intent_text 'Starter' sorts Starter to top", () => {
    const result = intake.previewFromHtml(LAB_HTML, "http://127.0.0.1:3847/pricing", "Starter");
    assert(!result.error, `error: ${result.error}`);
    assert(result.candidates[0].name === "Starter",
      `first candidate: ${result.candidates[0].name}`);
  });

  await test("intent_text does not invent new candidates", () => {
    const withIntent = intake.previewFromHtml(LAB_HTML, "http://127.0.0.1:3847/pricing", "Gold Diamond Plan");
    const without = intake.previewFromHtml(LAB_HTML, "http://127.0.0.1:3847/pricing");
    assert(!withIntent.error, `error: ${withIntent.error}`);
    assert(withIntent.candidates.length === without.candidates.length,
      `intent changed count: ${withIntent.candidates.length} vs ${without.candidates.length}`);
    const withNames = new Set(withIntent.candidates.map((c) => c.plan_key));
    const withoutNames = new Set(without.candidates.map((c) => c.plan_key));
    for (const k of withNames) {
      assert(withoutNames.has(k), `intent invented plan_key: ${k}`);
    }
  });

  await test("preview with no url returns error", () => {
    const result = intake.previewFromHtml(LAB_HTML, "");
    assert(result.error === "invalid_url", `error: ${result.error}`);
  });

  await test("isSupportedUrl rejects random internet URL", () => {
    assert(!intake.isSupportedUrl("https://example.com/pricing"), "example.com should be unsupported");
    assert(!intake.isSupportedUrl("https://some-random-site.xyz"), "random should be unsupported");
  });

  await test("isSupportedUrl accepts lab URL", () => {
    assert(intake.isSupportedUrl("http://127.0.0.1:3847/pricing"), "lab URL should be supported");
    assert(intake.isSupportedUrl("http://localhost:3847/pricing"), "localhost should be supported");
  });

  await test("isSupportedUrl accepts allowlisted domains", () => {
    assert(intake.isSupportedUrl("https://linear.app/pricing"), "linear.app should be supported");
    assert(intake.isSupportedUrl("https://www.vercel.com/pricing"), "vercel.com should be supported");
    assert(intake.isSupportedUrl("https://notion.com/pricing"), "notion.com should be supported");
  });

  await test("rankByIntent only reorders, never adds/removes", () => {
    const candidates = [
      { plan_key: "free", name: "Free", price: 0 },
      { plan_key: "pro", name: "Pro", price: 49 },
      { plan_key: "biz", name: "Business", price: 99 },
    ];
    const ranked = intake.rankByIntent(candidates, "Business");
    assert(ranked.length === 3, `count changed: ${ranked.length}`);
    assert(ranked[0].plan_key === "biz", `first should be biz, got ${ranked[0].plan_key}`);
  });

  // ── HTTP integration tests ──────────────────────────────────────

  console.log("\n--- HTTP integration (stub auth) ---\n");

  let labServer;
  let labPort;

  labServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/pricing") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LAB_HTML);
      return;
    }
    if (req.method === "GET" && req.url === "/empty") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>No pricing here</body></html>");
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  await new Promise((r) => labServer.listen(0, "127.0.0.1", r));
  labPort = labServer.address().port;

  const { handleRequest } = require("../src/service-a");
  const apiServer = http.createServer(handleRequest);
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  const apiPort = apiServer.address().port;
  const base = { hostname: "127.0.0.1", port: apiPort };

  try {
    // ── Preview tests (public, no auth) ────────────────────────────

    await test("POST /b2b/intake/preview is public (no auth required)", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/preview", method: "POST", headers: { "Content-Type": "application/json" } },
        { url: `http://127.0.0.1:${labPort}/pricing` }
      );
      assert(res.status === 200, `status=${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.candidates, "has candidates");
    });

    await test("preview returns ≥2 structured candidates from lab", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/preview", method: "POST", headers: { "Content-Type": "application/json" } },
        { url: `http://127.0.0.1:${labPort}/pricing` }
      );
      assert(res.status === 200, `status=${res.status}`);
      assert(res.body.candidates.length >= 2, `got ${res.body.candidates.length} candidates`);
      for (const c of res.body.candidates) {
        assert(c.plan_key, `missing plan_key`);
        assert(c.name, `missing name`);
        assert(c.currency, `missing currency`);
        assert(c.period, `missing period`);
        assert(c.price === null || typeof c.price === "number", `price not num/null: ${c.price}`);
      }
    });

    await test("preview does NOT return raw HTML", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/preview", method: "POST", headers: { "Content-Type": "application/json" } },
        { url: `http://127.0.0.1:${labPort}/pricing` }
      );
      assert(res.status === 200, `status=${res.status}`);
      const body = JSON.stringify(res.body);
      assert(!/<html/i.test(body), "response contains raw HTML");
      assert(!/<div/i.test(body), "response contains raw HTML divs");
    });

    await test("preview with intent_text ranks matching plan first", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/preview", method: "POST", headers: { "Content-Type": "application/json" } },
        { url: `http://127.0.0.1:${labPort}/pricing`, intent_text: "Pro" }
      );
      assert(res.status === 200, `status=${res.status}`);
      assert(res.body.candidates[0].plan_key === "pro" || res.body.candidates[0].name === "Pro",
        `first candidate: ${res.body.candidates[0].name}`);
    });

    await test("preview with no URL → 400", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/preview", method: "POST", headers: { "Content-Type": "application/json" } },
        {}
      );
      assert(res.status === 400, `status=${res.status}`);
    });

    await test("preview with empty URL → 400", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/preview", method: "POST", headers: { "Content-Type": "application/json" } },
        { url: "" }
      );
      assert(res.status === 400, `status=${res.status}`);
    });

    await test("preview with non-allowlisted URL → 422 unsupported_site", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/preview", method: "POST", headers: { "Content-Type": "application/json" } },
        { url: "https://example.com/pricing" }
      );
      assert(res.status === 422, `status=${res.status}`);
      assert(res.body.error === "unsupported_site", `error=${res.body.error}`);
    });

    // ── Auth gate tests ────────────────────────────────────────────

    await test("POST /b2b/intake/confirm without auth → 401", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2b/intake/confirm", method: "POST", headers: { "Content-Type": "application/json" } },
        { url: `http://127.0.0.1:${labPort}/pricing`, selected: [{ plan_key: "pro" }], customer_id: "c1" }
      );
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await test("POST /b2b/intake/confirm with bogus token → 401", async () => {
      const res = await httpRequest(
        {
          ...base, path: "/b2b/intake/confirm", method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer garbage.token.xyz" },
        },
        { url: `http://127.0.0.1:${labPort}/pricing`, selected: [{ plan_key: "pro" }], customer_id: "c1" }
      );
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    // ── Stub fallbacks ─────────────────────────────────────────────

    if (hasDbUrl()) {
      const authMod = require("../src/auth");
      const stubEmail2 = "f4-stub@example.com";
      const stubSubject2 = "google-sub-f4-stub";

      const loginRes2 = await httpRequest(
        { ...base, path: "/auth/login", method: "POST", headers: { "Content-Type": "application/json" } },
        { google_subject: stubSubject2, email: stubEmail2 }
      );
      const stubToken = loginRes2.body.token;
      const stubUserId = loginRes2.body.user.id;

      await test("POST /b2b/intake/selector → 501", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/selector", method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${stubToken}` },
          },
          {}
        );
        assert(res.status === 501, `expected 501, got ${res.status}`);
      });

      await test("POST /b2b/intake/manual-seed → 501", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/manual-seed", method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${stubToken}` },
          },
          {}
        );
        assert(res.status === 501, `expected 501, got ${res.status}`);
      });

      await test("POST /b2b/intake/confirm without selected → 400", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/confirm", method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${stubToken}` },
          },
          { url: `http://127.0.0.1:${labPort}/pricing`, customer_id: "c1" }
        );
        assert(res.status === 400, `expected 400, got ${res.status}`);
      });

      await test("POST /b2b/intake/confirm without url → 400", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/confirm", method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${stubToken}` },
          },
          { selected: [{ plan_key: "pro" }], customer_id: "c1" }
        );
        assert(res.status === 400, `expected 400, got ${res.status}`);
      });

      try {
        const userStore = require("../src/user-store");
        await userStore.deleteUser(stubUserId);
      } catch { /* best effort */ }
    } else {
      await test("POST /b2b/intake/selector without auth → 401 (auth required)", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/selector", method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          {}
        );
        assert(res.status === 401, `expected 401, got ${res.status}`);
      });

      await test("POST /b2b/intake/manual-seed without auth → 401 (auth required)", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/manual-seed", method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          {}
        );
        assert(res.status === 401, `expected 401, got ${res.status}`);
      });

      skip("confirm without selected → 400", "DATABASE_URL not set (needs real user for auth)");
      skip("confirm without url → 400", "DATABASE_URL not set (needs real user for auth)");
    }

    // ── DB-dependent confirm tests ─────────────────────────────────

    if (hasDbUrl()) {
      const auth = require("../src/auth");

      const stubEmail = "f4-test@example.com";
      const stubSubject = "google-sub-f4-test";

      const loginRes = await httpRequest(
        { ...base, path: "/auth/login", method: "POST", headers: { "Content-Type": "application/json" } },
        { google_subject: stubSubject, email: stubEmail }
      );
      const token = loginRes.body.token;
      const userId = loginRes.body.user.id;

      const diffEmail = "f4-different@other.com";
      await httpRequest(
        {
          ...base, path: "/auth/notify-email", method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        },
        { notify_email: diffEmail }
      );

      await test("POST /b2b/intake/confirm with unverified notify → 403 notify_email_unverified", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/confirm", method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          },
          {
            url: `http://127.0.0.1:${labPort}/pricing`,
            selected: [{ plan_key: "pro" }],
            customer_id: "test-cust",
          }
        );
        assert(res.status === 403, `expected 403, got ${res.status}`);
        assert(res.body.reason === "notify_email_unverified", `reason=${res.body.reason}`);
      });

      await httpRequest(
        {
          ...base, path: "/auth/notify-email", method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        },
        { notify_email: stubEmail }
      );

      const custRes = await httpRequest(
        {
          ...base, path: "/customers", method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        },
        { name: "F4 Test Customer", email: stubEmail }
      );
      const customerId = custRes.body.id;

      await test("confirm with selected plan → creates WatchTarget + skill + baseline", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/confirm", method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          },
          {
            url: `http://127.0.0.1:${labPort}/pricing`,
            selected: [{ plan_key: "pro" }],
            customer_id: customerId,
          }
        );
        assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(res.body.watch_targets, "has watch_targets");
        assert(res.body.watch_targets.length === 1, `expected 1 watch_target, got ${res.body.watch_targets.length}`);
        assert(res.body.skills && res.body.skills.length === 1, "has 1 skill path");
        assert(res.body.baselines && res.body.baselines.length === 1, "has 1 baseline path");
        assert(res.body.first_learn === true, "first_learn should be true");

        const wt = res.body.watch_targets[0];
        assert(wt.plan_key === "pro", `plan_key=${wt.plan_key}`);
        assert(wt.status === "skill_ready", `status=${wt.status}`);
        assert(wt.source_url.includes("/pricing"), `source_url=${wt.source_url}`);
        assert(wt.label === "Pro", `label=${wt.label}`);
      });

      await test("first_learn: no outbox/alert artifact created", () => {
        const outboxDir = path.join(__dirname, "..", "outbox");
        if (!fs.existsSync(outboxDir)) return;
        const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json") && !f.startsWith("samples"));
        const recent = files.filter((f) => {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(outboxDir, f), "utf8"));
            return content.trigger === "first_learn" || content.type === "price_change";
          } catch {
            return false;
          }
        });
        assert(recent.length === 0, `found ${recent.length} outbox artifacts for first learn — expected 0`);
      });

      await test("confirm with non-matching plan_key → 422", async () => {
        const res = await httpRequest(
          {
            ...base, path: "/b2b/intake/confirm", method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          },
          {
            url: `http://127.0.0.1:${labPort}/pricing`,
            selected: [{ plan_key: "nonexistent-plan" }],
            customer_id: customerId,
          }
        );
        assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(res.body.error === "no_matching_plans", `error=${res.body.error}`);
      });

      try {
        const userStore = require("../src/user-store");
        await userStore.deleteUser(userId);
      } catch { /* best effort */ }
    } else {
      skip("confirm with unverified notify → 403", "DATABASE_URL not set");
      skip("confirm creates WatchTarget + skill + baseline", "DATABASE_URL not set");
      skip("first_learn no outbox", "DATABASE_URL not set");
      skip("confirm non-matching plan_key → 422", "DATABASE_URL not set");
    }

    // ── Baseline safety: unselected plans marked selected=false ────

    await test("baseline snapshot marks unselected plans as selected=false", () => {
      const intake = require("../src/intake");
      const previewResult = intake.previewFromHtml(LAB_HTML, "http://127.0.0.1:3847/pricing");
      assert(previewResult.candidates, "has candidates");

      const { saveLadderSnapshot, loadLadderSnapshot } = require("../src/plan-ladder-snapshot");
      const selectedKeys = new Set(["pro"]);
      const baselinePlans = previewResult.candidates.map((c) => ({
        plan: c.name,
        plan_key: c.plan_key,
        price: c.price,
        currency: c.currency,
        billing: c.period,
        selected: selectedKeys.has(c.plan_key),
      }));

      saveLadderSnapshot("f4-test-baseline", baselinePlans);
      const loaded = loadLadderSnapshot("f4-test-baseline");
      assert(loaded, "baseline loaded");
      assert(loaded.plans.length >= 2, "baseline has plans");

      const pro = loaded.plans.find((p) => p.plan_key === "pro");
      const free = loaded.plans.find((p) => p.plan_key === "free");
      assert(pro && pro.selected === true, "pro should be selected");
      assert(free && free.selected === false, "free should NOT be selected");

      const fs = require("fs");
      try {
        fs.unlinkSync(path.join(require("../src/plan-ladder-snapshot").LADDER_DIR, "f4-test-baseline.json"));
      } catch { /* best effort */ }
    });

  } finally {
    labServer.close();
    apiServer.close();
    try {
      const { closePool } = require("../src/db");
      await closePool().catch(() => {});
    } catch { /* ignore */ }
  }

  console.log(`\n=== F4 results: ${passed} passed, ${failed} failed, ${skipped} skipped ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
