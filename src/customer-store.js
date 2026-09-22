/**
 * Durable file-based customer + competitor store.
 * Stores under data/customers.json — survives process restart.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_FILE = path.join(__dirname, "..", "data", "customers.json");
const MAX_COMPETITORS = 10;

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

function createCustomer({ name, email }) {
  const store = loadStore();
  const id = generateId();
  store.customers[id] = {
    id,
    name: name || "Unnamed",
    email: email || null,
    check_interval: "daily",
    competitors: [],
    createdAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.customers[id];
}

function getCustomer(id) {
  const store = loadStore();
  return store.customers[id] || null;
}

function listCustomers() {
  const store = loadStore();
  return Object.values(store.customers);
}

function addCompetitor(customerId, { name, pricingUrl, targetPriceDescription }) {
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

function updateCompetitorStatus(customerId, competitorId, { status, skillPath }) {
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
};
