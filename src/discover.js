#!/usr/bin/env node
"use strict";

/**
 * PriceWatch unified discovery CLI.
 *
 * Lab path  (§7.2): API /price.json + DOM data-attributes → monitor-compatible skill
 * Real-site path (§7.5): site-specific HTTP+DOM extractors → detailed skill
 *
 * Routing: if the URL is a known real site (or HTTPS to a non-localhost host
 * without a /price.json endpoint), the §7.5 ladder runs. Otherwise the lab
 * path runs, preserving full backward compatibility with monitor.js and
 * scripts/run-7.2.sh.
 *
 * Usage:
 *   node src/discover.js <url> "<target_description>"
 *
 * Examples:
 *   node src/discover.js http://127.0.0.1:3847 "main monthly price"
 *   node src/discover.js https://plausible.io/ "Starter plan monthly USD ~10k pageviews"
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SKILLS_DIR = path.resolve(__dirname, "..", "data", "skills");

// ─── Shared helpers ─────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════
//  LAB PATH — backward-compatible with monitor.js and run-7.2.sh
// ═══════════════════════════════════════════════════════════════════════════

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

async function tryApiDiscovery(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/price.json";
  const res = await httpGet(url, 10_000);
  if (res.status !== 200) return null;

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    return null;
  }

  if (typeof json.amount !== "number") return null;

  return {
    method: "api",
    pricing_url: url,
    json_path: "$.amount",
    normalize: {
      currency_field: "$.currency",
      period_field: "$.period",
    },
    extracted: normalizePrice(json),
  };
}

async function tryDomDiscovery(baseUrl) {
  const url = baseUrl.replace(/\/+$/, "") + "/";
  const res = await httpGet(url, 15_000);
  if (res.status !== 200) return null;

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

async function runLabDiscovery(baseUrl, targetDesc) {
  console.log(`Discovering price at ${baseUrl} for target: "${targetDesc}"`);

  let result = null;
  let step = null;

  console.log("  Step 1: trying API path /price.json ...");
  try {
    result = await tryApiDiscovery(baseUrl);
    if (result) step = 1;
  } catch (e) {
    console.log(`  Step 1 failed: ${e.message}`);
  }

  if (!result) {
    console.log("  Step 2: trying DOM with data attributes ...");
    try {
      result = await tryDomDiscovery(baseUrl);
      if (result) step = 2;
    } catch (e) {
      console.log(`  Step 2 failed: ${e.message}`);
    }
  }

  if (!result) {
    console.error("Discovery failed: could not extract price via API or DOM.");
    process.exit(2);
  }

  const id = labSkillId(baseUrl, targetDesc);
  const skill = {
    id,
    version: 1,
    created_at: new Date().toISOString(),
    base_url: baseUrl,
    target_price_description: targetDesc,
    discovery_step: step,
    method: result.method,
    pricing_url: result.pricing_url,
    confidence: result.method === "api" ? 0.99 : 0.9,
    ...(result.json_path && { json_path: result.json_path }),
    ...(result.selectors && { selectors: result.selectors }),
    normalize: result.normalize || {
      currency_field: result.selectors
        ? result.selectors.currency_attr
        : "$.currency",
      period_field: result.selectors
        ? result.selectors.period_attr
        : "$.period",
    },
    initial_price: result.extracted,
  };

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const skillPath = path.join(SKILLS_DIR, `${id}.json`);
  fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2) + "\n");

  console.log(`  Step ${step} succeeded (method: ${result.method})`);
  console.log(`  Price: $${result.extracted.amount}/${result.extracted.period}`);
  console.log(`  Skill written: ${skillPath}`);
  console.log(`  Skill ID: ${id}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  REAL-SITE PATH — §7.5 discovery ladder with site-specific extractors
// ═══════════════════════════════════════════════════════════════════════════

const { runStep0 } = require("./steps/step0-reuse");
const { runStep2 } = require("./steps/step2-http-dom");
const { saveSkill } = require("./skill-store");

const REAL_SITE_STEPS = [
  { id: 0, name: "reuse-skill", maxMs: 5000,  maxPages: 0, fn: runStep0 },
  { id: 2, name: "http-dom",    maxMs: 15000, maxPages: 1, fn: runStep2 },
];

async function runRealSiteDiscovery(url, target) {
  console.log(`\n=== PriceWatch Discovery ===`);
  console.log(`URL:    ${url}`);
  console.log(`Target: ${target}\n`);

  const result = {
    url,
    target,
    success: false,
    step: null,
    method: null,
    extracted: null,
    skillPath: null,
    llmTokens: 0,
    error: null,
    wallMs: 0,
  };

  const t0 = Date.now();

  for (const step of REAL_SITE_STEPS) {
    console.log(`[step ${step.id}] ${step.name} — trying…`);
    const stepStart = Date.now();
    try {
      const out = await Promise.race([
        step.fn({ url, target }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), step.maxMs)
        ),
      ]);
      const elapsed = Date.now() - stepStart;
      console.log(`[step ${step.id}] elapsed ${elapsed}ms — ${out ? "hit" : "miss"}`);

      if (out && out.price !== undefined) {
        result.success = true;
        result.step = step.id;
        result.method = step.name;
        result.extracted = out;
        result.llmTokens = out.llmTokens || 0;
        result.wallMs = Date.now() - t0;

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
        result.skillPath = skillPath;
        console.log(`[success] step ${step.id} → skill saved: ${skillPath}`);
        break;
      }
    } catch (err) {
      console.log(`[step ${step.id}] error: ${err.message}`);
      if (err.message === "blocked") {
        result.error = "blocked";
        break;
      }
    }
  }

  if (!result.success && !result.error) {
    result.error = "all_steps_exhausted";
  }
  result.wallMs = Date.now() - t0;

  console.log("\n--- Result ---");
  console.log(JSON.stringify(result, null, 2));

  if (!result.success) {
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Router — pick lab vs real-site path
// ═══════════════════════════════════════════════════════════════════════════

function isLabUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      u.protocol === "http:" && /^(\d+\.){3}\d+$/.test(host)
    );
  } catch {
    return true;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      "Usage: node src/discover.js <url> <target_price_description>"
    );
    console.error(
      '  Lab:  node src/discover.js http://127.0.0.1:3847 "main monthly price"'
    );
    console.error(
      '  Real: node src/discover.js https://plausible.io/ "Starter plan monthly USD ~10k pageviews"'
    );
    process.exit(1);
  }

  const url = args[0];
  const target = args.slice(1).join(" ");

  if (isLabUrl(url)) {
    await runLabDiscovery(url, target);
  } else {
    await runRealSiteDiscovery(url, target);
  }
}

main().catch((err) => {
  console.error("discover error:", err.message);
  process.exit(1);
});
