#!/usr/bin/env node
"use strict";

/**
 * verify-tip-sha.js — Compare Service A deploy tip SHA to local main HEAD.
 *
 * Modes:
 *   Live     : fetches GET <SERVICE_A_URL>/health, reads git_sha field.
 *   Stub     : reads STUB_TIP_SHA env instead of hitting the network.
 *
 * Usage:
 *   SERVICE_A_URL=https://pricewatch.onrender.com  node scripts/verify-tip-sha.js
 *   STUB_TIP_SHA=abc123                            node scripts/verify-tip-sha.js
 *   npm run verify:tip-sha                         (uses SERVICE_A_URL from env)
 *   STUB_TIP_SHA=$(git rev-parse HEAD) npm run verify:tip-sha   (stub match)
 *
 * Exit codes:
 *   0 — SHAs match
 *   1 — SHAs differ (deploy is stale or wrong branch)
 *   2 — could not determine one or both SHAs
 */

const { execSync } = require("child_process");

async function getDeployTip() {
  const stub = process.env.STUB_TIP_SHA;
  if (stub) {
    console.log("[verify] Using STUB_TIP_SHA (no network).");
    return stub.trim();
  }

  const url = process.env.SERVICE_A_URL;
  if (!url) {
    console.error("[verify] Set SERVICE_A_URL or STUB_TIP_SHA.");
    return null;
  }

  const healthUrl = url.replace(/\/+$/, "") + "/health";
  console.log(`[verify] GET ${healthUrl}`);

  let res;
  try {
    res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    console.error(`[verify] Fetch failed: ${e.message}`);
    return null;
  }

  if (!res.ok) {
    console.error(`[verify] HTTP ${res.status} from ${healthUrl}`);
    return null;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    console.error("[verify] Non-JSON response from /health");
    return null;
  }

  if (!body.git_sha || body.git_sha === "unknown") {
    console.error("[verify] /health response has no git_sha (deploy may predate this change).");
    return null;
  }
  return body.git_sha;
}

function getMainHead() {
  if (process.env.MAIN_SHA) return process.env.MAIN_SHA.trim();
  try {
    return execSync("git rev-parse origin/main", { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    try {
      return execSync("git rev-parse main", { encoding: "utf8", timeout: 5000 }).trim();
    } catch {
      try {
        return execSync("git rev-parse HEAD", { encoding: "utf8", timeout: 5000 }).trim();
      } catch (e) {
        console.error(`[verify] Cannot resolve main HEAD: ${e.message}`);
        return null;
      }
    }
  }
}

async function main() {
  const deployTip = await getDeployTip();
  const mainHead = getMainHead();

  console.log(`[verify] Deploy tip : ${deployTip || "(unavailable)"}`);
  console.log(`[verify] main HEAD  : ${mainHead || "(unavailable)"}`);

  if (!deployTip || !mainHead) {
    console.error("[verify] FAIL — could not resolve both SHAs.");
    process.exit(2);
  }

  const tipShort = deployTip.slice(0, 12);
  const mainShort = mainHead.slice(0, 12);

  if (mainHead.startsWith(deployTip) || deployTip.startsWith(mainHead)) {
    console.log(`[verify] PASS — deploy tip ${tipShort} matches main ${mainShort}`);
    process.exit(0);
  } else {
    console.error(`[verify] MISMATCH — deploy tip ${tipShort} ≠ main ${mainShort}`);
    process.exit(1);
  }
}

main();
