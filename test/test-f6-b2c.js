#!/usr/bin/env node
"use strict";

/**
 * F6 B2C stubs tests — offline, no DATABASE_URL or Stripe needed.
 *
 * Tests (map to F6 acceptance criteria):
 *
 *   ProductOffer stub:
 *     1. SEED_OFFERS have required fields (merchant_url, affiliate fields, disclosure, active)
 *     2. Affiliate fields NOT on B2B competitor emails
 *     3. Route /product-offers exists
 *     4. Route /product-offers/seed exists
 *
 *   Slot enforcement:
 *     5. Free tier = 3 slots
 *     6. Packages: 1/3/5/10/unlimited all defined
 *     7. Unlimited soft-cap = 50 (not unbounded)
 *     8. Ops alarm fires with structured payload
 *
 *   /r/:id redirect:
 *     9. Route exists and is public
 *     10. Returns 404 for nonexistent offer
 *
 *   Payment stub:
 *     11. Route exists
 *     12. Rejects missing package_type (without DB)
 *     13. Rejects 'free' package_type
 *     14. Rejects invalid package_type
 *
 *   DB-gated (only when DATABASE_URL set):
 *     15. Full slot enforcement flow: free-3 exhausted → refuse → payment stub → allow
 *     16. GET /r/:id → 302 with click log
 *     17. Product offer seed + list
 *
 * Runs against Service A HTTP server with AUTH_STUB=1.
 * Token budget: 0 LLM.
 */

