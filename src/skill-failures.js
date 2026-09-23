/**
 * Persist failure_count / skill_status on skill JSON files (F3).
 * 0 LLM.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {
  FAILURE_THRESHOLD,
  normalizeSkill,
  toPersistedSkill,
} = require("./skill-schema");
const rediscovery = require("./rediscovery-queue");

const SKILLS_DIR = path.resolve(__dirname, "..", "data", "skills");

function resolveSkillFile(skillId, skillPath) {
  if (skillPath) {
    const full = path.isAbsolute(skillPath)
      ? skillPath
      : path.resolve(__dirname, "..", skillPath);
    if (fs.existsSync(full)) return full;
  }
  if (skillId) {
    const byId = path.join(SKILLS_DIR, `${skillId}.json`);
    if (fs.existsSync(byId)) return byId;
    // Host-slug files: id may be "plausible-io-8e774063" while file is plausible-io.json
    if (fs.existsSync(SKILLS_DIR)) {
      for (const f of fs.readdirSync(SKILLS_DIR)) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
          if (raw.id === skillId) return path.join(SKILLS_DIR, f);
        } catch {
          /* skip */
        }
      }
    }
  }
  return null;
}

function readRaw(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeRaw(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Increment failure_count; at threshold mark unhealthy + enqueue rediscovery.
 * Returns { failure_count, skill_status, rediscoveryQueued }.
 */
function recordFailure(skillId, opts = {}) {
  const filePath = resolveSkillFile(skillId, opts.skillPath);
  let raw;
  if (filePath) {
    raw = readRaw(filePath);
  } else {
    raw = { id: skillId, failure_count: 0 };
  }

  const next = (typeof raw.failure_count === "number" ? raw.failure_count : 0) + 1;
  raw.failure_count = next;
  raw.skill_status = next >= FAILURE_THRESHOLD ? "unhealthy" : raw.skill_status || "healthy";

  // Ensure unified fields exist on write
  const normalized = normalizeSkill(raw);
  const persisted = toPersistedSkill({ ...normalized, ...raw, failure_count: next, skill_status: raw.skill_status });

  if (filePath) {
    writeRaw(filePath, { ...raw, ...persisted, failure_count: next, skill_status: raw.skill_status });
  }

  let rediscoveryQueued = false;
  if (next >= FAILURE_THRESHOLD) {
    const r = rediscovery.enqueue({
      skillId,
      skillPath: filePath
        ? path.relative(path.resolve(__dirname, ".."), filePath)
        : opts.skillPath || null,
      pricingUrl: raw.pricing_url || raw.base_url || opts.pricingUrl || null,
      target: raw.target_price_description || opts.target || null,
      reason: opts.reason || "failure_threshold",
    });
    rediscoveryQueued = r.created || !!r.job;
  }

  return {
    failure_count: next,
    skill_status: raw.skill_status,
    rediscoveryQueued,
    threshold: FAILURE_THRESHOLD,
    filePath,
  };
}

/**
 * Reset failure_count after a successful extract.
 */
function recordSuccess(skillId, opts = {}) {
  const filePath = resolveSkillFile(skillId, opts.skillPath);
  if (!filePath) return { failure_count: 0, skill_status: "healthy", filePath: null };

  const raw = readRaw(filePath);
  if ((raw.failure_count || 0) === 0 && raw.skill_status !== "unhealthy") {
    // Still ensure failure_count field exists on legacy lab skills
    if (raw.failure_count === undefined) {
      raw.failure_count = 0;
      raw.skill_status = "healthy";
      writeRaw(filePath, raw);
    }
    return { failure_count: 0, skill_status: "healthy", filePath };
  }

  raw.failure_count = 0;
  raw.skill_status = "healthy";
  writeRaw(filePath, raw);
  return { failure_count: 0, skill_status: "healthy", filePath };
}

module.exports = {
  recordFailure,
  recordSuccess,
  resolveSkillFile,
  FAILURE_THRESHOLD,
};
