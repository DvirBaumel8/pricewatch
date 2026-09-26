/**
 * Intake module (F4 / CB-13/14).
 *
 * preview(url, intentText?) → structured candidates[]
 * confirm(url, selected, userId, customerId) → WatchTarget(s) + skill + baseline
 *
 * Rules:
 *   - No URL → reject
 *   - Allowlist/catalog gate: lab URLs always allowed; supported domains allowed;
 *     everything else → honest unsupported
 *   - intent_text ranks/sorts only — never invents prices
 *   - 0 LLM on preview/confirm/daily path
 *   - Confirm creates WatchTarget + skill + baseline; NO customer email on first learn
 *   - Select none by default (client must send selected plan_keys)
 *
 * Token budget: 0 LLM.
 */
"use strict";

const { extractPlanLadder, extractPlansFromHtml } = require("./plan-ladder");
const { saveLadderSnapshot } = require("./plan-ladder-snapshot");
const { saveSkill, skillId } = require("./skill-store");
const watchTargets = require("./watch-target-store");
const customers = require("./customer-store");

const SUPPORTED_DOMAINS = Object.freeze([
  "plausible.io",
  "linear.app",
  "notion.com",
  "vercel.com",
  "slack.com",
  "shopify.com",
]);

function isLabUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.pathname === "/pricing"
    );
  } catch {
    return false;
  }
}

function isSupportedUrl(url) {
  if (isLabUrl(url)) return true;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return SUPPORTED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return false;
  }
}

function rankByIntent(candidates, intentText) {
  if (!intentText || !intentText.trim()) return candidates;
  const lower = intentText.toLowerCase().trim();
  const scored = candidates.map((c) => {
    const name = (c.name || "").toLowerCase();
    const key = (c.plan_key || "").toLowerCase();
    let score = 0;
    if (name === lower || key === lower) score = 3;
    else if (name.includes(lower) || key.includes(lower)) score = 2;
    else if (lower.includes(name) || lower.includes(key)) score = 1;
    return { ...c, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored.map(({ _score, ...rest }) => rest);
}

/**
 * Preview: fetch URL, extract candidate plans/prices.
 * Returns { candidates[], url, site, error?, warnings? }.
 */
async function preview(url, intentText) {
  if (!url || typeof url !== "string" || !url.trim()) {
    return { candidates: null, url: null, error: "url_required" };
  }

  const trimmed = url.trim();

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { candidates: null, url: trimmed, error: "invalid_url" };
  }

  if (!isSupportedUrl(trimmed)) {
    return {
      candidates: null,
      url: trimmed,
      site: parsed.hostname.replace(/^www\./, ""),
      error: "unsupported_site",
    };
  }

  const result = await extractPlanLadder(trimmed);

  if (result.error) {
    return {
      candidates: null,
      url: trimmed,
      site: result.site,
      error: result.error,
    };
  }

  if (!result.plans || result.plans.length === 0) {
    return {
      candidates: null,
      url: trimmed,
      site: result.site,
      error: "extract_empty",
    };
  }

  let candidates = result.plans.map((p) => ({
    plan_key: p.plan_key || p.plan.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: p.plan,
    price: p.price,
    currency: p.currency || "USD",
    period: p.billing || p.period || "month",
  }));

  candidates = rankByIntent(candidates, intentText);

  return {
    candidates,
    url: trimmed,
    site: result.site,
    method: result.method,
    tokens: 0,
  };
}

/**
 * Preview from raw HTML (for offline/test use).
 */
function previewFromHtml(html, url, intentText) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { candidates: null, url, error: "invalid_url" };
  }

  const plans = extractPlansFromHtml(html, parsed.hostname, parsed.pathname);

  if (!plans || plans.length === 0) {
    return {
      candidates: null,
      url,
      site: parsed.hostname.replace(/^www\./, ""),
      error: "extract_empty",
    };
  }

  let candidates = plans.map((p) => ({
    plan_key: p.plan_key || p.plan.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: p.plan,
    price: p.price,
    currency: p.currency || "USD",
    period: p.billing || p.period || "month",
  }));

  candidates = rankByIntent(candidates, intentText);

  return {
    candidates,
    url,
    site: parsed.hostname.replace(/^www\./, ""),
    method: "dom",
    tokens: 0,
  };
}