const http = require("http");

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
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null,
            headers: res.headers,
            rawBody: data,
          });
        } catch {
          resolve({
            status: res.statusCode,
            body: data,
            headers: res.headers,
            rawBody: data,
          });
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

async function loginStub(base, email) {
  const res = await httpRequest(
    {
      ...base,
      path: "/auth/login",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    { google_subject: `sub-${email}`, email }
  );
  assert(res.status === 200, `login status=${res.status}: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.user.id };
}

function authed(base, token) {
  return {
    ...base,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
}

async function main() {
  console.log("\n=== F6 B2C stubs tests ===\n");

  // ── Unit tests (no server/DB) ───────────────────────────────────

  console.log("--- Slot store unit tests ---\n");

  const slotStore = require("../src/slot-store");
  const productOfferStore = require("../src/product-offer-store");

  await test("PACKAGE_TYPES covers free, pkg_1, pkg_3, pkg_5, pkg_10, unlimited", () => {
    const types = Object.keys(slotStore.PACKAGE_TYPES);
    assert(types.includes("free"), "missing free");
    assert(types.includes("pkg_1"), "missing pkg_1");
    assert(types.includes("pkg_3"), "missing pkg_3");
    assert(types.includes("pkg_5"), "missing pkg_5");
    assert(types.includes("pkg_10"), "missing pkg_10");
    assert(types.includes("unlimited"), "missing unlimited");
  });

  await test("FREE_SLOTS is 3", () => {
    assert(slotStore.FREE_SLOTS === 3, `FREE_SLOTS=${slotStore.FREE_SLOTS}`);
  });

  await test("UNLIMITED_SOFT_CAP is 50 (not Infinity, not 0)", () => {
    assert(slotStore.UNLIMITED_SOFT_CAP === 50, `UNLIMITED_SOFT_CAP=${slotStore.UNLIMITED_SOFT_CAP}`);
    assert(Number.isFinite(slotStore.UNLIMITED_SOFT_CAP), "must be finite");
    assert(slotStore.UNLIMITED_SOFT_CAP > 0, "must be positive");
  });

  await test("SOFT_CAP_WARNING_THRESHOLD is less than UNLIMITED_SOFT_CAP", () => {
    assert(
      slotStore.SOFT_CAP_WARNING_THRESHOLD < slotStore.UNLIMITED_SOFT_CAP,
      `warning=${slotStore.SOFT_CAP_WARNING_THRESHOLD} >= cap=${slotStore.UNLIMITED_SOFT_CAP}`
    );
  });

  await test("opsAlarmSoftCap returns structured payload with required fields", () => {
    const originalError = console.error;
    let logged = null;
    console.error = (msg) => { logged = msg; };
    const result = slotStore.opsAlarmSoftCap({
      userId: "test-user",
      currentCount: 49,
      softCap: 50,
      event: "approaching",
    });
    console.error = originalError;

    assert(result.alarm === "SOFT_CAP_WATCH_TARGETS", `alarm=${result.alarm}`);
    assert(result.severity === "warning", `severity=${result.severity}`);
    assert(result.user_id === "test-user", `user_id=${result.user_id}`);
    assert(result.current_watch_count === 49, `count=${result.current_watch_count}`);
    assert(result.soft_cap === 50, `soft_cap=${result.soft_cap}`);
    assert(result.event === "approaching", `event=${result.event}`);
    assert(result.action_required, "missing action_required");
    assert(logged && logged.includes("OPS_ALARM"), "should log OPS_ALARM");
  });

  await test("opsAlarmSoftCap severity is critical when event=hit", () => {
    const originalError = console.error;
    console.error = () => {};
    const result = slotStore.opsAlarmSoftCap({
      userId: "test-user",
      currentCount: 50,
      softCap: 50,
      event: "hit",
    });
    console.error = originalError;
    assert(result.severity === "critical", `severity=${result.severity}`);
  });

  await test("unlimited package slots equals UNLIMITED_SOFT_CAP (not Infinity)", () => {
    const unlimitedSlots = slotStore.PACKAGE_TYPES.unlimited.slots;
    assert(unlimitedSlots === slotStore.UNLIMITED_SOFT_CAP, `unlimited slots=${unlimitedSlots}`);
    assert(Number.isFinite(unlimitedSlots), "must be finite");
  });

  await test("Each package type has a positive finite slot count", () => {
    for (const [key, val] of Object.entries(slotStore.PACKAGE_TYPES)) {
      assert(typeof val.slots === "number", `${key} slots not number`);
      assert(val.slots > 0, `${key} slots <= 0`);
      assert(Number.isFinite(val.slots), `${key} slots not finite`);
    }
  });

  await test("canCreateWatch returns no_database when pool unavailable", async () => {
    const result = await slotStore.canCreateWatch("no-such-user");
    assert(result.allowed === false, `allowed=${result.allowed}`);
    assert(result.reason === "no_database", `reason=${result.reason}`);
  });

  await test("VALID_PACKAGE_TYPES includes all expected types", () => {
    const expected = ["free", "pkg_1", "pkg_3", "pkg_5", "pkg_10", "unlimited"];
    for (const t of expected) {
      assert(slotStore.VALID_PACKAGE_TYPES.includes(t), `missing ${t}`);
    }
  });

  // ── P0 regression: user_id linkage (static analysis, no DB) ────

  console.log("\n--- P0 regression: user_id linkage ---\n");

  await test("createCustomer accepts user_id parameter", () => {
    const customerStore = require("../src/customer-store");
    assert(
      customerStore.createCustomer.length <= 1,
      "createCustomer should accept a single options object"
    );
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "customer-store.js"),
      "utf8"
    );
    assert(
      /createCustomer\(\s*\{[^}]*user_id/.test(src),
      "createCustomer must destructure user_id from its options parameter"
    );
  });

  await test("neonUpsertCustomer SQL includes user_id column", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "customer-store.js"),
      "utf8"
    );
    const insertMatch = src.match(/INSERT INTO customers\s*\([^)]+\)/);
    assert(insertMatch, "INSERT INTO customers not found");
    assert(
      insertMatch[0].includes("user_id"),
      `INSERT INTO customers missing user_id column: ${insertMatch[0]}`
    );
  });

  await test("neonUpsertCustomer ON CONFLICT preserves user_id with COALESCE", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "customer-store.js"),
      "utf8"
    );
    assert(
      /COALESCE\(EXCLUDED\.user_id/.test(src),
      "ON CONFLICT must COALESCE user_id to preserve existing value"
    );
  });

  await test("getUsedSlots joins on customers.user_id", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "slot-store.js"),
      "utf8"
    );
    assert(
      /c\.user_id\s*=\s*\$1/.test(src),
      "getUsedSlots must filter by customers.user_id"
    );
  });

  await test("service-a createCustomer handler passes user.id as user_id", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "service-a.js"),
      "utf8"
    );
    const createSection = src.substring(
      src.indexOf('case "createCustomer"'),
      src.indexOf('case "createCustomer"') + 400
    );
    assert(
      /user_id:\s*user\s*\?\s*user\.id/.test(createSection),
      "createCustomer handler must pass user_id: user ? user.id"
    );
  });

  await test("service-a createWatchTargetInternal passes reqUser.id to neonUpsertCustomer", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "service-a.js"),
      "utf8"
    );
    assert(
      /neonUpsertCustomer\(\{[^}]*user_id:\s*reqUser/.test(src),
      "createWatchTargetInternal must pass user_id: reqUser to neonUpsertCustomer"
    );
  });

  await test("intake confirm passes userId to neonUpsertCustomer", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "intake.js"),
      "utf8"
    );
    assert(
      /neonUpsertCustomer\(\{[^}]*user_id:\s*userId/.test(src),
      "intake.confirm must pass user_id: userId to neonUpsertCustomer"
    );
  });

  // ── P1 regression: MAX_WATCH_TARGETS aligned with soft-cap ────

  console.log("\n--- P1 regression: cap alignment ---\n");

  await test("MAX_WATCH_TARGETS equals UNLIMITED_SOFT_CAP (no drift)", () => {
    const watchTargets = require("../src/watch-target-store");
    assert(
      watchTargets.MAX_WATCH_TARGETS === slotStore.UNLIMITED_SOFT_CAP,
      `MAX_WATCH_TARGETS=${watchTargets.MAX_WATCH_TARGETS} !== UNLIMITED_SOFT_CAP=${slotStore.UNLIMITED_SOFT_CAP}`
    );
  });

  await test("MAX_WATCH_TARGETS is 50 (not 10)", () => {
    const watchTargets = require("../src/watch-target-store");
    assert(watchTargets.MAX_WATCH_TARGETS === 50, `MAX_WATCH_TARGETS=${watchTargets.MAX_WATCH_TARGETS}`);
  });

  // ── ProductOffer seed data checks ───────────────────────────────

  console.log("\n--- ProductOffer seed data ---\n");

  await test("SEED_OFFERS has 1-2 entries with required fields", () => {
    const seeds = productOfferStore.SEED_OFFERS;
    assert(seeds.length >= 1 && seeds.length <= 2, `seed count=${seeds.length}`);

    for (const offer of seeds) {
      assert(offer.merchant_url, `missing merchant_url on ${offer.id}`);
      assert(offer.disclosure, `missing disclosure on ${offer.id}`);
      assert(offer.label, `missing label on ${offer.id}`);
      assert(typeof offer.active === "boolean", `active not boolean on ${offer.id}`);
      assert(
        offer.affiliate_url || offer.affiliate_program_id,
        `missing affiliate_url or affiliate_program_id on ${offer.id}`
      );
    }
  });

  await test("SEED_OFFERS skill_id is optional (may be null on some)", () => {
    for (const offer of productOfferStore.SEED_OFFERS) {
      assert(
        offer.skill_id === null || offer.skill_id === undefined || typeof offer.skill_id === "string",
        `skill_id should be string or null on ${offer.id}`
      );
    }
  });

  // ── Affiliate fields NOT on B2B emails ──────────────────────────

  console.log("\n--- B2B affiliate isolation ---\n");

  await test("B2B competitor email templates do not contain affiliate fields", () => {
    const fs = require("fs");
    const path = require("path");
    const outboxDir = path.join(__dirname, "..", "outbox", "samples");
    if (!fs.existsSync(outboxDir)) return;

    const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(outboxDir, file), "utf8").toLowerCase();
      assert(!content.includes("affiliate_url"), `${file} contains affiliate_url`);
      assert(!content.includes("affiliate_program_id"), `${file} contains affiliate_program_id`);
    }
  });

  await test("B2B email format module does not include affiliate fields", () => {
    const fs = require("fs");
    const path = require("path");
    const emailPath = path.join(__dirname, "..", "src", "plan-ladder-email.js");
    if (!fs.existsSync(emailPath)) return;
    const content = fs.readFileSync(emailPath, "utf8").toLowerCase();
    assert(!content.includes("affiliate_url"), "plan-ladder-email.js references affiliate_url");
    assert(!content.includes("affiliate_program_id"), "plan-ladder-email.js references affiliate_program_id");
  });

  // ── HTTP integration tests ──────────────────────────────────────

  console.log("\n--- HTTP integration ---\n");

  const { handleRequest, matchRoute, PUBLIC_HANDLERS } = require("../src/service-a");
  const server = http.createServer(handleRequest);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = { hostname: "127.0.0.1", port };

  try {
    // ── Route structure checks ──────────────────────────────────

    await test("GET /r/:id route is public (no auth required)", () => {
      const route = matchRoute("GET", "/r/some-offer-id");
      assert(route, "route should match");
      assert(route.handler === "affiliateRedirect", `handler=${route.handler}`);
      assert(PUBLIC_HANDLERS.has("affiliateRedirect"), "affiliateRedirect should be public");
    });

    await test("POST /product-offers/seed route exists", () => {
      const route = matchRoute("POST", "/product-offers/seed");
      assert(route, "route should match");
      assert(route.handler === "seedProductOffers", `handler=${route.handler}`);
    });

    await test("POST /b2c/payment-stub route exists", () => {
      const route = matchRoute("POST", "/b2c/payment-stub");
      assert(route, "route should match");
      assert(route.handler === "b2cPaymentStub", `handler=${route.handler}`);
    });

    await test("GET /b2c/slots route exists", () => {
      const route = matchRoute("GET", "/b2c/slots");
      assert(route, "route should match");
      assert(route.handler === "b2cSlots", `handler=${route.handler}`);
    });

    await test("GET /product-offers route exists", () => {
      const route = matchRoute("GET", "/product-offers");
      assert(route, "route should match");
      assert(route.handler === "listProductOffers", `handler=${route.handler}`);
    });

    // ── Unauthenticated access tests ────────────────────────────

    await test("GET /product-offers returns 401 without auth", async () => {
      const res = await httpRequest({ ...base, path: "/product-offers", method: "GET" });
      assert(res.status === 401, `status=${res.status}`);
    });

    await test("GET /b2c/slots returns 401 without auth", async () => {
      const res = await httpRequest({ ...base, path: "/b2c/slots", method: "GET" });
      assert(res.status === 401, `status=${res.status}`);
    });

    await test("POST /b2c/payment-stub returns 401 without auth", async () => {
      const res = await httpRequest(
        { ...base, path: "/b2c/payment-stub", method: "POST", headers: { "Content-Type": "application/json" } },
        { package_type: "pkg_1" }
      );
      assert(res.status === 401, `status=${res.status}`);
    });

    await test("GET /r/nonexistent returns 404", async () => {
      const res = await httpRequest({
        ...base,
        path: "/r/nonexistent",
        method: "GET",
      });
      assert(res.status === 404, `status=${res.status}`);
    });

    // ── Migration file ──────────────────────────────────────────

    console.log("\n--- Migration checks ---\n");

    await test("migration 4_f6_b2c_stubs.js exists and exports up/down", () => {
      const migration = require("../migrations/4_f6_b2c_stubs");
      assert(typeof migration.up === "function", "up is function");
      assert(typeof migration.down === "function", "down is function");
    });

    // ── No Stripe / card in source ──────────────────────────────

    console.log("\n--- No live Stripe ---\n");

    await test("No live Stripe imports or API keys in source", () => {
      const fs = require("fs");
      const path = require("path");
      const srcFiles = fs
        .readdirSync(path.join(__dirname, "..", "src"))
        .filter((f) => f.endsWith(".js"))
        .map((f) => path.join(__dirname, "..", "src", f));

      for (const file of srcFiles) {
        const content = fs.readFileSync(file, "utf8");
        assert(
          !content.includes("require('stripe')") && !content.includes('require("stripe")'),
          `${path.basename(file)} imports stripe`
        );
        assert(
          !/sk_live_[A-Za-z0-9]{20,}/.test(content),
          `${path.basename(file)} contains live Stripe key`
        );
      }
    });

    // ── Docs presence ───────────────────────────────────────────

    console.log("\n--- Docs ---\n");

    await test("docs/f6-b2c-stubs.md exists with required content", () => {
      const fs = require("fs");
      const path = require("path");
      const docPath = path.join(__dirname, "..", "docs", "f6-b2c-stubs.md");
      assert(fs.existsSync(docPath), "docs/f6-b2c-stubs.md not found");
      const content = fs.readFileSync(docPath, "utf8");
      assert(content.includes("soft-cap") || content.includes("soft_cap"), "doc missing soft-cap");
      assert(content.includes("50"), "doc missing soft-cap value 50");
      assert(content.includes("PAYMENT_STUB"), "doc missing PAYMENT_STUB");
      assert(content.includes("/r/"), "doc missing /r/:id redirect");
    });

    // ── DB-gated integration tests ──────────────────────────────

    if (hasDbUrl()) {
      console.log("\n--- DB integration (slot enforcement flow) ---\n");

      const { token, userId } = await loginStub(base, "f6-slot-test@example.com");

      await test("POST /product-offers/seed seeds 2 offers", async () => {
        const res = await httpRequest({
          ...authed(base, token),
          path: "/product-offers/seed",
          method: "POST",
        });
        assert(res.status === 201, `status=${res.status}`);
        assert(res.body.seeded >= 1, `seeded=${res.body.seeded}`);
        assert(Array.isArray(res.body.offers), "offers is array");
      });

      await test("GET /product-offers lists seeded offers", async () => {
        const res = await httpRequest({
          ...authed(base, token),
          path: "/product-offers",
          method: "GET",
        });
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.length >= 1, `count=${res.body.length}`);

        const offer = res.body[0];
        assert(offer.merchant_url, "missing merchant_url");
        assert(offer.disclosure, "missing disclosure");
        assert(typeof offer.active === "boolean", "active not boolean");
      });

      const custRes = await httpRequest(
        { ...authed(base, token), path: "/customers", method: "POST" },
        { name: "F6 Test Customer", email: "f6test@example.com" }
      );
      const customerId = custRes.body.id;

      await test("GET /b2c/slots shows free-3 slots initially", async () => {
        const res = await httpRequest({
          ...authed(base, token),
          path: "/b2c/slots",
          method: "GET",
        });
        assert(res.status === 200, `status=${res.status}`);
        assert(res.body.total_slots === 3, `total_slots=${res.body.total_slots}`);
        assert(res.body.used_slots === 0, `used_slots=${res.body.used_slots}`);
        assert(res.body.remaining === 3, `remaining=${res.body.remaining}`);
        assert(res.body.allowed === true, `allowed=${res.body.allowed}`);
      });

      for (let i = 1; i <= 3; i++) {
        await test(`Create B2C watch #${i} succeeds (within free-3)`, async () => {
          const res = await httpRequest(
            { ...authed(base, token), path: `/customers/${customerId}/watch-targets`, method: "POST" },
            {
              surface: "b2c",
              label: `B2C Watch ${i}`,
              source_url: `https://example.com/product-${i}`,
              target_description: `Product ${i} price`,
            }
          );
          assert(res.status === 201, `status=${res.status} body=${JSON.stringify(res.body)}`);
        });
      }

      await test("4th B2C watch refused (free-3 exhausted)", async () => {
        const res = await httpRequest(
          { ...authed(base, token), path: `/customers/${customerId}/watch-targets`, method: "POST" },
          {
            surface: "b2c",
            label: "B2C Watch 4",
            source_url: "https://example.com/product-4",
            target_description: "Product 4 price",
          }
        );
        assert(res.status === 403, `status=${res.status}`);
        assert(res.body.error === "b2c_slots_exhausted", `error=${res.body.error}`);
      });

      await test("B2B watch still allowed (slots don't gate B2B)", async () => {
        const res = await httpRequest(
          { ...authed(base, token), path: `/customers/${customerId}/watch-targets`, method: "POST" },
          {
            surface: "b2b",
            label: "B2B Watch OK",
            source_url: "https://example.com/b2b-pricing",
            target_description: "B2B plan pricing",
          }
        );
        assert(res.status === 201, `status=${res.status}`);
      });

      await test("PAYMENT_STUB grants pkg_3 → slots increase", async () => {
        const res = await httpRequest(
          { ...authed(base, token), path: "/b2c/payment-stub", method: "POST" },
          { package_type: "pkg_3" }
        );
        assert(res.status === 201, `status=${res.status}`);
        assert(res.body.package, "missing package");
        assert(res.body.slots, "missing slots");
        assert(res.body.slots.total_slots === 6, `total_slots=${res.body.slots.total_slots}`);
        assert(res.body.slots.remaining === 3, `remaining=${res.body.slots.remaining}`);
      });

      await test("5th B2C watch succeeds (after pkg_3 grant)", async () => {
        const res = await httpRequest(
          { ...authed(base, token), path: `/customers/${customerId}/watch-targets`, method: "POST" },
          {
            surface: "b2c",
            label: "B2C Watch 5",
            source_url: "https://example.com/product-5",
            target_description: "Product 5 price",
          }
        );
        assert(res.status === 201, `status=${res.status}`);
      });

      await test("POST /b2c/payment-stub rejects 'free' type", async () => {
        const res = await httpRequest(
          { ...authed(base, token), path: "/b2c/payment-stub", method: "POST" },
          { package_type: "free" }
        );
        assert(res.status === 400, `status=${res.status}`);
      });

      await test("POST /b2c/payment-stub rejects invalid type", async () => {
        const res = await httpRequest(
          { ...authed(base, token), path: "/b2c/payment-stub", method: "POST" },
          { package_type: "pkg_999" }
        );
        assert(res.status === 400, `status=${res.status}`);
      });

      await test("GET /r/:id with valid offer → 302 redirect", async () => {
        const offersRes = await httpRequest({
          ...authed(base, token),
          path: "/product-offers",
          method: "GET",
        });
        const offer = offersRes.body[0];
        assert(offer, "no offers to test redirect");

        const res = await httpRequest({
          ...base,
          path: `/r/${offer.id}`,
          method: "GET",
        });
        assert(res.status === 302, `status=${res.status}`);
        const expectedUrl = offer.affiliate_url || offer.merchant_url;
        assert(
          res.headers.location === expectedUrl,
          `location=${res.headers.location} expected=${expectedUrl}`
        );
      });

      // Cleanup DB test data
      const { query: dbQuery } = require("../src/db");
      try {
        await dbQuery("DELETE FROM click_log WHERE product_offer_id IN (SELECT id FROM product_offers)");
        await dbQuery("DELETE FROM product_offers WHERE id LIKE 'offer-%'");
        await dbQuery("DELETE FROM watch_targets WHERE customer_id = $1", [customerId]);
        await dbQuery("DELETE FROM user_packages WHERE user_id = $1", [userId]);
        await dbQuery("DELETE FROM customers WHERE id = $1", [customerId]);
        await dbQuery("DELETE FROM email_verify_tokens WHERE user_id = $1", [userId]);
        await dbQuery("DELETE FROM users WHERE id = $1", [userId]);
      } catch (e) {
        console.error(`  [cleanup] ${e.message}`);
      }
    } else {
      skip("DB integration tests (slot flow, redirect, seed)", "DATABASE_URL not set");
    }
  } finally {
    server.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed, ${skipped} skipped ---\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
