/**
 * Step 0 — reuse an existing skill if one matches the URL+target.
 */
const { loadSkill } = require("../skill-store");

async function runStep0({ url, target }) {
  const skill = loadSkill(url, target);
  if (!skill) return null;
  return {
    price: skill.price,
    currency: skill.currency,
    period: skill.period,
    perUnit: skill.perUnit,
    method: skill.method,
    selector: skill.selector,
    regex: skill.regex,
    site: skill.site,
    planName: skill.planName,
    confidence: skill.confidence,
    notes: "reused existing skill",
  };
}

module.exports = { runStep0 };
