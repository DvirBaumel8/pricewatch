#!/usr/bin/env node
"use strict";

/**
 * Service B — onboarding worker.
 *
 * Consumes jobs from pendingCustomerOnboardingRequests queue,
 * runs the existing discovery ladder (src/discover.js logic),
 * writes skill via skill-store OR marks unsupported/needs_ceo,
 * and marks job done/failed with reason.
 *
 * Usage:
 *   node scripts/run-onboarding-worker.js          # process one job, exit
 *   node scripts/run-onboarding-worker.js --watch   # poll for jobs with sleep
 */

const path = require("path");
const queue = require("../src/queue");
const customerStore = require("../src/customer-store");
const { loadSkill, saveSkill, SKILLS_DIR } = require("../src/skill-store");
const fs = require("fs");

const WATCH_MODE = process.argv.includes("--watch");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || "5000", 10);

// ─── Discovery adapter ────────────────────────────────────────────
// Reuses the discovery ladder from src/discover.js without spawning
// a subprocess. We import the key functions directly.

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { looksBlocked, fetchHtml } = require("../src/steps/http-fetch");
const { runStep0 } = require("../src/steps/step0-reuse");
const { runStep2 } = require("../src/steps/step2-http-dom");

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP GET timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

function labSkillId(baseUrl, target) {
  return crypto
    .createHash("sha256")
    .update(`${baseUrl}|${target}`)
    .digest("hex")
    .slice(0, 12);
}

function normalizePrice(raw) {
  const amount = parseFloat(raw.amount);
  if (isNaN(amount)) return null;
  return {
    amount,
    currency: (raw.currency || "USD").toUpperCase(),
    period: (raw.period || "month").toLowerCase(),
  };
}

function isLabUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      (u.protocol === "http:" && /^(\d+\.){3}\d+$/.test(host))
    );
  } catch {
    return true;
  }
}

// ─── Lab discovery (same as discover.js lab path, as importable fn) ──

async function tryApiDiscovery(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/price.json";
  const res = await httpGet(url, 10_000);
  if (res.status !== 200) return null;
  const blocked = looksBlocked(res.status, res.body);
  if (blocked) throw new Error(`blocked: ${blocked}`);
  let json;
  try { json = JSON.parse(res.body); } catch { return null; }
  if (typeof json.amount !== "number") return null;
  return {
    method: "api",
    pricing_url: url,
    json_path: "$.amount",
    normalize: { currency_field: "$.currency", period_field: "$.period" },
    extracted: normalizePrice(json),
  };
}

async function tryDomDiscovery(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/";
  const res = await httpGet(url, 15_000);
  if (res.status !== 200) return null;
  const blocked = looksBlocked(res.status, res.body);
  if (blocked) throw new Error(`blocked: ${blocked}`);
  const amountMatch = res.body.match(/data-amount="([^"]+)"/);
  const currencyMatch = res.body.match(/data-currency="([^"]+)"/);
  const periodMatch = res.body.match(/data-period="([^"]+)"/);
  if (!amountMatch) return null;
  const extracted = normalizePrice({
    amount: amountMatch[1],
    currency: currencyMatch ? currencyMatch[1] : "USD",
    period: periodMatch ? periodMatch[1] : "month",
  });
  if (!extracted) return null;
  return {
    method: "dom",
    pricing_url: url,
    selectors: {
      container: "#price",
      amount_attr: "data-amount",
      currency_attr: "data-currency",
      period_attr: "data-period",
    },
    extracted,
  };
}

// ─── Unified discovery runner for the worker ─────────────────────

