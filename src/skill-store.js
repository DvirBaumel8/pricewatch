/**
 * Skill persistence — read / write JSON skills.
 *
 * Dual storage:
 *   • File: data/skills/<slug>.json  (lab, git-committed real-site skills)
 *   • Neon: skills table             (hosted/GHA — authoritative when DATABASE_URL set)
 *
 * saveSkill writes file always + Neon when pool exists.
 * loadSkillById tries file first, falls back to Neon.
 * listSkills merges file + Neon (Neon rows win on id collision).
 *
 * 0 LLM.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPool, query } = require("./db");

const SKILLS_DIR = path.join(__dirname, "..", "data", "skills");

function dbAvailable() {
  return !!getPool();
}

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

function buildSkillPayload(data) {
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
  return skill;
}

/**
 * Write skill to file always; when Neon pool exists, await Neon upsert
 * (payload + optional baseline) BEFORE returning so hosted intake
 * cannot race GHA loadSkillById / loadBaseline.
 */
async function saveSkill(data) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const fname = skillFilename(data.url || `https://${data.site}`, data.target || "");
  const fpath = path.join(SKILLS_DIR, fname);

  const skill = buildSkillPayload(data);

  fs.writeFileSync(fpath, JSON.stringify(skill, null, 2) + "\n");

  if (dbAvailable()) {
    await neonSaveSkill(skill, data.baseline || null);
  }

  return path.relative(path.join(__dirname, ".."), fpath);
}

/**
 * Resolve skill by id: Neon / exact filename first, then scan data/skills/*.json
 * (committed skills are often named by host, e.g. linear-app.json, not by id).
 */
async function resolveSkillById(id) {
  if (!id) return null;
  const direct = await loadSkillById(id);
  if (direct) return direct;
  const fromFiles = listSkills().find((s) => s && s.id === id);
  return fromFiles || null;
}

/** Single-price baseline shape expected by monitor-lib coerceSinglePreviousSnapshot. */
function baselineFromSkill(skill) {
  if (!skill || skill.price == null) return null;
  return {
    price: {
      amount: skill.price,
      currency: skill.currency || "USD",
      period: skill.period || "month",
    },
    skill_id: skill.id,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Ensure Neon has skill payload + baseline for a known skill id (catalog / host path).
 * No-op when DB unavailable. Returns true when Neon row written/updated.
 */
async function ensureSkillAndBaselineInNeon(skillId) {
  if (!dbAvailable() || !skillId) return false;
  const skill = await resolveSkillById(skillId);
  if (!skill) {
    console.error(`[skill-store] ensureSkillAndBaselineInNeon: skill ${skillId} not found locally or in Neon`);
    return false;
  }
  let baseline = null;
  try {
    baseline = await loadBaseline(skillId);
  } catch { /* first write */ }
  if (!baseline) baseline = baselineFromSkill(skill);
  await neonSaveSkill(skill, baseline);
  return true;
}

/**
 * Persist a skill to Neon only (no file write). Used by neonSaveSkill.
 */
async function neonSaveSkill(skill, baseline) {
  if (!dbAvailable()) return;
  const site = skill.site || null;
  await query(
    `INSERT INTO skills (id, site, payload, baseline)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       payload = EXCLUDED.payload,
       baseline = COALESCE(EXCLUDED.baseline, skills.baseline),
       updated_at = now()`,
    [skill.id, site, JSON.stringify(skill), baseline ? JSON.stringify(baseline) : null]
  );
}

/**
 * Load a skill by its id. File first, then Neon fallback.
 */
async function loadSkillById(skillId) {
  const fpath = path.join(SKILLS_DIR, `${skillId}.json`);
  if (fs.existsSync(fpath)) {
    try {
      return JSON.parse(fs.readFileSync(fpath, "utf8"));
    } catch { /* fall through to Neon */ }
  }

  if (dbAvailable()) {
    try {
      const res = await query("SELECT payload FROM skills WHERE id = $1", [skillId]);
      if (res.rows.length > 0) {
        const payload = res.rows[0].payload;
        return typeof payload === "string" ? JSON.parse(payload) : payload;
      }
    } catch (err) {
      console.error(`[skill-store] Neon load failed for ${skillId}: ${err.message}`);
    }
  }

  return null;
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
  const byId = new Map();

  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const skill = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
        if (skill && skill.id) byId.set(skill.id, skill);
      } catch { /* skip bad files */ }
    }
  }

  return Array.from(byId.values());
}

/**
 * List skills from Neon. Merges with file skills (Neon wins on collision).
 */
async function listSkillsWithNeon() {
  const byId = new Map();

  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const skill = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
        if (skill && skill.id) byId.set(skill.id, skill);
      } catch { /* skip bad files */ }
    }
  }

  if (dbAvailable()) {
    try {
      const res = await query("SELECT payload FROM skills ORDER BY created_at ASC");
      for (const row of res.rows) {
        const skill = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        if (skill && skill.id) byId.set(skill.id, skill);
      }
    } catch (err) {
      console.error(`[skill-store] Neon listSkills failed: ${err.message}`);
    }
  }

  return Array.from(byId.values());
}

/**
 * Load skills.baseline from Neon (hosted previous snapshot for compare).
 * Returns parsed JSON or null when absent / DB unavailable.
 */
async function loadBaseline(skillId) {
  if (!dbAvailable()) return null;
  try {
    const res = await query("SELECT baseline FROM skills WHERE id = $1", [skillId]);
    if (res.rows.length === 0) return null;
    const baseline = res.rows[0].baseline;
    if (baseline == null) return null;
    return typeof baseline === "string" ? JSON.parse(baseline) : baseline;
  } catch (err) {
    console.error(`[skill-store] Neon baseline load failed for ${skillId}: ${err.message}`);
    return null;
  }
}

/**
 * Persist skills.baseline to Neon (overwrite). Used after successful extract.
 * No-op when DB unavailable or skill row missing.
 */
async function saveBaseline(skillId, baseline) {
  if (!dbAvailable() || baseline == null) return false;
  try {
    const res = await query(
      `UPDATE skills
       SET baseline = $2::jsonb, updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [skillId, JSON.stringify(baseline)]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error(`[skill-store] Neon baseline save failed for ${skillId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  saveSkill,
  neonSaveSkill,
  loadSkill,
  loadSkillById,
  loadBaseline,
  saveBaseline,
  listSkills,
  listSkillsWithNeon,
  resolveSkillById,
  baselineFromSkill,
  ensureSkillAndBaselineInNeon,
  buildSkillPayload,
  skillId,
  dbAvailable,
  SKILLS_DIR,
};
