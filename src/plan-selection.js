/**
 * Plan-selection store — persist which plan(s) a customer chose to watch.
 *
 * After ladder extraction, the customer PICKS rows from the ladder
 * (not free-text jargon). Selections stored under data/watched/<site>.json.
 *
 * saveSelection(site, { plans, mode }) → filePath
 * loadSelection(site) → selection | null
 *
 * mode: "all_paid" | "selected"
 * plans: array of plan names the customer chose to watch
 */
"use strict";

const fs = require("fs");
const path = require("path");

const WATCHED_DIR = path.resolve(__dirname, "..", "data", "watched");

function saveSelection(site, selection) {
  fs.mkdirSync(WATCHED_DIR, { recursive: true });
  const data = {
    site,
    mode: selection.mode || "selected",
    plans: selection.plans || [],
    selected_at: new Date().toISOString(),
  };
  const filePath = path.join(WATCHED_DIR, `${site.replace(/\./g, "-")}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  return filePath;
}

function loadSelection(site) {
  const filePath = path.join(WATCHED_DIR, `${site.replace(/\./g, "-")}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isWatched(site, planName) {
  const sel = loadSelection(site);
  if (!sel) return true;
  if (sel.mode === "all_paid") return true;
  return sel.plans.some(
    (p) => p.toLowerCase() === planName.toLowerCase()
  );
}

function listWatched() {
  if (!fs.existsSync(WATCHED_DIR)) return [];
  return fs
    .readdirSync(WATCHED_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(WATCHED_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { saveSelection, loadSelection, isWatched, listWatched, WATCHED_DIR };
