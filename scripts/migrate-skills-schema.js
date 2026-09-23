#!/usr/bin/env node
"use strict";

/**
 * One-shot adapter/migration: rewrite data/skills/*.json to unified F3 schema.
 * Idempotent. 0 LLM.
 *
 * Usage: node scripts/migrate-skills-schema.js
 */

const fs = require("fs");
const path = require("path");
const { normalizeSkill, toPersistedSkill } = require("../src/skill-schema");

const SKILLS_DIR = path.resolve(__dirname, "..", "data", "skills");

function main() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log("[migrate-skills] no skills dir");
    return;
  }
  let updated = 0;
  let skipped = 0;
  for (const f of fs.readdirSync(SKILLS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const fp = path.join(SKILLS_DIR, f);
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    const normalized = normalizeSkill(raw);
    const persisted = toPersistedSkill(normalized);
    // Preserve fields migration might drop that are still useful
    if (raw.base_url) persisted.base_url = raw.base_url;
    if (raw.initial_price) persisted.initial_price = raw.initial_price;
    if (raw.discovery_step != null) persisted.discovery_step = raw.discovery_step;
    if (raw.step != null && persisted.discovery_step == null) persisted.discovery_step = raw.step;
    if (raw.price != null) persisted.price = raw.price;

    const before = JSON.stringify(raw);
    const after = JSON.stringify(persisted, null, 2) + "\n";
    if (before === JSON.stringify(JSON.parse(after))) {
      skipped++;
      continue;
    }
    fs.writeFileSync(fp, after);
    console.log(`  updated ${f}`);
    updated++;
  }
  console.log(`[migrate-skills] done: ${updated} updated, ${skipped} unchanged`);
}

main();
