/**
 * Unified skill schema (F3 / CB-4).
 *
 * Lab skills historically used: selectors + normalize + initial_price (no failure_count).
 * Real-site skills used: selector + regex + price + failure_count (no selectors/normalize).
 *
 * normalizeSkill(raw) → canonical skill both Service C extract paths understand.
 * Token budget: 0 LLM.
 */
"use strict";

const FAILURE_THRESHOLD = parseInt(
  process.env.PRICEWATCH_FAILURE_THRESHOLD || "3",
  10
);

const VALID_METHODS = Object.freeze(["api", "dom", "plans"]);

/**
 * True if amount is a finite number usable as a current price.
 * null/undefined/NaN/empty string → invalid (never persist as snapshot).
 */
function isValidPriceAmount(amount) {
  if (amount === null || amount === undefined || amount === "") return false;
  const n = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(n);
}

function isValidSinglePrice(price) {
  if (!price || typeof price !== "object") return false;
  return isValidPriceAmount(price.amount);
}

function isValidPlans(plans) {
  if (!Array.isArray(plans) || plans.length === 0) return false;
  // At least one plan with a finite price OR an explicit custom/null enterprise row
  // is acceptable as a structured extract; empty names alone are not.
  return plans.some(
    (p) =>
      p &&
      typeof p.plan === "string" &&
      p.plan.trim().length > 0 &&
      (p.price === null || isValidPriceAmount(p.price) || p.price === 0)
  );
}

/**
 * Adapt lab or real-site skill JSON into one shape.
 */
function normalizeSkill(raw) {
  if (!raw || typeof raw !== "object") return null;

  const method = (raw.method || "dom").toLowerCase();
  const extractMode =
    raw.extract_mode ||
    (method === "plans" ? "plans" : raw.plan_key || raw.plan_name ? "single" : "single");

  // Lab DOM: selectors.{amount_attr,...}
  // Real DOM: selector (CSS note) + regex
  let selectors = raw.selectors || null;
  if (!selectors && raw.amount_attr) {
    selectors = {
      amount_attr: raw.amount_attr,
      currency_attr: raw.currency_attr || "data-currency",
      period_attr: raw.period_attr || "data-period",
    };
  }

  const normalize =
    raw.normalize ||
    (selectors
      ? {
          currency_field: selectors.currency_attr || "data-currency",
          period_field: selectors.period_attr || "data-period",
        }
      : raw.json_path
        ? { currency_field: "$.currency", period_field: "$.period" }
        : { currency_field: "currency", period_field: "period" });

  const failure_count =
    typeof raw.failure_count === "number" && Number.isFinite(raw.failure_count)
      ? raw.failure_count
      : 0;

  const skill_status =
    raw.skill_status ||
    (failure_count >= FAILURE_THRESHOLD ? "unhealthy" : "healthy");

  return {
    id: raw.id,
    version: raw.version || 1,
    created_at: raw.created_at || null,
    pricing_url: raw.pricing_url || raw.base_url || null,
    base_url: raw.base_url || null,
    target_price_description: raw.target_price_description || raw.target || null,
    site: raw.site || null,
    plan_name: raw.plan_name || null,
    plan_key: raw.plan_key || raw.plan_name || null,
    method: VALID_METHODS.includes(method) ? method : "dom",
    extract_mode: extractMode === "plans" || method === "plans" ? "plans" : "single",
    selectors,
    selector: raw.selector || null,
    regex: raw.regex || null,
    json_path: raw.json_path || null,
    normalize,
    failure_count,
    skill_status,
    confidence: raw.confidence != null ? raw.confidence : null,
    notes: raw.notes || null,
    initial_price: raw.initial_price || null,
    price: raw.price != null ? raw.price : null,
    currency: raw.currency || "USD",
    period: raw.period || "month",
    per_unit: raw.per_unit || raw.perUnit || null,
    discovery_step: raw.discovery_step != null ? raw.discovery_step : raw.step,
    // Preserve raw for callers that need original fields
    _raw: raw,
  };
}

function isPlansSkill(skill) {
  if (!skill) return false;
  const s = skill.extract_mode ? skill : normalizeSkill(skill);
  return s.method === "plans" || s.extract_mode === "plans";
}

/**
 * Build the canonical JSON object to persist (no _raw).
 */
function toPersistedSkill(skill) {
  const s = skill.extract_mode !== undefined && skill.failure_count !== undefined
    ? skill
    : normalizeSkill(skill);
  if (!s) return null;
  const out = {
    id: s.id,
    version: s.version,
    created_at: s.created_at || new Date().toISOString(),
    pricing_url: s.pricing_url,
    target_price_description: s.target_price_description,
    site: s.site,
    plan_name: s.plan_name,
    plan_key: s.plan_key,
    method: s.method,
    extract_mode: s.extract_mode,
    selectors: s.selectors,
    selector: s.selector,
    regex: s.regex,
    json_path: s.json_path,
    normalize: s.normalize,
    failure_count: s.failure_count,
    skill_status: s.skill_status,
    confidence: s.confidence,
    notes: s.notes,
    currency: s.currency,
    period: s.period,
    per_unit: s.per_unit,
  };
  if (s.base_url) out.base_url = s.base_url;
  if (s.initial_price) out.initial_price = s.initial_price;
  if (s.price != null) out.price = s.price;
  if (s.discovery_step != null) out.discovery_step = s.discovery_step;
  // Drop nulls that clutter files (keep failure_count always)
  for (const k of Object.keys(out)) {
    if (out[k] === null && k !== "failure_count" && k !== "plan_key" && k !== "plan_name") {
      // keep explicit nulls for optional extract hints only when useful — strip undefined-like
      if (["selector", "regex", "json_path", "selectors", "notes", "site", "base_url", "per_unit", "initial_price", "price", "confidence"].includes(k)) {
        delete out[k];
      }
    }
  }
  return out;
}

module.exports = {
  FAILURE_THRESHOLD,
  VALID_METHODS,
  normalizeSkill,
  isPlansSkill,
  isValidPriceAmount,
  isValidSinglePrice,
  isValidPlans,
  toPersistedSkill,
};
