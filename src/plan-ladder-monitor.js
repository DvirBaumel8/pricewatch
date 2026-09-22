#!/usr/bin/env node
"use strict";

/**
 * Plan-ladder monitor — full pipeline:
 *   1. Extract plan ladder from pricing URL
 *   2. Load previous snapshot
 *   3. Diff → noise gate
 *   4. If signal → write customer email to outbox
 *   5. Save new snapshot
 *
 * Usage:
 *   node src/plan-ladder-monitor.js <pricing_url>
 *   node src/plan-ladder-monitor.js --allowlist   # run all allowlisted sites
 *
 * Exit codes: 0 success, 1 error, 2 no plans extracted
 */

const { extractPlanLadder } = require("./plan-ladder");
const { saveLadderSnapshot, loadLadderSnapshot } = require("./plan-ladder-snapshot");
const { diffPlanLadders } = require("./plan-ladder-diff");
const { writePlanLadderEmail } = require("./plan-ladder-email");

const ALLOWLIST = [
  { url: "https://vercel.com/pricing", site: "vercel.com" },
  { url: "https://linear.app/pricing", site: "linear.app" },
  { url: "https://www.notion.com/pricing", site: "notion.com" },
  { url: "https://plausible.io/", site: "plausible.io" },
  { url: "https://slack.com/pricing", site: "slack.com" },
  { url: "https://www.shopify.com/pricing", site: "shopify.com" },
];

async function runOne(url, opts = {}) {
  const t0 = Date.now();
  const result = await extractPlanLadder(url);

  if (result.error || !result.plans || result.plans.length === 0) {
    return {
      url,
      site: result.site,
      status: "extract_fail",
      error: result.error || "no_plans",
      plans: null,
      changes: null,
      hasSignal: false,
      emailPath: null,
      snapshotPath: null,
      method: result.method,
      tokens: result.tokens,
      wallMs: Date.now() - t0,
    };
  }

  const site = result.site;
  const prev = loadLadderSnapshot(site);
  const snapshotPath = saveLadderSnapshot(site, result.plans);

  if (!prev) {
    return {
      url,
      site,
      status: "baseline",
      error: null,
      plans: result.plans,
      changes: null,
      hasSignal: false,
      emailPath: null,
      snapshotPath,
      method: result.method,
      tokens: result.tokens,
      wallMs: Date.now() - t0,
    };
  }

  const { changes, hasSignal } = diffPlanLadders(prev.plans, result.plans);

  if (!hasSignal) {
    return {
      url,
      site,
      status: "no_signal",
      error: null,
      plans: result.plans,
      changes,
      hasSignal: false,
      emailPath: null,
      snapshotPath,
      method: result.method,
      tokens: result.tokens,
      wallMs: Date.now() - t0,
    };
  }

  const emailPath = writePlanLadderEmail(
    site,
    url,
    changes,
    opts.customerInfo || null
  );

  return {
    url,
    site,
    status: "signal",
    error: null,
    plans: result.plans,
    changes,
    hasSignal: true,
    emailPath,
    snapshotPath,
    method: result.method,
    tokens: result.tokens,
    wallMs: Date.now() - t0,
  };
}

async function runAllowlist(opts = {}) {
  const results = [];
  for (const entry of ALLOWLIST) {
    console.log(`\n--- ${entry.site} (${entry.url}) ---`);
    try {
      const r = await runOne(entry.url, opts);
      results.push(r);
      console.log(`  status: ${r.status}`);
      if (r.plans) console.log(`  plans:  ${r.plans.length}`);
      if (r.error) console.log(`  error:  ${r.error}`);
      if (r.emailPath) console.log(`  email:  ${r.emailPath}`);
      console.log(`  method: ${r.method}, tokens: ${r.tokens}, wallMs: ${r.wallMs}`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.push({
        url: entry.url,
        site: entry.site,
        status: "error",
        error: err.message,
      });
    }
  }
  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "--allowlist") {
    runAllowlist()
      .then((results) => {
        const passed = results.filter(
          (r) => r.plans && r.plans.length > 0
        ).length;
        console.log(`\n=== Allowlist: ${passed}/${results.length} extracted plans ===`);
        if (passed < 4) {
          console.error("FAIL: <4/5 extracted (W1 threshold)");
          process.exit(1);
        }
      })
      .catch((err) => {
        console.error("Allowlist error:", err.message);
        process.exit(1);
      });
  } else if (args.length >= 1) {
    runOne(args[0])
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        if (r.status === "extract_fail") process.exit(2);
      })
      .catch((err) => {
        console.error("Monitor error:", err.message);
        process.exit(1);
      });
  } else {
    console.error("Usage: node src/plan-ladder-monitor.js <url> | --allowlist");
    process.exit(1);
  }
}

module.exports = { runOne, runAllowlist, ALLOWLIST };
