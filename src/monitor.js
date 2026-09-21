#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.resolve(__dirname, "..", "data", "skills");
const SNAPSHOTS_DIR = path.resolve(__dirname, "..", "data", "snapshots");
const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");

function usage() {
  console.error("Usage: node src/monitor.js <skill_id>");
  console.error("  skill_id: the ID from data/skills/<id>.json");
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

function extractViaApi(body, skill) {
  const json = JSON.parse(body);
  return {
    amount: json.amount,
    currency: (json.currency || "USD").toUpperCase(),
    period: (json.period || "month").toLowerCase(),
  };
}

function extractViaDom(body, skill) {
  const sel = skill.selectors;
  const amountMatch = body.match(
    new RegExp(`${sel.amount_attr}="([^"]+)"`)
  );
  const currencyMatch = body.match(
    new RegExp(`${sel.currency_attr}="([^"]+)"`)
  );
  const periodMatch = body.match(
    new RegExp(`${sel.period_attr}="([^"]+)"`)
  );

  if (!amountMatch) throw new Error("Could not extract amount from DOM");

  return {
    amount: parseFloat(amountMatch[1]),
    currency: currencyMatch ? currencyMatch[1].toUpperCase() : "USD",
    period: periodMatch ? periodMatch[1].toLowerCase() : "month",
  };
}

function loadLatestSnapshot(skillId) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshotFile = path.join(SNAPSHOTS_DIR, `${skillId}.json`);
  if (!fs.existsSync(snapshotFile)) return null;
  return JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
}

function saveSnapshot(skillId, price) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshot = {
    skill_id: skillId,
    checked_at: new Date().toISOString(),
    price,
  };
  const snapshotFile = path.join(SNAPSHOTS_DIR, `${skillId}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + "\n");
  return snapshotFile;
}

function writeEmail(skill, before, after) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `price-change_${skill.id}_${ts}.json`;
  const emailPath = path.join(OUTBOX_DIR, filename);

  const email = {
    type: "price_change",
    skill_id: skill.id,
    base_url: skill.base_url,
    target: skill.target_price_description,
    timestamp: new Date().toISOString(),
    before: {
      amount: before.amount,
      currency: before.currency,
      period: before.period,
      display: `$${before.amount}/${before.period === "month" ? "mo" : before.period}`,
    },
    after: {
      amount: after.amount,
      currency: after.currency,
      period: after.period,
      display: `$${after.amount}/${after.period === "month" ? "mo" : after.period}`,
    },
    subject: `Price changed: ${skill.target_price_description} at ${skill.base_url}`,
    body: [
      `The ${skill.target_price_description} at ${skill.base_url} has changed.`,
      "",
      `  Before: $${before.amount}/${before.period === "month" ? "mo" : before.period}`,
      `  After:  $${after.amount}/${after.period === "month" ? "mo" : after.period}`,
      "",
      `Detected at ${new Date().toISOString()}.`,
    ].join("\n"),
  };

  fs.writeFileSync(emailPath, JSON.stringify(email, null, 2) + "\n");
  return emailPath;
}

function priceChanged(prev, curr) {
  return (
    prev.amount !== curr.amount ||
    prev.currency !== curr.currency ||
    prev.period !== curr.period
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const skillId = args[0];
  const skillPath = path.join(SKILLS_DIR, `${skillId}.json`);

  if (!fs.existsSync(skillPath)) {
    console.error(`Skill not found: ${skillPath}`);
    process.exit(2);
  }

  const skill = JSON.parse(fs.readFileSync(skillPath, "utf8"));
  console.log(
    `Monitor: checking ${skill.base_url} (skill ${skillId}, method: ${skill.method})`
  );

  const res = await httpGet(skill.pricing_url, 15_000);
  if (res.status !== 200) {
    console.error(`Fetch failed: HTTP ${res.status}`);
    process.exit(3);
  }

  let currentPrice;
  if (skill.method === "api") {
    currentPrice = extractViaApi(res.body, skill);
  } else if (skill.method === "dom") {
    currentPrice = extractViaDom(res.body, skill);
  } else {
    console.error(`Unsupported skill method: ${skill.method}`);
    process.exit(4);
  }

  console.log(
    `  Current price: $${currentPrice.amount}/${currentPrice.period}`
  );

  const lastSnapshot = loadLatestSnapshot(skillId);

  if (!lastSnapshot) {
    console.log("  No previous snapshot — saving baseline, no email.");
    saveSnapshot(skillId, currentPrice);
    console.log("RESULT: no_email (first_run)");
    return;
  }

  const prevPrice = lastSnapshot.price;
  console.log(
    `  Last snapshot: $${prevPrice.amount}/${prevPrice.period} (${lastSnapshot.checked_at})`
  );

  if (!priceChanged(prevPrice, currentPrice)) {
    console.log("  Price unchanged — no email.");
    saveSnapshot(skillId, currentPrice);
    console.log("RESULT: no_email");
    return;
  }

  console.log(
    `  PRICE CHANGED: $${prevPrice.amount} → $${currentPrice.amount}`
  );
  const emailPath = writeEmail(skill, prevPrice, currentPrice);
  saveSnapshot(skillId, currentPrice);
  console.log(`  Email written: ${emailPath}`);
  console.log("RESULT: email_sent");
}

main().catch((err) => {
  console.error("monitor error:", err.message);
  process.exit(1);
});
