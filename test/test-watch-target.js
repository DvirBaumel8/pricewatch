#!/usr/bin/env node
"use strict";

/**
 * F2 proof: create customer + B2B WatchTarget in Neon → GET readable.
 *
 * Requires DATABASE_URL or DATABASE_URL_NODE.
 * Without secrets: exit 0 + SKIP (CI-safe).
 * With secrets but DB error: exit 1 (fail closed).
 */

const path = require("path");

function hasDbUrl() {
  for (const key of ["DATABASE_URL", "DATABASE_URL_NODE"]) {
    const v = process.env[key];
    if (v && String(v).trim()) return true;
  }
  return false;
}

async function main() {
  console.log("\n=== F2 WatchTarget Neon create→GET ===\n");

  if (!hasDbUrl()) {
    console.log(
      "SKIP: DATABASE_URL / DATABASE_URL_NODE not set — Neon proof not run."
    );
    console.log(
      "  Set secrets (e.g. source /home/box/secrets/pricewatch.env) and re-run:"
    );
    console.log("  npm run test:watch-target\n");
    process.exit(0);
  }

  const customers = require("../src/customer-store");
  const watchTargets = require("../src/watch-target-store");
  const { closePool } = require("../src/db");

  if (!watchTargets.dbAvailable()) {
    console.error("FAIL: DB URL set but pool unavailable");
    process.exit(1);
  }

  const stamp = Date.now().toString(36);
  let customerId;
  let watchId;

  try {
    const customer = await customers.createCustomer({
      name: `F2 Chris proof ${stamp}`,
      email: `f2-proof-${stamp}@example.com`,
    });
    customerId = customer.id;
    console.log(`  ✓ create customer ${customerId}`);

    const created = await watchTargets.create({
      customer_id: customerId,
      surface: "b2b",
      label: "F2 Lab Target",
      source_url: "http://127.0.0.1:3847/",
      target_description: "Pro monthly",
      plan_key: null,
    });
    if (created.error) {
      throw new Error(`create WatchTarget failed: ${JSON.stringify(created)}`);
    }
    watchId = created.watchTarget.id;
    console.log(`  ✓ create WatchTarget ${watchId} surface=b2b`);

    const got = await watchTargets.getById(watchId);
    if (!got) throw new Error("GET by id returned null");
    if (got.id !== watchId) throw new Error("id mismatch");
    if (got.customer_id !== customerId) throw new Error("customer_id mismatch");
    if (got.surface !== "b2b") throw new Error("surface mismatch");
    if (got.label !== "F2 Lab Target") throw new Error("label mismatch");
    if (got.status !== "pending_onboarding") throw new Error("status mismatch");
    console.log(`  ✓ GET /watch-targets/:id matches create`);

    const listed = await watchTargets.listByCustomer(customerId);
    if (!listed.find((w) => w.id === watchId)) {
      throw new Error("listByCustomer missing created row");
    }
    console.log(`  ✓ listByCustomer includes row`);

    // Competitor shim mapping
    const shape = watchTargets.toCompetitorShape(got);
    if (shape.id !== got.id || shape.name !== got.label) {
      throw new Error("competitor shape mapping broken");
    }
    console.log(`  ✓ competitor shim mapping (id/label)`);

    // Shim path via customer-store.addCompetitor
    const shim = await customers.addCompetitor(customerId, {
      name: "Shim Comp",
      pricingUrl: "http://127.0.0.1:3847/pricing",
      targetPriceDescription: "Starter",
    });
    if (shim.error) throw new Error(`shim addCompetitor: ${shim.error}`);
    if (!shim.watchTarget || shim.watchTarget.surface !== "b2b") {
      throw new Error("shim did not return WatchTarget surface=b2b");
    }
    const shimGot = await watchTargets.getById(shim.competitor.id);
    if (!shimGot) throw new Error("shim competitor id not in Neon");
    console.log(`  ✓ POST competitors shim → Neon WatchTarget ${shimGot.id}`);

    console.log("\nPASS: F2 create→GET against Neon\n");
    process.exitCode = 0;
  } catch (err) {
    console.error("\nFAIL:", err.message);
    process.exitCode = 1;
  } finally {
    // Cleanup proof rows (best-effort)
    try {
      const { query } = require("../src/db");
      if (watchId) {
        await query("DELETE FROM watch_targets WHERE customer_id = $1", [
          customerId,
        ]);
      }
      if (customerId) {
        await query("DELETE FROM customers WHERE id = $1", [customerId]);
      }
    } catch (_) {
      /* ignore cleanup errors */
    }
    await closePool().catch(() => {});
  }
}

main();
