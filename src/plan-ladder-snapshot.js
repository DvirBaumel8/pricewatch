/**
 * Plan-ladder snapshot store — structured {plan, price, currency, unit, billing}
 * snapshots under data/snapshots/ladder/<site>.json.
 *
 * saveLadderSnapshot(site, plans) → filePath
 * loadLadderSnapshot(site) → snapshot | null
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LADDER_DIR = path.resolve(__dirname, "..", "data", "snapshots", "ladder");

function saveLadderSnapshot(site, plans) {
  fs.mkdirSync(LADDER_DIR, { recursive: true });
  const snapshot = {
    site,
    checked_at: new Date().toISOString(),
    plans,
  };
  const filePath = path.join(LADDER_DIR, `${site.replace(/\./g, "-")}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + "\n");
  return filePath;
}

function loadLadderSnapshot(site) {
  const filePath = path.join(LADDER_DIR, `${site.replace(/\./g, "-")}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

module.exports = { saveLadderSnapshot, loadLadderSnapshot, LADDER_DIR };