async function runDiscovery(url, target) {
  const t0 = Date.now();
  const result = {
    success: false,
    step: null,
    method: null,
    skillPath: null,
    error: null,
    wallMs: 0,
  };

  if (isLabUrl(url)) {
    // Step 0: check global skill reuse
    const existingSkill = loadSkillForUrl(url, target);
    if (existingSkill) {
      console.log(`  [B] Step 0: reusing existing skill`);
      result.success = true;
      result.step = 0;
      result.method = "reuse";
      result.skillPath = existingSkill.path;
      result.wallMs = Date.now() - t0;
      return result;
    }

    // Step 1: API
    console.log(`  [B] Step 1: trying API /price.json ...`);
    try {
      const apiResult = await tryApiDiscovery(url);
      if (apiResult) {
        const id = labSkillId(url, target);
        const skill = buildLabSkill(id, url, target, 1, apiResult);
        const skillPath = writeLabSkill(id, skill);
        result.success = true;
        result.step = 1;
        result.method = "api";
        result.skillPath = skillPath;
        result.wallMs = Date.now() - t0;
        return result;
      }
    } catch (e) {
      console.log(`  [B] Step 1 failed: ${e.message}`);
    }

    // Step 2: DOM
    console.log(`  [B] Step 2: trying DOM data attributes ...`);
    try {
      const domResult = await tryDomDiscovery(url);
      if (domResult) {
        const id = labSkillId(url, target);
        const skill = buildLabSkill(id, url, target, 2, domResult);
        const skillPath = writeLabSkill(id, skill);
        result.success = true;
        result.step = 2;
        result.method = "dom";
        result.skillPath = skillPath;
        result.wallMs = Date.now() - t0;
        return result;
      }
    } catch (e) {
      console.log(`  [B] Step 2 failed: ${e.message}`);
    }

    result.error = "all_steps_exhausted";
    result.wallMs = Date.now() - t0;
    return result;
  }

  // Real site path — use step0-reuse and step2-http-dom from existing modules
  const STEPS = [
    { id: 0, name: "reuse-skill", maxMs: 5000, fn: runStep0 },
    { id: 2, name: "http-dom", maxMs: 15000, fn: runStep2 },
  ];

  for (const step of STEPS) {
    console.log(`  [B] Step ${step.id}: ${step.name} ...`);
    const stepStart = Date.now();
    try {
      const out = await Promise.race([
        step.fn({ url, target }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), step.maxMs)
        ),
      ]);
      const elapsed = Date.now() - stepStart;
      console.log(`  [B] Step ${step.id}: elapsed ${elapsed}ms — ${out ? "hit" : "miss"}`);

      if (out && out.price !== undefined) {
        const skillPath = saveSkill({
          url,
          target,
          method: step.name === "http-dom" ? "dom" : out.method || step.name,
          step: step.id,
          price: out.price,
          currency: out.currency || "USD",
          period: out.period || "month",
          perUnit: out.perUnit || null,
          selector: out.selector || null,
          regex: out.regex || null,
          jsonPath: out.jsonPath || null,
          confidence: out.confidence || "high",
          site: out.site || new URL(url).hostname.replace(/^www\./, ""),
          planName: out.planName || null,
          notes: out.notes || null,
        });
        result.success = true;
        result.step = step.id;
        result.method = step.name;
        result.skillPath = skillPath;
        result.wallMs = Date.now() - t0;
        return result;
      }
    } catch (err) {
      console.log(`  [B] Step ${step.id} error: ${err.message}`);
      if (err.message === "blocked") {
        result.error = "blocked";
        result.wallMs = Date.now() - t0;
        return result;
      }
    }
  }

  result.error = "all_steps_exhausted";
  result.wallMs = Date.now() - t0;
  return result;
}

// ─── Lab skill helpers ────────────────────────────────────────────

function loadSkillForUrl(url, target) {
  const id = labSkillId(url, target);
  const skillPath = path.join(SKILLS_DIR, `${id}.json`);
  if (fs.existsSync(skillPath)) {
    return { skill: JSON.parse(fs.readFileSync(skillPath, "utf8")), path: path.relative(path.join(__dirname, ".."), skillPath) };
  }
  // Also check real-site skill-store
  const realSkill = loadSkill(url, target);
  if (realSkill) {
    const { slugify } = require("../src/skill-store");
    const host = new URL(url).hostname.replace(/^www\./, "");
    const fname = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + ".json";
    return { skill: realSkill, path: `data/skills/${fname}` };
  }
  return null;
}

function buildLabSkill(id, baseUrl, target, step, discoveryResult) {
  return {
    id,
    version: 1,
    created_at: new Date().toISOString(),
    base_url: baseUrl,
    target_price_description: target,
    discovery_step: step,
    method: discoveryResult.method,
    pricing_url: discoveryResult.pricing_url,
    confidence: discoveryResult.method === "api" ? 0.99 : 0.9,
    ...(discoveryResult.json_path && { json_path: discoveryResult.json_path }),
    ...(discoveryResult.selectors && { selectors: discoveryResult.selectors }),
    normalize: discoveryResult.normalize || {
      currency_field: discoveryResult.selectors
        ? discoveryResult.selectors.currency_attr
        : "$.currency",
      period_field: discoveryResult.selectors
        ? discoveryResult.selectors.period_attr
        : "$.period",
    },
    initial_price: discoveryResult.extracted,
  };
}

