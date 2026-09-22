/**
 * Monitor library — extracted from src/monitor.js for reuse by Service C.
 *
 * runMonitorCheck(skillId, opts) → { status, before, after, emailPath, snapshotPath, error }
 *
 * 0 LLM on lab happy path. Reuses existing extract/snapshot/diff logic.
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { looksBlocked } = require("./steps/http-fetch");

const SKILLS_DIR = path.resolve(__dirname, "..", "data", "skills");
const SNAPSHOTS_DIR = path.resolve(__dirname, "..", "data", "snapshots");
const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");

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

function extractViaApi(body) {
  const json = JSON.parse(body);
  return {
    amount: json.amount,
    currency: (json.currency || "USD").toUpperCase(),
    period: (json.period || "month").toLowerCase(),
  };
}

function extractViaDom(body, skill) {
  const sel = skill.selectors;
  const amountMatch = body.match(new RegExp(`${sel.amount_attr}="([^"]+)"`));
  const currencyMatch = body.match(new RegExp(`${sel.currency_attr}="([^"]+)"`));
  const periodMatch = body.match(new RegExp(`${sel.period_attr}="([^"]+)"`));

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

function priceChanged(prev, curr) {
  return (
    prev.amount !== curr.amount ||
    prev.currency !== curr.currency ||
    prev.period !== curr.period
  );
}

function formatDisplay(price) {
  return `$${price.amount}/${price.period === "month" ? "mo" : price.period}`;
}

function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url || "");
}

function friendlyName(skill) {
  if (skill.site) return skill.site;
  const url = skill.base_url || skill.pricing_url || "";
  if (isLocalUrl(url)) {
    return skill.target_price_description || "the site you're watching";
  }
  try {
    return new URL(url).hostname;
  } catch {
    return skill.target_price_description || "the site you're watching";
  }
}

function friendlyPricingLink(skill) {
  const url = skill.pricing_url || skill.base_url || "";
  if (isLocalUrl(url)) return "Your monitored pricing page";
  return `Open pricing page: ${url}`;
}

function formatJerusalemTime(date) {
  const d = date || new Date();
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Jerusalem",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function writePriceChangeEmail(skill, before, after, customerInfo) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `price-change_${skill.id}_${ts}.json`;
  const emailPath = path.join(OUTBOX_DIR, filename);

  const name = friendlyName(skill);
  const now = new Date();

  const email = {
    type: "price_change",
    skill_id: skill.id,
    customer_id: customerInfo ? customerInfo.customerId : null,
    customer_email: customerInfo ? customerInfo.customerEmail : null,
    customer_name: customerInfo ? customerInfo.customerName : null,
    base_url: skill.base_url || skill.pricing_url,
    target: skill.target_price_description,
    timestamp: now.toISOString(),
    before: {
      amount: before.amount,
      currency: before.currency,
      period: before.period,
      display: formatDisplay(before),
    },
    after: {
      amount: after.amount,
      currency: after.currency,
      period: after.period,
      display: formatDisplay(after),
    },
    subject: `PriceWatch: ${name} changed`,
    body: [
      `Hi${customerInfo && customerInfo.customerName ? ` ${customerInfo.customerName}` : ""},`,
      "",
      `We detected a price change for ${skill.target_price_description} at ${name}.`,
      "",
      `  Before: ${formatDisplay(before)}`,
      `  After:  ${formatDisplay(after)}`,
      "",
      friendlyPricingLink(skill),
      "",
      `Detected ${formatJerusalemTime(now)}.`,
      "",
      "— PriceWatch",
    ].join("\n"),
  };

  fs.writeFileSync(emailPath, JSON.stringify(email, null, 2) + "\n");
  return emailPath;
}

/**
 * Write an ops alert to the outbox (not customer-facing).
 */
