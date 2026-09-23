/**
 * Monitor library — Service C daily path (F3 stabilized).
 *
 * runMonitorCheck(skillId, opts) → result
 *
 * - One skill schema via skill-schema.normalizeSkill (lab + real-site)
 * - Single-price OR plans/prices (plan-ladder*) path
 * - failure_count increments on fetch_fail / blocked / extract_fail
 * - Empty/invalid extract NEVER writes a price snapshot
 * - Noise gate: single-price amount|currency|period; plans via diffPlanLadders
 * - 0 LLM
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { looksBlocked } = require("./steps/http-fetch");
const {
  normalizeSkill,
  isPlansSkill,
  isValidSinglePrice,
  isValidPlans,
} = require("./skill-schema");
const { recordFailure, recordSuccess } = require("./skill-failures");

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
  if (!sel || !sel.amount_attr) {
    throw new Error("DOM extract requires skill.selectors.amount_attr");
  }
  const amountMatch = body.match(new RegExp(`${sel.amount_attr}="([^"]+)"`));
  const currencyMatch = body.match(
    new RegExp(`${sel.currency_attr || "data-currency"}="([^"]+)"`)
  );
  const periodMatch = body.match(
    new RegExp(`${sel.period_attr || "data-period"}="([^"]+)"`)
  );

  if (!amountMatch) throw new Error("Could not extract amount from DOM");

  return {
    amount: parseFloat(amountMatch[1]),
    currency: currencyMatch ? currencyMatch[1].toUpperCase() : "USD",
    period: periodMatch ? periodMatch[1].toLowerCase() : "month",
  };
}

/**
 * Real-site skills store a regex with one capture group for the price amount.
 */
function extractViaRegex(body, skill) {
  if (!skill.regex) throw new Error("Regex extract requires skill.regex");
  const re = new RegExp(skill.regex, "i");
  const m = body.match(re);
  if (!m || m[1] === undefined) {
    throw new Error("Could not extract amount via skill.regex");
  }
  const amount = parseFloat(String(m[1]).replace(/,/g, ""));
  return {
    amount,
    currency: (skill.currency || "USD").toUpperCase(),
    period: (skill.period || "month").toLowerCase(),
  };
}

/**
 * Unified single-price extract from skill + response body.
 */
function extractSinglePrice(body, skill) {
  if (skill.method === "api") {
    return extractViaApi(body);
  }
  if (skill.method === "dom" || skill.method === "plans") {
    if (skill.selectors && skill.selectors.amount_attr) {
      return extractViaDom(body, skill);
    }
    if (skill.regex) {
      return extractViaRegex(body, skill);
    }
    throw new Error(
      "DOM skill missing selectors.amount_attr and regex — cannot extract"
    );
  }
  throw new Error(`Unsupported method: ${skill.method}`);
}

function loadLatestSnapshot(skillId) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshotFile = path.join(SNAPSHOTS_DIR, `${skillId}.json`);
  if (!fs.existsSync(snapshotFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  } catch {
    return null;
  }
}

