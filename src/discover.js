#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SKILLS_DIR = path.resolve(__dirname, "..", "data", "skills");

function usage() {
  console.error(
    "Usage: node src/discover.js <base_url> <target_price_description>"
  );
  console.error(
    '  e.g. node src/discover.js http://127.0.0.1:3847 "main monthly price"'
  );
  process.exit(1);
}

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

function skillId(baseUrl, target) {
  const hash = crypto
    .createHash("sha256")
    .update(`${baseUrl}|${target}`)
    .digest("hex")
    .slice(0, 12);
  return hash;
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();

  const baseUrl = args[0];
  const targetDesc = args.slice(1).join(" ");

  console.log(`Discovering price at ${baseUrl} for target: "${targetDesc}"`);

  let result = null;
  let step = null;

  // Step 1: API (0 LLM tokens, ≤10s, 1 page load)
  console.log("  Step 1: trying API path /price.json ...");
  try {
    result = await tryApiDiscovery(baseUrl);
    if (result) step = 1;
  } catch (e) {
    console.log(`  Step 1 failed: ${e.message}`);
  }

  // Step 2: DOM (0 LLM tokens, ≤15s, 1 page load)
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

  const id = skillId(baseUrl, targetDesc);
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

main().catch((err) => {
  console.error("discover error:", err.message);
  process.exit(1);
});