function writeOpsAlert(skillId, error, customerInfo) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `ops-alert_${skillId}_${ts}.json`;
  const alertPath = path.join(OUTBOX_DIR, filename);

  const alert = {
    type: "ops_alert",
    skill_id: skillId,
    customer_id: customerInfo ? customerInfo.customerId : null,
    timestamp: new Date().toISOString(),
    error: error,
    subject: `[OPS] Monitor failed for skill ${skillId}`,
    body: `Monitor check failed for skill ${skillId}: ${error}`,
  };

  fs.writeFileSync(alertPath, JSON.stringify(alert, null, 2) + "\n");
  return alertPath;
}

/**
 * Load a skill by its ID. Searches SKILLS_DIR for <skillId>.json.
 */
function loadSkill(skillId) {
  const skillPath = path.join(SKILLS_DIR, `${skillId}.json`);
  if (!fs.existsSync(skillPath)) return null;
  return JSON.parse(fs.readFileSync(skillPath, "utf8"));
}

/**
 * Load a skill by its file path (relative to project root).
 */
function loadSkillByPath(skillPath) {
  const fullPath = path.resolve(__dirname, "..", skillPath);
  if (!fs.existsSync(fullPath)) return null;
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

/**
 * Run a single monitor check for a skill. Returns a result object.
 *
 * @param {string} skillId - skill file basename (without .json)
 * @param {object} opts
 * @param {object} opts.customerInfo - { customerId, customerEmail, customerName }
 * @param {object} opts.skill - pre-loaded skill object (optional; will load from disk if omitted)
 * @returns {{ status, before, after, emailPath, opsAlertPath, snapshotPath, error }}
 */
async function runMonitorCheck(skillId, opts = {}) {
  const t0 = Date.now();
  const customerInfo = opts.customerInfo || null;

  let skill = opts.skill || loadSkill(skillId);
  if (!skill && opts.skillPath) {
    skill = loadSkillByPath(opts.skillPath);
  }
  if (!skill) {
    const error = `Skill not found: ${skillId}`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "error", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  const pricingUrl = skill.pricing_url;
  if (!pricingUrl) {
    const error = `Skill ${skillId} has no pricing_url`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "error", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  let res;
  try {
    res = await httpGet(pricingUrl, 15_000);
  } catch (err) {
    const error = `Fetch failed for ${pricingUrl}: ${err.message}`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "fetch_fail", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  if (res.status !== 200) {
    const error = `HTTP ${res.status} from ${pricingUrl}`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "fetch_fail", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  const blockReason = looksBlocked(res.status, res.body);
  if (blockReason) {
    const error = `Blocked: ${blockReason} at ${pricingUrl}`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "blocked", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  let currentPrice;
  try {
    if (skill.method === "api") {
      currentPrice = extractViaApi(res.body);
    } else if (skill.method === "dom") {
      currentPrice = extractViaDom(res.body, skill);
    } else {
      throw new Error(`Unsupported method: ${skill.method}`);
    }
  } catch (err) {
    const error = `Extract failed for ${skillId}: ${err.message}`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "extract_fail", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  const lastSnapshot = loadLatestSnapshot(skillId);
  const snapshotPath = saveSnapshot(skillId, currentPrice);

  if (!lastSnapshot) {
    return {
      status: "no_email",
      reason: "first_run",
      currentPrice,
      snapshotPath,
      wallMs: Date.now() - t0,
    };
  }

  const prevPrice = lastSnapshot.price;

  if (!priceChanged(prevPrice, currentPrice)) {
    return {
      status: "no_email",
      reason: "unchanged",
      currentPrice,
      snapshotPath,
      wallMs: Date.now() - t0,
    };
  }

  const emailPath = writePriceChangeEmail(skill, prevPrice, currentPrice, customerInfo);
  return {
    status: "price_changed",
    before: prevPrice,
    after: currentPrice,
    emailPath,
    snapshotPath,
    wallMs: Date.now() - t0,
  };
}

module.exports = {
  runMonitorCheck,
  loadSkill,
  loadSkillByPath,
  writePriceChangeEmail,
  writeOpsAlert,
  loadLatestSnapshot,
  saveSnapshot,
  priceChanged,
  friendlyName,
  formatJerusalemTime,
  formatDisplay,
  SKILLS_DIR,
  SNAPSHOTS_DIR,
  OUTBOX_DIR,
};