function saveSnapshot(skillId, price) {
  if (!isValidSinglePrice(price)) {
    throw new Error("Refusing to persist invalid/empty price snapshot");
  }
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshot = {
    skill_id: skillId,
    checked_at: new Date().toISOString(),
    price: {
      amount: Number(price.amount),
      currency: (price.currency || "USD").toUpperCase(),
      period: (price.period || "month").toLowerCase(),
    },
  };
  const snapshotFile = path.join(SNAPSHOTS_DIR, `${skillId}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + "\n");
  return snapshotFile;
}

function priceChanged(prev, curr) {
  return (
    Number(prev.amount) !== Number(curr.amount) ||
    String(prev.currency).toUpperCase() !== String(curr.currency).toUpperCase() ||
    String(prev.period).toLowerCase() !== String(curr.period).toLowerCase()
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
  const target = skill.target_price_description;
  const now = new Date();

  let changeLine;
  if (!target || name === target) {
    changeLine = `We detected a price change for ${target || name}.`;
  } else {
    changeLine = `We detected a price change for ${target} on ${name}.`;
  }

  const email = {
    type: "price_change",
    skill_id: skill.id,
    customer_id: customerInfo ? customerInfo.customerId : null,
    customer_email: customerInfo ? customerInfo.customerEmail : null,
    customer_name: customerInfo ? customerInfo.customerName : null,
    base_url: skill.base_url || skill.pricing_url,
    target,
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
      changeLine,
      "",
      `  Before: ${formatDisplay(before)}`,
      `  After:  ${formatDisplay(after)}`,
      "",
      friendlyPricingLink(skill),
      "",
      `Detected ${formatJerusalemTime(now)}.`,
      "",
      "Questions? Reply to this email or write price.watcher.service@gmail.com.",
      "",
      "— PriceWatch",
    ].join("\n"),
  };

  fs.writeFileSync(emailPath, JSON.stringify(email, null, 2) + "\n");
  return emailPath;
}

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

function loadSkill(skillId) {
  const skillPath = path.join(SKILLS_DIR, `${skillId}.json`);
  if (!fs.existsSync(skillPath)) return null;
  return JSON.parse(fs.readFileSync(skillPath, "utf8"));
}

function loadSkillByPath(skillPath) {
  const fullPath = path.resolve(__dirname, "..", skillPath);
  if (!fs.existsSync(fullPath)) return null;
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function failResult(skillId, status, error, customerInfo, extra = {}) {
  const failMeta = recordFailure(skillId, {
    skillPath: extra.skillPath,
    pricingUrl: extra.pricingUrl,
    target: extra.target,
    reason: status,
  });
  const opsAlertPath = writeOpsAlert(
    skillId,
    `${error} (failure_count=${failMeta.failure_count})`,
    customerInfo
  );
  return {
    status,
    error,
    opsAlertPath,
    failure_count: failMeta.failure_count,
    skill_status: failMeta.skill_status,
    rediscoveryQueued: failMeta.rediscoveryQueued,
    snapshotPath: null,
    ...extra.resultFields,
  };
}

/**
 * Plans/prices path — uses plan-ladder* modules (lazy require to avoid cycles).
 */
async function runPlansMonitorCheck(skill, opts = {}) {
  const t0 = Date.now();
  const customerInfo = opts.customerInfo || null;
  const skillId = skill.id;
  const pricingUrl = skill.pricing_url;

  const { extractPlanLadder } = require("./plan-ladder");
  const {
    saveLadderSnapshot,
    loadLadderSnapshot,
  } = require("./plan-ladder-snapshot");
  const { diffPlanLadders, filterBySelection } = require("./plan-ladder-diff");
  const { writePlanLadderEmail } = require("./plan-ladder-email");
  const { loadSelection } = require("./plan-selection");

  let result;
  try {
    result = await extractPlanLadder(pricingUrl);
  } catch (err) {
    return {
      ...failResult(skillId, "fetch_fail", `Plans fetch/extract threw: ${err.message}`, customerInfo, {
        skillPath: opts.skillPath,
        pricingUrl,
        target: skill.target_price_description,
      }),
      wallMs: Date.now() - t0,
    };
  }

  if (result.error && String(result.error).startsWith("fetch_failed")) {
    return {
      ...failResult(skillId, "fetch_fail", result.error, customerInfo, {
        skillPath: opts.skillPath,
        pricingUrl,
        target: skill.target_price_description,
      }),
      wallMs: Date.now() - t0,
    };
  }

  // Blocked detection: extractPlanLadder uses fetchHtml which throws on block;
  // also treat empty plans as extract_fail (never baseline empty).
  if (!isValidPlans(result.plans)) {
    return {
      ...failResult(
        skillId,
        "extract_fail",
        result.error || "empty_or_invalid_plans",
        customerInfo,
        {
          skillPath: opts.skillPath,
          pricingUrl,
          target: skill.target_price_description,
        }
      ),
      wallMs: Date.now() - t0,
    };
  }

  const site = result.site || skill.site || "unknown";
  const prev = loadLadderSnapshot(site);

  // Selected plan_key → single-plan compare (still via plans extract)
  const planKey = skill.plan_key || skill.plan_name;
  if (planKey && skill.extract_mode !== "plans_all") {
    const match = result.plans.find(
      (p) => String(p.plan).toLowerCase() === String(planKey).toLowerCase()
    );
    if (!match || !isValidPriceAmountSafe(match.price)) {
      if (match && match.price === null) {
        recordSuccess(skillId, { skillPath: opts.skillPath });
        const snapshotPath = saveLadderSnapshot(site, result.plans);
        if (!prev) {
          return {
            status: "no_email",
            reason: "first_run",
            plans: result.plans,
            snapshotPath,
            wallMs: Date.now() - t0,
          };
        }
        return {
          status: "no_email",
          reason: "unchanged_custom",
          plans: result.plans,
          snapshotPath,
          wallMs: Date.now() - t0,
        };
      }
      return {
        ...failResult(
          skillId,
          "extract_fail",
          `Selected plan "${planKey}" not found or invalid price`,
          customerInfo,
          { skillPath: opts.skillPath, pricingUrl }
        ),
        wallMs: Date.now() - t0,
      };
    }

    recordSuccess(skillId, { skillPath: opts.skillPath });
    const snapshotPath = saveLadderSnapshot(site, result.plans);
    const currentPrice = {
      amount: Number(match.price),
      currency: (match.currency || "USD").toUpperCase(),
      period: billingToPeriod(match.billing),
    };
    const previousSnapshot = (() => {
      if (!prev) return null;
      const oldPlan = (prev.plans || []).find(
        (p) => String(p.plan).toLowerCase() === String(planKey).toLowerCase()
      );
      if (!oldPlan || !isValidPriceAmountSafe(oldPlan.price)) return null;
      return {
        price: {
          amount: Number(oldPlan.price),
          currency: (oldPlan.currency || "USD").toUpperCase(),
          period: billingToPeriod(oldPlan.billing),
        },
      };
    })();
    const singleSnap = saveSnapshot(skillId, currentPrice);

    return finishSingleCompare({
      skill,
      skillId,
      currentPrice,
      previousSnapshot,
      snapshotPath: singleSnap,
      customerInfo,
      t0,
      extra: { plans: result.plans, ladderSnapshotPath: snapshotPath },
    });
  }

  recordSuccess(skillId, { skillPath: opts.skillPath });
  const snapshotPath = saveLadderSnapshot(site, result.plans);

  // Full plans diff + noise gate
  if (!prev) {
    return {
      status: "no_email",
      reason: "first_run",
      plans: result.plans,
      snapshotPath,
      wallMs: Date.now() - t0,
    };
  }

  let { changes, hasSignal } = diffPlanLadders(prev.plans, result.plans);
  const selection = loadSelection(site);
  if (selection) {
    changes = filterBySelection(changes, selection);
    hasSignal = changes.length > 0;
  }

  if (!hasSignal) {
    return {
      status: "no_email",
      reason: "unchanged",
      plans: result.plans,
      changes,
      snapshotPath,
      wallMs: Date.now() - t0,
    };
  }

  const emailPath = writePlanLadderEmail(
    site,
    pricingUrl,
    changes,
    customerInfo
  );
  return {
    status: "price_changed",
    reason: "plans_signal",
    plans: result.plans,
    changes,
    emailPath,
    snapshotPath,
    wallMs: Date.now() - t0,
  };
}

function isValidPriceAmountSafe(amount) {
  if (amount === null || amount === undefined || amount === "") return false;
  const n = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(n);
}

function billingToPeriod(billing) {
  const b = String(billing || "monthly").toLowerCase();
  if (b === "monthly" || b === "month") return "month";
  if (b === "yearly" || b === "annual" || b === "year") return "year";
  if (b === "free") return "month";
  return b;
}

function finishSingleCompare({
  skill,
  skillId,
  currentPrice,
  previousSnapshot,
  snapshotPath,
  customerInfo,
  t0,
  extra = {},
}) {
  if (!previousSnapshot) {
    return {
      status: "no_email",
      reason: "first_run",
      currentPrice,
      snapshotPath,
      wallMs: Date.now() - t0,
      ...extra,
    };
  }
  const prevPrice = previousSnapshot.price;
  if (!priceChanged(prevPrice, currentPrice)) {
    return {
      status: "no_email",
      reason: "unchanged",
      currentPrice,
      snapshotPath,
      wallMs: Date.now() - t0,
      ...extra,
    };
  }
  const emailPath = writePriceChangeEmail(
    skill,
    prevPrice,
    currentPrice,
    customerInfo
  );
  return {
    status: "price_changed",
    before: prevPrice,
    after: currentPrice,
    emailPath,
    snapshotPath,
    wallMs: Date.now() - t0,
    ...extra,
  };
}

async function runMonitorCheck(skillId, opts = {}) {
  const t0 = Date.now();
  const customerInfo = opts.customerInfo || null;

  let raw = opts.skill || loadSkill(skillId);
  if (!raw && opts.skillPath) {
    raw = loadSkillByPath(opts.skillPath);
  }
  if (!raw) {
    const error = `Skill not found: ${skillId}`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "error", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  const skill = normalizeSkill(raw);
  if (!skill.id) skill.id = skillId;

  // Allow tick / opts to force plans mode
  if (opts.mode === "plans" || opts.extract_mode === "plans") {
    skill.method = "plans";
    skill.extract_mode = "plans";
  }

  const pricingUrl = skill.pricing_url;
  if (!pricingUrl) {
    const error = `Skill ${skillId} has no pricing_url`;
    const opsAlertPath = writeOpsAlert(skillId, error, customerInfo);
    return { status: "error", error, opsAlertPath, wallMs: Date.now() - t0 };
  }

  if (isPlansSkill(skill)) {
    return runPlansMonitorCheck(skill, { ...opts, skillPath: opts.skillPath });
  }

  let res;
  try {
    res = await httpGet(pricingUrl, 15_000);
  } catch (err) {
    return {
      ...failResult(
        skillId,
        "fetch_fail",
        `Fetch failed for ${pricingUrl}: ${err.message}`,
        customerInfo,
        {
          skillPath: opts.skillPath,
          pricingUrl,
          target: skill.target_price_description,
        }
      ),
      wallMs: Date.now() - t0,
    };
  }

  if (res.status !== 200) {
    return {
      ...failResult(
        skillId,
        "fetch_fail",
        `HTTP ${res.status} from ${pricingUrl}`,
        customerInfo,
        {
          skillPath: opts.skillPath,
          pricingUrl,
          target: skill.target_price_description,
        }
      ),
      wallMs: Date.now() - t0,
    };
  }

  const blockReason = looksBlocked(res.status, res.body);
  if (blockReason) {
    return {
      ...failResult(
        skillId,
        "blocked",
        `Blocked: ${blockReason} at ${pricingUrl}`,
        customerInfo,
        {
          skillPath: opts.skillPath,
          pricingUrl,
          target: skill.target_price_description,
        }
      ),
      wallMs: Date.now() - t0,
    };
  }

  let currentPrice;
  try {
    currentPrice = extractSinglePrice(res.body, skill);
  } catch (err) {
    return {
      ...failResult(
        skillId,
        "extract_fail",
        `Extract failed for ${skillId}: ${err.message}`,
        customerInfo,
        {
          skillPath: opts.skillPath,
          pricingUrl,
          target: skill.target_price_description,
        }
      ),
      wallMs: Date.now() - t0,
    };
  }

  if (!isValidSinglePrice(currentPrice)) {
    return {
      ...failResult(
        skillId,
        "extract_fail",
        `Empty/invalid price extract for ${skillId}`,
        customerInfo,
        {
          skillPath: opts.skillPath,
          pricingUrl,
          target: skill.target_price_description,
        }
      ),
      wallMs: Date.now() - t0,
    };
  }

  // Normalize numeric amount
  currentPrice = {
    amount: Number(currentPrice.amount),
    currency: (currentPrice.currency || "USD").toUpperCase(),
    period: (currentPrice.period || "month").toLowerCase(),
  };

  recordSuccess(skillId, { skillPath: opts.skillPath });

  const lastSnapshot = loadLatestSnapshot(skillId);
  const snapshotPath = saveSnapshot(skillId, currentPrice);

  return finishSingleCompare({
    skill,
    skillId,
    currentPrice,
    previousSnapshot: lastSnapshot,
    snapshotPath,
    customerInfo,
    t0,
  });
}

module.exports = {
  runMonitorCheck,
  runPlansMonitorCheck,
  loadSkill,
  loadSkillByPath,
  writePriceChangeEmail,
  writeOpsAlert,
  loadLatestSnapshot,
  saveSnapshot,
  priceChanged,
  extractSinglePrice,
  extractViaApi,
  extractViaDom,
  extractViaRegex,
  friendlyName,
  formatJerusalemTime,
  formatDisplay,
  isLocalUrl,
  friendlyPricingLink,
  SKILLS_DIR,
  SNAPSHOTS_DIR,
  OUTBOX_DIR,
};
