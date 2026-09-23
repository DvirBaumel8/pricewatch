/**
 * Skill persistence — read / write JSON skills under data/skills/.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SKILLS_DIR = path.join(__dirname, "..", "data", "skills");

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function skillId(url, target) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const hash = crypto.createHash("sha256").update(url + "|" + target).digest("hex").slice(0, 8);
  return `${slugify(host)}-${hash}`;
}

function skillFilename(url, target) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return `${slugify(host)}.json`;
}

function saveSkill(data) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const fname = skillFilename(data.url || `https://${data.site}`, data.target || "");
  const fpath = path.join(SKILLS_DIR, fname);

  const method = data.method || "dom";
  const skill = {
    id: skillId(data.url || `https://${data.site}`, data.target || ""),
    version: 1,
    created_at: new Date().toISOString(),
    pricing_url: data.url,
    target_price_description: data.target,
    site: data.site,
    plan_name: data.planName || data.plan_name || null,
    plan_key: data.planKey || data.plan_key || data.planName || null,
    method,
    extract_mode: data.extract_mode || (method === "plans" ? "plans" : "single"),
    step: data.step,
    price: data.price,
    currency: data.currency || "USD",
    period: data.period || "month",
    per_unit: data.perUnit || null,
    selectors: data.selectors || null,
    selector: data.selector || null,
    regex: data.regex || null,
    json_path: data.jsonPath || null,
    normalize: data.normalize || null,
    confidence: data.confidence || "medium",
    failure_count: 0,
    skill_status: "healthy",
    notes: data.notes || null,
  };
  if (!skill.normalize) {
    skill.normalize = skill.selectors
      ? {
          currency_field: skill.selectors.currency_attr || "data-currency",
          period_field: skill.selectors.period_attr || "data-period",
        }
      : { currency_field: "currency", period_field: "period" };
  }

  fs.writeFileSync(fpath, JSON.stringify(skill, null, 2) + "\n");
  return path.relative(path.join(__dirname, ".."), fpath);
}

function loadSkill(url, target) {
  const fname = skillFilename(url, target);
  const fpath = path.join(SKILLS_DIR, fname);
  if (!fs.existsSync(fpath)) return null;
  try {
    return JSON.parse(fs.readFileSync(fpath, "utf8"));
  } catch {
    return null;
  }
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8")));
}

module.exports = { saveSkill, loadSkill, listSkills, skillId, SKILLS_DIR };