function writeLabSkill(id, skill) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const skillPath = path.join(SKILLS_DIR, `${id}.json`);
  fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2) + "\n");
  return path.relative(path.join(__dirname, ".."), skillPath);
}

// ─── Process one job ──────────────────────────────────────────────

async function processJob(job) {
  console.log(`\n[B] Processing job ${job.id}`);
  console.log(`    Customer: ${job.customerId}`);
  console.log(`    Competitor: ${job.competitorName} (${job.competitorId})`);
  console.log(`    URL: ${job.pricingUrl}`);
  console.log(`    Target: ${job.targetPriceDescription}`);

  if (!job.pricingUrl) {
    console.log(`  [B] No pricing URL — marking unsupported`);
    queue.complete(job.id, {
      status: "failed",
      result: "unsupported",
      reason: "no_pricing_url",
    });
    customerStore.updateCompetitorStatus(job.customerId, job.competitorId, {
      status: "unsupported",
    });
    return;
  }

  try {
    const discoveryResult = await runDiscovery(job.pricingUrl, job.targetPriceDescription);

    if (discoveryResult.success) {
      console.log(`  [B] Discovery succeeded: step ${discoveryResult.step}, method ${discoveryResult.method}`);
      console.log(`  [B] Skill path: ${discoveryResult.skillPath}`);
      console.log(`  [B] Wall time: ${discoveryResult.wallMs}ms`);

      queue.complete(job.id, {
        status: "done",
        result: "skill_ready",
        reason: `step_${discoveryResult.step}_${discoveryResult.method}`,
        skillPath: discoveryResult.skillPath,
      });
      customerStore.updateCompetitorStatus(job.customerId, job.competitorId, {
        status: "skill_ready",
        skillPath: discoveryResult.skillPath,
      });
    } else {
      const status = discoveryResult.error === "blocked" ? "unsupported" : "needs_ceo";
      const reason = discoveryResult.error || "unknown";
      console.log(`  [B] Discovery failed: ${reason} → marking ${status}`);

      queue.complete(job.id, {
        status: "failed",
        result: status,
        reason,
      });
      customerStore.updateCompetitorStatus(job.customerId, job.competitorId, {
        status,
      });
    }
  } catch (err) {
    console.error(`  [B] Unexpected error: ${err.message}`);
    queue.complete(job.id, {
      status: "failed",
      result: "error",
      reason: err.message,
    });
    customerStore.updateCompetitorStatus(job.customerId, job.competitorId, {
      status: "error",
    });
  }
}

// ─── Main loop ────────────────────────────────────────────────────

async function runOnce() {
  const job = queue.dequeue();
  if (!job) {
    console.log("[B] No pending jobs.");
    return false;
  }
  await processJob(job);
  return true;
}

async function runWatch() {
  console.log(`[B] Watch mode — polling every ${POLL_INTERVAL_MS}ms (Ctrl+C to stop)`);
  let running = true;
  process.on("SIGINT", () => {
    console.log("\n[B] Received SIGINT, shutting down...");
    running = false;
  });
  process.on("SIGTERM", () => {
    console.log("\n[B] Received SIGTERM, shutting down...");
    running = false;
  });

  while (running) {
    const hadWork = await runOnce();
    if (!hadWork && running) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  console.log("[B] Worker stopped.");
}

async function main() {
  console.log("[Service B] Onboarding worker starting");
  if (WATCH_MODE) {
    await runWatch();
  } else {
    const pending = queue.pendingCount();
    console.log(`[B] ${pending} pending job(s) in queue`);
    let processed = 0;
    while (true) {
      const hadWork = await runOnce();
      if (!hadWork) break;
      processed++;
    }
    console.log(`[B] Processed ${processed} job(s). Exiting.`);
  }
}

main().catch((err) => {
  console.error("[B] Fatal error:", err.message);
  process.exit(1);
});
