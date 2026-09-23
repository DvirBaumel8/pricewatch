/**
 * Customer + competitor store.
 *
 * When a Neon pool exists (DATABASE_URL / DATABASE_URL_NODE), Neon is
 * authoritative for customers and WatchTargets. File JSON
 * (data/customers.json) remains as dual-write / lab fallback when no pool.
 *
 * Competitors map 1:1 to WatchTarget rows with surface=b2b
 * (see docs/watch-target.md and src/watch-target-store.js).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { query, getPool } = require("./db");
const watchTargets = require("./watch-target-store");

const STORE_FILE = path.join(__dirname, "..", "data", "customers.json");
const MAX_COMPETITORS = watchTargets.MAX_WATCH_TARGETS;

function dbAvailable() {
  return !!getPool();
}

function ensureDir() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
}

function loadStore() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return { customers: {} };
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return { customers: {} };
  }
}

function saveStore(store) {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
}

function generateId() {
  return crypto.randomBytes(6).toString("hex");
}

function fileCreateCustomer({ name, email, id }) {
  const store = loadStore();
  const cid = id || generateId();
  store.customers[cid] = {
    id: cid,
    name: name || "Unnamed",
    email: email || null,
    check_interval: "daily",
    competitors: [],
    createdAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.customers[cid];
}

async function neonUpsertCustomer({ id, name, email }) {
  const cid = id || generateId();
  await query(
    `INSERT INTO customers (id, name, email, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       email = COALESCE(EXCLUDED.email, customers.email)
     RETURNING *`,
    [cid, name || "Unnamed", email || null]
  );
  return { id: cid, name: name || "Unnamed", email: email || null };
}

/**
 * Create customer. Neon authoritative when pool exists; always dual-writes file
 * so lab/Service B file readers keep working until fully migrated.
 */
async function createCustomer({ name, email }) {
  const id = generateId();
  if (dbAvailable()) {
    await neonUpsertCustomer({ id, name, email });
  }
  const fileCustomer = fileCreateCustomer({ name, email, id });
  return fileCustomer;
}

async function neonGetCustomer(id) {
  const res = await query("SELECT * FROM customers WHERE id = $1", [id]);
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  const wts = await watchTargets.listByCustomer(id);
  const competitors = wts
    .filter((w) => w.surface === "b2b")
    .map(watchTargets.toCompetitorShape);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    check_interval: "daily",
    competitors,
    watch_targets: wts,
    createdAt: row.created_at,
  };
}

async function getCustomer(id) {
  if (dbAvailable()) {
    const fromDb = await neonGetCustomer(id);
    if (fromDb) return fromDb;
    // Fall through to file if Neon miss (pre-migration rows)
  }
  const store = loadStore();
  return store.customers[id] || null;
}

async function listCustomers() {
  if (dbAvailable()) {
    const res = await query("SELECT * FROM customers ORDER BY created_at ASC");
    const out = [];
    for (const row of res.rows) {
      const wts = await watchTargets.listByCustomer(row.id);
      out.push({
        id: row.id,
        name: row.name,
        email: row.email,
        check_interval: "daily",
        competitors: wts
          .filter((w) => w.surface === "b2b")
          .map(watchTargets.toCompetitorShape),
        watch_targets: wts,
        createdAt: row.created_at,
      });
    }
    if (out.length > 0) return out;
  }
  const store = loadStore();
  return Object.values(store.customers);
}

/**
 * Add competitor — shim: writes WatchTarget surface=b2b when Neon available.
 * Dual-writes file for lab fallback.
 */
async function addCompetitor(
  customerId,
  { name, pricingUrl, targetPriceDescription }
) {
  if (dbAvailable()) {
    const custRes = await query("SELECT id FROM customers WHERE id = $1", [
      customerId,
    ]);
    if (!custRes.rows[0]) {
      // Try file → upsert into Neon so shim works for file-only customers
      const store = loadStore();
      const fileCust = store.customers[customerId];
      if (!fileCust) return { error: "customer_not_found" };
      await neonUpsertCustomer({
        id: fileCust.id,
        name: fileCust.name,
        email: fileCust.email,
      });
    }

    const created = await watchTargets.create({
      customer_id: customerId,
      surface: "b2b",
      label: name || "Unknown",
      source_url: pricingUrl == null ? "" : String(pricingUrl),
      target_description: targetPriceDescription,
    });
    if (created.error) {
      return {
        error: "max_competitors_reached",
        limit: created.limit || MAX_COMPETITORS,
      };
    }

    const competitor = watchTargets.toCompetitorShape(created.watchTarget);

    // Dual-write file
    const store = loadStore();
    if (!store.customers[customerId]) {
      store.customers[customerId] = {
        id: customerId,
        name: "Unnamed",
        email: null,
        check_interval: "daily",
        competitors: [],
        createdAt: new Date().toISOString(),
      };
    }
    store.customers[customerId].competitors.push(competitor);
    saveStore(store);

    const customer = await getCustomer(customerId);
    return { competitor, customer, watchTarget: created.watchTarget };
  }

  // File-only lab path
  const store = loadStore();
  const customer = store.customers[customerId];
  if (!customer) return { error: "customer_not_found" };
  if (customer.competitors.length >= MAX_COMPETITORS) {
    return { error: "max_competitors_reached", limit: MAX_COMPETITORS };
  }

  const compId = generateId();
  const competitor = {
    id: compId,
    name: name || "Unknown",
    pricingUrl: pricingUrl || null,
    targetPriceDescription,
    status: "pending_onboarding",
    skillPath: null,
    addedAt: new Date().toISOString(),
  };

  customer.competitors.push(competitor);
  saveStore(store);
  return { competitor, customer };
}

/**
 * Update competitor / WatchTarget status (Service B).
 * Neon authoritative when pool exists; always updates file when present.
 */
async function updateCompetitorStatus(
  customerId,
  competitorId,
  { status, skillPath }
) {
  if (dbAvailable()) {
    const skill_id =
      skillPath !== undefined
        ? watchTargets.skillIdFromPath(skillPath)
        : undefined;
    const updated = await watchTargets.updateStatus(competitorId, {
      status,
      skill_id,
    });
    // Also patch file if present
    const store = loadStore();
    const customer = store.customers[customerId];
    if (customer) {
      const comp = customer.competitors.find((c) => c.id === competitorId);
      if (comp) {
        if (status) comp.status = status;
        if (skillPath) comp.skillPath = skillPath;
        saveStore(store);
      }
    }
    return updated ? watchTargets.toCompetitorShape(updated) : null;
  }

  const store = loadStore();
  const customer = store.customers[customerId];
  if (!customer) return null;
  const comp = customer.competitors.find((c) => c.id === competitorId);
  if (!comp) return null;
  comp.status = status;
  if (skillPath) comp.skillPath = skillPath;
  saveStore(store);
  return comp;
}

module.exports = {
  createCustomer,
  getCustomer,
  listCustomers,
  addCompetitor,
  updateCompetitorStatus,
  MAX_COMPETITORS,
  STORE_FILE,
  dbAvailable,
  neonUpsertCustomer,
};