/**
 * Confirm: create WatchTarget(s) + skill + baseline for selected plan(s).
 *
 * @param {string} url
 * @param {Array<{plan_key: string, threshold?: number}>} selected
 * @param {string} userId - authenticated user id
 * @param {string} customerId - customer to attach watches to
 * @param {object} [previewResult] - optional cached preview candidates
 * @returns {{ watch_targets: object[], skills: string[], baselines: string[], error?: string }}
 */
async function confirm(url, selected, userId, customerId, previewResult) {
  if (!url || typeof url !== "string" || !url.trim()) {
    return { error: "url_required" };
  }
  if (!Array.isArray(selected) || selected.length === 0) {
    return { error: "selected_required" };
  }
  if (!customerId) {
    return { error: "customer_id_required" };
  }

  const trimmed = url.trim();

  if (!isSupportedUrl(trimmed)) {
    return { error: "unsupported_site" };
  }

  let candidates;
  if (previewResult && previewResult.candidates) {
    candidates = previewResult.candidates;
  } else {
    const pr = await preview(trimmed);
    if (pr.error) return { error: pr.error };
    candidates = pr.candidates;
  }

  if (!candidates || candidates.length === 0) {
    return { error: "no_candidates" };
  }

  const selectedKeys = new Set(selected.map((s) => s.plan_key));
  const matched = candidates.filter((c) => selectedKeys.has(c.plan_key));

  if (matched.length === 0) {
    return { error: "no_matching_plans", detail: "None of the selected plan_keys match preview candidates" };
  }

  const customer = await customers.getCustomer(customerId);
  if (!customer) {
    return { error: "customer_not_found" };
  }

  const parsed = new URL(trimmed);
  const hostname = parsed.hostname.replace(/^www\./, "");
  const site = isLabUrl(trimmed) ? "lab-multiplan" : hostname;

  const createdTargets = [];
  const createdSkills = [];
  const createdBaselines = [];

  for (const plan of matched) {
    const sid = skillId(trimmed, plan.plan_key);

    const baselinePlans = candidates.map((c) => ({
      plan: c.name,
      plan_key: c.plan_key,
      price: c.price,
      currency: c.currency,
      billing: c.period,
      selected: selectedKeys.has(c.plan_key),
    }));

    const skillPath = await saveSkill({
      url: trimmed,
      target: plan.plan_key,
      site,
      planName: plan.name,
      planKey: plan.plan_key,
      method: "plans",
      extract_mode: "plans",
      step: "step2-http-dom",
      price: plan.price,
      currency: plan.currency,
      period: plan.period,
      baseline: baselinePlans,
    });

    const snapshotPath = saveLadderSnapshot(site, baselinePlans);

    if (watchTargets.dbAvailable()) {
      await customers.neonUpsertCustomer({
        id: customer.id,
        name: customer.name,
        email: customer.email,
        user_id: userId || null,
      });

      const result = await watchTargets.create({
        customer_id: customerId,
        surface: "b2b",
        label: plan.name,
        source_url: trimmed,
        target_description: `${plan.name} plan — ${plan.price !== null ? plan.currency + " " + plan.price : "custom"} / ${plan.period}`,
        plan_key: plan.plan_key,
        skill_id: sid,
        status: "skill_ready",
      });

      if (result.error) {
        return { error: result.error, limit: result.limit };
      }

      createdTargets.push(result.watchTarget);
    } else {
      const wtId = watchTargets.generateId();
      createdTargets.push({
        id: wtId,
        customer_id: customerId,
        surface: "b2b",
        label: plan.name,
        source_url: trimmed,
        target_description: `${plan.name} plan — ${plan.price !== null ? plan.currency + " " + plan.price : "custom"} / ${plan.period}`,
        plan_key: plan.plan_key,
        skill_id: sid,
        status: "skill_ready",
        failure_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        _storage: "file",
      });
    }

    createdSkills.push(skillPath);
    createdBaselines.push(snapshotPath);
  }

  return {
    watch_targets: createdTargets,
    skills: createdSkills,
    baselines: createdBaselines,
    first_learn: true,
  };
}

module.exports = {
  preview,
  previewFromHtml,
  confirm,
  isLabUrl,
  isSupportedUrl,
  rankByIntent,
  SUPPORTED_DOMAINS,
};
