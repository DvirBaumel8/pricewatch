#!/usr/bin/env node
"use strict";

/**
 * Generate sample outbox emails for CEO review — W2 evidence.
 * Simulates Vercel Pro +$5 and Linear Basic +$2 changes, writes to outbox/samples/.
 */

const fs = require("fs");
const path = require("path");
const { writePlanLadderEmail } = require("../src/plan-ladder-email");
const { diffPlanLadders } = require("../src/plan-ladder-diff");

const SAMPLES_DIR = path.resolve(__dirname, "..", "outbox", "samples");
fs.mkdirSync(SAMPLES_DIR, { recursive: true });

const customerInfo = {
  customerId: "ceo-demo",
  customerEmail: "dvirbaumel9@gmail.com",
  customerName: "Dvir",
};

const scenarios = [
  {
    name: "vercel-pro-price-bump",
    site: "vercel.com",
    pricingUrl: "https://vercel.com/pricing",
    oldPlans: [
      { plan: "Hobby", price: 0, currency: "USD", unit: null, billing: "free" },
      { plan: "Pro", price: 20, currency: "USD", unit: "developer seat", billing: "monthly" },
      { plan: "Enterprise", price: null, currency: "USD", unit: null, billing: "custom" },
    ],
    newPlans: [
      { plan: "Hobby", price: 0, currency: "USD", unit: null, billing: "free" },
      { plan: "Pro", price: 25, currency: "USD", unit: "developer seat", billing: "monthly" },
      { plan: "Enterprise", price: null, currency: "USD", unit: null, billing: "custom" },
    ],
  },
  {
    name: "linear-basic-price-bump",
    site: "linear.app",
    pricingUrl: "https://linear.app/pricing",
    oldPlans: [
      { plan: "Free", price: 0, currency: "USD", unit: "user", billing: "free" },
      { plan: "Basic", price: 10, currency: "USD", unit: "user", billing: "monthly" },
      { plan: "Enterprise", price: null, currency: "USD", unit: "user", billing: "custom" },
    ],
    newPlans: [
      { plan: "Free", price: 0, currency: "USD", unit: "user", billing: "free" },
      { plan: "Basic", price: 12, currency: "USD", unit: "user", billing: "monthly" },
      { plan: "Enterprise", price: null, currency: "USD", unit: "user", billing: "custom" },
    ],
  },
  {
    name: "notion-new-plan-added",
    site: "notion.com",
    pricingUrl: "https://www.notion.com/pricing",
    oldPlans: [
      { plan: "Free", price: 0, currency: "USD", unit: null, billing: "free" },
      { plan: "Plus", price: 10, currency: "USD", unit: "member", billing: "monthly" },
      { plan: "Enterprise", price: null, currency: "USD", unit: "member", billing: "custom" },
    ],
    newPlans: [
      { plan: "Free", price: 0, currency: "USD", unit: null, billing: "free" },
      { plan: "Plus", price: 10, currency: "USD", unit: "member", billing: "monthly" },
      { plan: "Business", price: 20, currency: "USD", unit: "member", billing: "monthly" },
      { plan: "Enterprise", price: null, currency: "USD", unit: "member", billing: "custom" },
    ],
  },
];

for (const s of scenarios) {
  const { changes, hasSignal } = diffPlanLadders(s.oldPlans, s.newPlans);
  if (!hasSignal) {
    console.log(`[skip] ${s.name}: no signal`);
    continue;
  }
  const emailPath = writePlanLadderEmail(s.site, s.pricingUrl, changes, customerInfo);
  const email = JSON.parse(fs.readFileSync(emailPath, "utf8"));

  const samplePath = path.join(SAMPLES_DIR, `${s.name}.json`);
  fs.writeFileSync(samplePath, JSON.stringify(email, null, 2) + "\n");

  fs.unlinkSync(emailPath);
  console.log(`[sample] ${s.name} → ${samplePath}`);
  console.log(`  Subject: ${email.subject}`);
  console.log(`  Signal: ${changes.length} change(s)`);
  console.log();
}

console.log("Sample emails written to outbox/samples/");
